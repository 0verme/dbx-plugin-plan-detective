import { PlanInputError, PlanParseError } from "../errors.js";
import { validateRawPlanInput } from "../raw-plan-input.js";

/**
 * MySQL `EXPLAIN FORMAT=JSON` parser.
 *
 * Pipeline position:
 *
 *     RawPlanInput --(this parser)--> ParsedPlan --(normalizer)--> NormalizedPlan
 *
 * Contract source (upstream, `t8y2/dbx/main`):
 * - `crates/dbx-sql/src/query_execution_sql.rs`: `build_explain_sql` generates
 *   `EXPLAIN FORMAT=JSON <sql>` for MySQL unless the caller explicitly asks for
 *   `FORMAT=TRADITIONAL`; `estimated_plan_format(Mysql) == Json`.
 * - `crates/dbx-core/src/query/plugin_plan.rs`: the plugin Host API always asks
 *   for `ExplainFormat::Json`, never sets `analyze`, and hands the parsed JSON
 *   parsed JSON payload to the plugin unchanged.
 * - `apps/desktop/src/lib/diagram/explainPlan.ts`: DBX's own MySQL JSON consumer
 *   (`query_block` / `nested_loop` / `table` / `ordering_operation` /
 *   `grouping_operation` / `duplicates_removal` / `union_result` /
 *   `materialized_from_subquery` / `cost_info`), used here as a second
 *   independent description of the shape.
 *
 * The parser maps the MySQL structure onto typed fields, keeps every property
 * it does not map verbatim in `extra`, and never invents a value:
 *
 * - `rows_examined_per_scan` / `rows_produced_per_join` are numbers in the MySQL
 *   payload; a string there is malformed input, not a value to coerce.
 * - `filtered` and every `cost_info` value are numeric strings in the MySQL
 *   payload; they are parsed strictly and a non-numeric string is malformed.
 * - costs stay in `mysql.*` and are never mapped onto PostgreSQL-style cost
 *   fields (the normalizer explains why).
 *
 * A structurally unusable payload throws `PlanParseError`; an unknown access
 * type or an unknown structural key is preserved (`nodeType` keeps the raw
 * access type, unknown keys land in `extra`) instead of being silently dropped.
 * Every structure MySQL reports `message` on keeps it in `mysql.message`; the
 * field is not dropped just because it is rare.
 */

/**
 * MySQL `access_type` -> stable Plan Detective node label.
 *
 * The labels are MySQL vocabulary on purpose. They must not pretend to be
 * PostgreSQL node types; the database-neutral semantic lives in the normalizer
 * (`kind`). An access type this map does not know keeps its raw value as the
 * node type so it is visible in the tree and recorded in `unknownNodeTypes`.
 */
const ACCESS_TYPE_NODE_TYPE = Object.freeze({
  ALL: "Table Scan",
  index: "Full Index Scan",
  range: "Index Range Scan",
  ref: "Index Lookup",
  eq_ref: "Unique Index Lookup",
  ref_or_null: "Index Lookup Or Null",
  fulltext: "Fulltext Lookup",
  index_merge: "Index Merge",
  unique_subquery: "Unique Subquery Lookup",
  index_subquery: "Index Subquery Lookup",
  const: "Const Row Lookup",
  system: "System Row Lookup",
});

/** Structural key -> stable node label. `table` / `nested_loop` are built separately. */
const STRUCTURE_NODE_TYPE = Object.freeze({
  query_block: "Query Block",
  ordering_operation: "Ordering Operation",
  grouping_operation: "Grouping Operation",
  duplicates_removal: "Duplicates Removal",
  union_result: "Union Result",
  unary_result: "Unary Result",
  intersect_result: "Intersect Result",
  except_result: "Except Result",
  materialized_from_subquery: "Materialized Subquery",
});

/** Set-operation containers share one shape (`query_specifications`). */
const SET_OPERATION_KEYS = Object.freeze(["union_result", "unary_result", "intersect_result", "except_result"]);

/** Wrapper keys that only wrap another operation (single child). */
const OPERATION_CONTAINER_KEYS = Object.freeze(["ordering_operation", "grouping_operation", "duplicates_removal"]);

/**
 * Subquery arrays observed in MySQL `EXPLAIN FORMAT=JSON`. Every entry has the
 * shape `{ dependent, cacheable, query_block }`; the raw key is kept as the
 * node's `structure` so the origin is visible.
 */
const SUBQUERY_ARRAY_KEYS = Object.freeze([
  "attached_subqueries",
  "optimized_away_subqueries",
  "group_by_subqueries",
  "having_subqueries",
  "order_by_subqueries",
  "select_list_subqueries",
]);

const COST_KEYS = Object.freeze([
  "query_cost",
  "read_cost",
  "eval_cost",
  "prefix_cost",
  "data_read_per_join",
  "sort_cost",
]);

const TABLE_FIELD_KEYS = Object.freeze([
  "table_name",
  "access_type",
  "key",
  "possible_keys",
  "used_key_parts",
  "used_columns",
  "key_length",
  "ref",
  "rows_examined_per_scan",
  "rows_produced_per_join",
  "filtered",
  "using_index",
  "using_index_for_group_by",
  "using_join_buffer",
  "first_match",
  "attached_condition",
  "index_condition",
]);

const COMMON_BLOCK_KEYS = Object.freeze([
  "select_id",
  "message",
  "cost_info",
  "table",
  "nested_loop",
  "query_specifications",
  "materialized_from_subquery",
  ...OPERATION_CONTAINER_KEYS,
  ...SET_OPERATION_KEYS,
  ...SUBQUERY_ARRAY_KEYS,
]);

const OPERATION_KEYS = Object.freeze(["using_temporary_table", "using_filesort"]);

const SET_OPERATION_FIELD_KEYS = Object.freeze([
  "using_temporary_table",
  "using_filesort",
  "select_id",
  "table_name",
  "access_type",
  "rows_examined_per_scan",
]);

const SUBQUERY_ENTRY_KEYS = Object.freeze(["dependent", "cacheable", "query_block"]);

/**
 * @typedef {Object} ParsedMySqlNode
 * @property {string} structure raw structural key ("query_block", "table", "nested_loop", ...)
 * @property {string} nodeType stable label; the raw access type for unknown access types
 * @property {string|null} relationName `table_name`
 * @property {string|null} indexName `key`
 * @property {number|null} estimatedRows rows examined per scan (table) or produced rows (join node)
 * @property {string|null} filter `attached_condition`
 * @property {string|null} indexCondition `index_condition` when the server reports it
 * @property {ParsedMySqlNode[]} children
 * @property {Record<string, unknown>} mysql raw MySQL-specific values, typed
 * @property {Record<string, unknown>} extra native keys the parser does not map
 *
 * @typedef {Object} ParsedPlan
 * @property {"mysql"} database
 * @property {"json"} format
 * @property {"estimated"} mode
 * @property {ParsedMySqlNode} root
 */

/**
 * Parse a MySQL `EXPLAIN FORMAT=JSON` payload.
 *
 * @param {unknown} input a RawPlanInput
 * @returns {ParsedPlan}
 * @throws {PlanInputError} when the RawPlanInput contract is not satisfied
 * @throws {PlanParseError} when the payload is malformed or contradicts `mode`
 */
export function parseMySqlJsonPlan(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }

  // Contract validation guarantees database "mysql" and format "json".
  const { mode, plan } = /** @type {import("../raw-plan-input.js").RawPlanInput} */ (input);

  if (mode !== "estimated") {
    throw new PlanParseError(
      "MODE_MISMATCH",
      'MySQL structured parsing only supports estimated plans. EXPLAIN ANALYZE returns a TREE listing, not this JSON payload; declare mode "estimated".',
    );
  }

  const root = parseQueryBlock(readTopLevelBlock(plan), "query_block");

  return { database: "mysql", format: "json", mode: "estimated", root };
}

/**
 * Verify the MySQL JSON envelope: the payload must expose a `query_block`
 * object. Anything else is not a MySQL FORMAT=JSON plan and must not be
 * half-parsed into an empty tree.
 *
 * @param {unknown} plan
 * @returns {Record<string, unknown>}
 */
function readTopLevelBlock(plan) {
  if (!isPlainObject(plan)) {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `MySQL EXPLAIN FORMAT=JSON returns a JSON object with a "query_block" property; got ${describeValue(plan)}.`,
    );
  }
  if (!Object.hasOwn(plan, "query_block")) {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      'plan must be the object returned by MySQL EXPLAIN FORMAT=JSON and expose a "query_block" property.',
    );
  }
  return requireObject(plan.query_block, "plan.query_block");
}

/**
 * @param {unknown} raw
 * @param {string} path
 * @returns {ParsedMySqlNode}
 */
function parseQueryBlock(raw, path) {
  const block = requireObject(raw, path);
  const node = emptyNode("query_block", STRUCTURE_NODE_TYPE.query_block);
  node.mysql.selectId = optionalNumber(block, "select_id", path);
  node.mysql.message = optionalString(block, "message", path);
  node.extra = collectExtra(block, [...COMMON_BLOCK_KEYS]);
  applyCostInfo(node, block.cost_info, path);
  node.children = parseChildren(block, path);
  return node;
}

/**
 * Parse every child structure a block can carry. MySQL emits at most one of
 * `table` / `nested_loop` / one operation container, but the order below is
 * fixed so the resulting tree is deterministic even for a payload that carries
 * more than one.
 *
 * @param {Record<string, unknown>} block
 * @param {string} path
 * @returns {ParsedMySqlNode[]}
 */
function parseChildren(block, path) {
  /** @type {ParsedMySqlNode[]} */
  const children = [];

  if (Object.hasOwn(block, "table")) children.push(parseTable(block.table, `${path}.table`));
  if (Object.hasOwn(block, "nested_loop")) {
    children.push(parseNestedLoop(block.nested_loop, `${path}.nested_loop`));
  }

  for (const key of OPERATION_CONTAINER_KEYS) {
    if (!Object.hasOwn(block, key)) continue;
    children.push(parseOperationContainer(block[key], key, `${path}.${key}`));
  }

  for (const key of SET_OPERATION_KEYS) {
    if (!Object.hasOwn(block, key)) continue;
    children.push(parseSetOperation(block[key], key, `${path}.${key}`));
  }

  if (Object.hasOwn(block, "materialized_from_subquery")) {
    children.push(parseMaterializedSubquery(block.materialized_from_subquery, `${path}.materialized_from_subquery`));
  }

  for (const key of SUBQUERY_ARRAY_KEYS) {
    if (!Object.hasOwn(block, key)) continue;
    children.push(...parseSubqueryArray(block[key], key, `${path}.${key}`));
  }

  return children;
}

/**
 * `table_name` / `access_type` / index and row estimates / condition for one
 * table access. `estimatedRows` is `rows_examined_per_scan` on purpose: it is
 * the row count of one access to this table (per outer row for an inner table
 * of a nested loop), which is what the neutral IR and the nested-loop rule
 * expect. `rows_produced_per_join` is cumulative over the join prefix, so it
 * stays in `mysql.*` and is used as a join node's estimate instead.
 *
 * @param {unknown} raw
 * @param {string} path
 * @returns {ParsedMySqlNode}
 */
function parseTable(raw, path) {
  const table = requireObject(raw, path);
  const accessType = optionalString(table, "access_type", path);
  const knownNodeType = accessType === null ? undefined : ACCESS_TYPE_NODE_TYPE[accessType];
  const node = emptyNode("table", knownNodeType ?? (accessType !== null && accessType.length > 0 ? accessType : "Table Access"));

  node.relationName = optionalString(table, "table_name", path);
  node.indexName = optionalString(table, "key", path);
  node.estimatedRows = optionalNumber(table, "rows_examined_per_scan", path);
  node.filter = optionalString(table, "attached_condition", path);
  node.indexCondition = optionalString(table, "index_condition", path);

  node.mysql.accessType = accessType;
  node.mysql.message = optionalString(table, "message", path);
  node.mysql.possibleKeys = optionalStringList(table, "possible_keys", path);
  node.mysql.usedKeyParts = optionalStringList(table, "used_key_parts", path);
  node.mysql.usedColumns = optionalStringList(table, "used_columns", path);
  node.mysql.keyLength = optionalKeyLength(table, "key_length", path);
  node.mysql.ref = optionalRawList(table, "ref", path);
  node.mysql.rowsExaminedPerScan = node.estimatedRows;
  node.mysql.rowsProducedPerJoin = optionalNumber(table, "rows_produced_per_join", path);
  node.mysql.filteredPercent = optionalPercentage(table, "filtered", path);
  node.mysql.usingIndex = optionalFlag(table, "using_index", path);
  node.mysql.usingIndexForGroupBy = optionalFlag(table, "using_index_for_group_by", path);
  node.mysql.usingJoinBuffer = optionalString(table, "using_join_buffer", path);
  node.mysql.firstMatch = optionalString(table, "first_match", path);
  node.extra = collectExtra(table, [...COMMON_BLOCK_KEYS, ...TABLE_FIELD_KEYS]);
  applyCostInfo(node, table.cost_info, path);

  node.children = parseNestedChildren(table, path);
  return node;
}

/**
 * A table can own a materialized subquery and attached scalar subqueries; those
 * are the only child structures MySQL nests below a table.
 *
 * @param {Record<string, unknown>} table
 * @param {string} path
 * @returns {ParsedMySqlNode[]}
 */
function parseNestedChildren(table, path) {
  /** @type {ParsedMySqlNode[]} */
  const children = [];

  if (Object.hasOwn(table, "materialized_from_subquery")) {
    children.push(parseMaterializedSubquery(table.materialized_from_subquery, `${path}.materialized_from_subquery`));
  }
  for (const key of SUBQUERY_ARRAY_KEYS) {
    if (!Object.hasOwn(table, key)) continue;
    children.push(...parseSubqueryArray(table[key], key, `${path}.${key}`));
  }
  return children;
}

/**
 * MySQL reports a join as a flat, join-ordered array:
 *
 *     "nested_loop": [ { "table": A }, { "table": B }, { "table": C } ]
 *
 * A nested loop is a chain, not a star: `A` is the outer side for each scan of
 * `B`, and the `A ⋈ B` prefix is the outer side for each scan of `C`. The array
 * is therefore folded into a left-deep binary tree so the existing
 * `nested-loop-large-inner` rule (outer = `children[0]`, inner = `children[1]`)
 * sees the real semantics:
 *
 *     Nested Loop( Nested Loop(A, B), C )
 *
 * The join node's `estimatedRows` is the inner table's
 * `rows_produced_per_join`, which MySQL defines as the row count produced by
 * the join prefix up to and including that table.
 *
 * @param {unknown} raw
 * @param {string} path
 * @returns {ParsedMySqlNode}
 */
function parseNestedLoop(raw, path) {
  if (!Array.isArray(raw)) {
    throw malformedNode(path, `"nested_loop" must be an array; got ${describeValue(raw)}.`);
  }
  if (raw.length === 0) {
    throw malformedNode(path, '"nested_loop" must contain at least one join element.');
  }

  const nodes = raw.map((entry, index) => parseNestedLoopEntry(entry, `${path}[${index}]`));

  let current = nodes[0];
  for (let index = 1; index < nodes.length; index += 1) {
    const inner = nodes[index];
    const join = emptyNode("nested_loop", "Nested Loop");
    join.estimatedRows = inner.mysql.rowsProducedPerJoin;
    join.children = [current, inner];
    current = join;
  }
  return current;
}

/**
 * @param {unknown} entry
 * @param {string} path
 * @returns {ParsedMySqlNode}
 */
function parseNestedLoopEntry(entry, path) {
  if (!isPlainObject(entry)) {
    throw malformedNode(path, `every "nested_loop" element must be an object; got ${describeValue(entry)}.`);
  }
  if (Object.hasOwn(entry, "table")) {
    const node = parseTable(entry.table, `${path}.table`);
    return preserveWrapperExtras(node, entry, ["table"], "nested_loop_entry");
  }

  // Defensive: DBX's own consumer also accepts an operation nested inside a
  // join element. Parse it instead of failing, so a server-version difference
  // cannot turn a valid plan into an error.
  const operationKey = OPERATION_CONTAINER_KEYS.concat(SET_OPERATION_KEYS).find((key) => Object.hasOwn(entry, key));
  if (operationKey !== undefined) {
    const operationPath = `${path}.${operationKey}`;
    const node = SET_OPERATION_KEYS.includes(operationKey)
      ? parseSetOperation(entry[operationKey], operationKey, operationPath)
      : parseOperationContainer(entry[operationKey], operationKey, operationPath);
    return preserveWrapperExtras(node, entry, [operationKey], "nested_loop_entry");
  }

  throw malformedNode(
    path,
    'every "nested_loop" element must contain a "table" object (MySQL join array shape).',
  );
}

/**
 * `ordering_operation` / `grouping_operation` / `duplicates_removal`: a single
 * wrapper around the operation it describes plus sort / temporary-table flags.
 *
 * @param {unknown} raw
 * @param {string} key
 * @param {string} path
 * @returns {ParsedMySqlNode}
 */
function parseOperationContainer(raw, key, path) {
  const block = requireObject(raw, path);
  const node = emptyNode(key, STRUCTURE_NODE_TYPE[key]);
  node.mysql.message = optionalString(block, "message", path);
  node.mysql.usingFilesort = optionalFlag(block, "using_filesort", path);
  node.mysql.usingTemporaryTable = optionalFlag(block, "using_temporary_table", path);
  node.extra = collectExtra(block, [...COMMON_BLOCK_KEYS, ...OPERATION_KEYS]);
  applyCostInfo(node, block.cost_info, path);
  node.children = parseChildren(block, path);
  return node;
}

/**
 * `union_result` / `unary_result` / `intersect_result` / `except_result`:
 * a result container whose children are the participating query blocks.
 *
 * @param {unknown} raw
 * @param {string} key
 * @param {string} path
 * @returns {ParsedMySqlNode}
 */
function parseSetOperation(raw, key, path) {
  const block = requireObject(raw, path);
  const node = emptyNode(key, STRUCTURE_NODE_TYPE[key]);
  node.mysql.selectId = optionalNumber(block, "select_id", path);
  node.mysql.message = optionalString(block, "message", path);
  node.mysql.usingTemporaryTable = optionalFlag(block, "using_temporary_table", path);
  node.mysql.usingFilesort = optionalFlag(block, "using_filesort", path);
  node.relationName = optionalString(block, "table_name", path);
  node.mysql.accessType = optionalString(block, "access_type", path);
  node.estimatedRows = optionalNumber(block, "rows_examined_per_scan", path);
  node.extra = collectExtra(block, [...COMMON_BLOCK_KEYS, ...SET_OPERATION_FIELD_KEYS]);
  applyCostInfo(node, block.cost_info, path);

  if (Object.hasOwn(block, "query_specifications")) {
    if (!Array.isArray(block.query_specifications)) {
      throw malformedNode(path, `"query_specifications" must be an array; got ${describeValue(block.query_specifications)}.`);
    }
    node.children = block.query_specifications.map((specification, index) =>
      parseQuerySpecification(specification, `${path}.query_specifications[${index}]`),
    );
  }

  return node;
}

/**
 * One entry of a set operation's `query_specifications`. The wrapper carries
 * `dependent` / `cacheable`; both are kept on the resulting query block node so
 * no server information is lost.
 *
 * @param {unknown} raw
 * @param {string} path
 * @returns {ParsedMySqlNode}
 */
function parseQuerySpecification(raw, path) {
  const specification = requireObject(raw, path);

  if (Object.hasOwn(specification, "query_block")) {
    const node = parseQueryBlock(specification.query_block, `${path}.query_block`);
    node.mysql.dependent = optionalFlag(specification, "dependent", path);
    node.mysql.cacheable = optionalFlag(specification, "cacheable", path);
    return preserveWrapperExtras(node, specification, SUBQUERY_ENTRY_KEYS, "query_specification");
  }

  // MySQL 8.0.31+ parenthesized query expressions put a nested set operation
  // (`union_result` / `unary_result` / `intersect_result` / `except_result`)
  // directly in `query_specifications` instead of a
  // `{ dependent, cacheable, query_block }` entry. That is a valid plan MySQL
  // really produces, so parse it instead of rejecting it.
  const setOperationKey = SET_OPERATION_KEYS.find((key) => Object.hasOwn(specification, key));
  if (setOperationKey !== undefined) {
    const node = parseSetOperation(specification[setOperationKey], setOperationKey, `${path}.${setOperationKey}`);
    return preserveWrapperExtras(node, specification, [setOperationKey], "query_specification");
  }

  throw malformedNode(path, 'a "query_specifications" entry must contain a "query_block" object.');
}

/**
 * `materialized_from_subquery`: a temporary materialized result plus the query
 * block that fills it. MySQL nests this inside a table or a query block.
 *
 * @param {unknown} raw
 * @param {string} path
 * @returns {ParsedMySqlNode}
 */
function parseMaterializedSubquery(raw, path) {
  const block = requireObject(raw, path);
  const node = emptyNode("materialized_from_subquery", STRUCTURE_NODE_TYPE.materialized_from_subquery);
  node.mysql.message = optionalString(block, "message", path);
  node.mysql.usingTemporaryTable = optionalFlag(block, "using_temporary_table", path);
  node.mysql.dependent = optionalFlag(block, "dependent", path);
  node.mysql.cacheable = optionalFlag(block, "cacheable", path);
  node.extra = collectExtra(block, [...COMMON_BLOCK_KEYS, ...SUBQUERY_ENTRY_KEYS]);
  applyCostInfo(node, block.cost_info, path);

  if (!Object.hasOwn(block, "query_block")) {
    throw malformedNode(path, '"materialized_from_subquery" must contain a "query_block" object.');
  }
  node.children = [parseQueryBlock(block.query_block, `${path}.query_block`)];
  return node;
}

/**
 * A scalar / semi-join / optimized-away subquery array
 * (`attached_subqueries`, `optimized_away_subqueries`, ...).
 *
 * @param {unknown} raw
 * @param {string} key
 * @param {string} path
 * @returns {ParsedMySqlNode[]}
 */
function parseSubqueryArray(raw, key, path) {
  if (!Array.isArray(raw)) {
    throw malformedNode(path, `"${key}" must be an array; got ${describeValue(raw)}.`);
  }

  return raw.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const specification = requireObject(entry, entryPath);
    if (!Object.hasOwn(specification, "query_block")) {
      throw malformedNode(entryPath, `every "${key}" entry must contain a "query_block" object.`);
    }
    const node = emptyNode(key, "Subquery");
    node.mysql.dependent = optionalFlag(specification, "dependent", entryPath);
    node.mysql.cacheable = optionalFlag(specification, "cacheable", entryPath);
    node.children = [parseQueryBlock(specification.query_block, `${entryPath}.query_block`)];
    node.extra = collectExtra(specification, [...SUBQUERY_ENTRY_KEYS]);
    return node;
  });
}

/**
 * Uniform node shape: every node carries the same keys, so the normalizer and
 * golden tests do not have to handle per-structure key sets.
 *
 * @param {string} structure
 * @param {string} nodeType
 * @returns {ParsedMySqlNode}
 */
function emptyNode(structure, nodeType) {
  return {
    structure,
    nodeType,
    relationName: null,
    indexName: null,
    estimatedRows: null,
    filter: null,
    indexCondition: null,
    children: [],
    mysql: {
      selectId: null,
      message: null,
      accessType: null,
      possibleKeys: null,
      usedKeyParts: null,
      usedColumns: null,
      keyLength: null,
      ref: null,
      rowsExaminedPerScan: null,
      rowsProducedPerJoin: null,
      filteredPercent: null,
      usingIndex: null,
      usingIndexForGroupBy: null,
      usingFilesort: null,
      usingTemporaryTable: null,
      usingJoinBuffer: null,
      firstMatch: null,
      dependent: null,
      cacheable: null,
      queryCost: null,
      readCost: null,
      evalCost: null,
      prefixCost: null,
      dataReadPerJoin: null,
      sortCost: null,
    },
    extra: {},
  };
}

/**
 * Map `cost_info`. MySQL reports every cost as a numeric string; costs stay
 * under `mysql.*` and are never promoted to PostgreSQL-style cost fields.
 * Unknown `cost_info` keys are preserved under `extra.cost_info`.
 *
 * @param {ParsedMySqlNode} node
 * @param {unknown} raw
 * @param {string} path
 */
function applyCostInfo(node, raw, path) {
  if (raw === undefined || raw === null) return;
  const costInfo = requireObject(raw, `${path}.cost_info`);

  node.mysql.queryCost = optionalNumeric(costInfo, "query_cost", `${path}.cost_info`);
  node.mysql.readCost = optionalNumeric(costInfo, "read_cost", `${path}.cost_info`);
  node.mysql.evalCost = optionalNumeric(costInfo, "eval_cost", `${path}.cost_info`);
  node.mysql.prefixCost = optionalNumeric(costInfo, "prefix_cost", `${path}.cost_info`);
  node.mysql.dataReadPerJoin = optionalNumeric(costInfo, "data_read_per_join", `${path}.cost_info`);
  node.mysql.sortCost = optionalNumeric(costInfo, "sort_cost", `${path}.cost_info`);

  const leftovers = collectExtra(costInfo, COST_KEYS);
  if (Object.keys(leftovers).length > 0) node.extra.cost_info = leftovers;
}

/**
 * Keep unexpected keys of a structural wrapper (a `nested_loop` element or a
 * `query_specifications` entry) instead of dropping them. They are namespaced
 * under `extra` so they cannot collide with the wrapped node's own fields.
 *
 * @param {ParsedMySqlNode} node
 * @param {Record<string, unknown>} wrapper
 * @param {readonly string[]} consumedKeys keys whose values became `node`
 * @param {string} extraKey namespace under `extra`
 * @returns {ParsedMySqlNode}
 */
function preserveWrapperExtras(node, wrapper, consumedKeys, extraKey) {
  const leftovers = collectExtra(wrapper, consumedKeys);
  if (Object.keys(leftovers).length > 0) node.extra[extraKey] = leftovers;
  return node;
}

/**
 * Keep every native property the parser does not map, so no server information
 * is lost to the typed model.
 *
 * @param {Record<string, unknown>} raw
 * @param {readonly string[]} keys
 * @returns {Record<string, unknown>}
 */
function collectExtra(raw, keys) {
  const skip = new Set(keys);
  /** @type {Record<string, unknown>} */
  const extra = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!skip.has(key)) extra[key] = value;
  }
  return extra;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function requireObject(value, path) {
  if (!isPlainObject(value)) {
    throw malformedNode(path, `expected a JSON object; got ${describeValue(value)}.`);
  }
  return value;
}

/**
 * Missing / null -> null. A present value that is not a finite number is
 * malformed: `rows_examined_per_scan` and friends are JSON numbers, and
 * coercing a string would invent a value the server did not report.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {number|null}
 */
function optionalNumber(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw malformedNode(path, `[${JSON.stringify(key)}] must be a finite number when present; got ${describeValue(value)}.`);
  }
  return value;
}

/**
 * MySQL reports `cost_info` and `filtered` as numeric strings. Both a string
 * and a number are accepted; a string that is not a number is malformed.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {number|null}
 */
function optionalNumeric(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && NUMERIC_STRING.test(value.trim()) && value.trim().length > 0) {
    return Number(value);
  }
  throw malformedNode(path, `[${JSON.stringify(key)}] must be a number or a numeric string; got ${describeValue(value)}.`);
}

/**
 * `filtered` is a percentage string ("100.00"). It is parsed to the number the
 * server reported; it is not rescaled and not merged with any other field.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {number|null}
 */
function optionalPercentage(raw, key, path) {
  return optionalNumeric(raw, key, path);
}

/**
 * `key_length` is a string in MySQL output ("3"), but a number is accepted so a
 * driver-side type change cannot break parsing. The value is kept as a string.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {string|null}
 */
function optionalKeyLength(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw malformedNode(path, `[${JSON.stringify(key)}] must be a string or a number when present; got ${describeValue(value)}.`);
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {string|null}
 */
function optionalString(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw malformedNode(path, `[${JSON.stringify(key)}] must be a string when present; got ${describeValue(value)}.`);
  }
  return value;
}

/**
 * Flags such as `using_filesort` are booleans in current MySQL output; the
 * legacy string forms are accepted so a version difference cannot break
 * parsing. Any other value is malformed.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {boolean|null}
 */
function optionalFlag(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw malformedNode(path, `[${JSON.stringify(key)}] must be a boolean when present; got ${describeValue(value)}.`);
}

/**
 * MySQL reports lists as arrays of strings; a bare string is accepted as a
 * one-element list so a server-version difference cannot break parsing. Values
 * are never invented.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {string[]|null}
 */
function optionalStringList(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return [...value];
  throw malformedNode(path, `[${JSON.stringify(key)}] must be a string or an array of strings; got ${describeValue(value)}.`);
}

/**
 * A raw list (`ref`) whose elements are passed through unchanged: MySQL can
 * report strings or structured entries depending on the access type.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {unknown[]|null}
 */
function optionalRawList(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return [...value];
  throw malformedNode(path, `[${JSON.stringify(key)}] must be an array when present; got ${describeValue(value)}.`);
}

/** @param {string} path @param {string} message */
function malformedNode(path, message) {
  return new PlanParseError("MALFORMED_NODE", `${path}: ${message}`);
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length ${value.length})`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") {
    const shown = value.length > 40 ? `${value.slice(0, 37)}...` : value;
    return `string(${JSON.stringify(shown)})`;
  }
  return `${typeof value}(${String(value)})`;
}

/** Strict numeric-string shape MySQL uses for `cost_info` / `filtered`. */
const NUMERIC_STRING = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
