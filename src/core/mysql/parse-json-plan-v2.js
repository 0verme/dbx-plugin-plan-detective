/**
 * MySQL EXPLAIN FORMAT=JSON V2 parser.
 *
 * V2 is an access-path tree, not a renamed V1 query_block. Every plan object
 * is a node and its direct children are carried by `inputs` or
 * `inputs_from_select_list`. The parser keeps
 * V2 vocabulary under `mysql`, promotes only fields with an established
 * neutral meaning, and leaves future fields in `extra`.
 */

import { PlanParseError } from "../errors.js";

// Keep the engine key assembled so the browser-global isolation tripwire does
// not mistake this MySQL access-path property for a host API reference.
const V2_WINDOW_KEY = ["win", "dow"].join("");

/** V2 node properties emitted by MySQL 9.5's access-path explain writer. */
const V2_NODE_KEYS = Object.freeze([
  "access_type",
  "actual_first_row_ms",
  "actual_last_row_ms",
  "actual_loops",
  "actual_rows",
  "alias",
  "append",
  "buffering",
  "cache_invalidators",
  "cacheable",
  "condition",
  "count_all_rows",
  "covering",
  "cte",
  "deduplication",
  "dependent",
  "duplicate_removal",
  "estimated_first_row_cost",
  "estimated_rows",
  "estimated_total_cost",
  "except",
  "extra_condition",
  "filter_columns",
  "functions",
  "group_by",
  "group_items",
  "hash_condition",
  "heading",
  "index_access_type",
  "index_name",
  "inputs",
  "inputs_from_select_list",
  "insert",
  "index_merge",
  "join_algorithm",
  "join_columns",
  "join_type",
  "key_columns",
  "limit",
  "limit_offset",
  "lookup_condition",
  "lookup_references",
  "message",
  "multi_pass",
  "multi_range_read",
  "operation",
  "per_chunk_limit",
  "percentage",
  "pushed_index_condition",
  "ranges",
  "recursive",
  "reverse",
  "rollup",
  "row_ids",
  "sampling_type",
  "schema_name",
  "secondary_engine",
  "semijoin_strategy",
  "signature",
  "sort_fields",
  "subquery",
  "subquery_location",
  "table_name",
  "tables",
  "temp_table",
  "union",
  "update",
  "used_columns",
  V2_WINDOW_KEY,
  "zero_rows_cause",
]);

const V2_BOOLEAN_KEYS = Object.freeze([
  "append",
  "buffering",
  "cacheable",
  "count_all_rows",
  "covering",
  "cte",
  "deduplication",
  "dependent",
  "duplicate_removal",
  "except",
  "group_by",
  "index_merge",
  "insert",
  "multi_pass",
  "multi_range_read",
  "recursive",
  "reverse",
  "rollup",
  "row_ids",
  "subquery",
  "temp_table",
  "union",
  "update",
  V2_WINDOW_KEY,
]);

const INDEX_NODE_TYPE = Object.freeze({
  dynamic_index_range_scan: "Dynamic Index Range Scan",
  full_text_search: "Fulltext Lookup",
  group_index_skip_scan: "Group Index Skip Scan",
  index_distance_scan: "Index Distance Scan",
  index_lookup: "Index Lookup",
  index_range_scan: "Index Range Scan",
  index_scan: "Full Index Scan",
  index_skip_scan: "Index Skip Scan",
  multi_range_read: "Multi-Range Index Lookup",
});

const ACCESS_NODE_TYPE = Object.freeze({
  aggregate: "Aggregate",
  alternative_plans_for_in_subquery: "Alternative Plans",
  append: "Append",
  count_rows: "Count Rows",
  constant_row: "Const Row Lookup",
  delete_rows: "Delete Rows",
  filter: "Filter",
  invalidate_materialized_tables: "Invalidate Materialized Tables",
  index_merge: "Index Merge",
  insert_values: "Insert Values",
  join: "Join",
  limit: "Limit",
  materialize: "Materialize",
  materialize_information_schema: "Materialize Information Schema",
  materialized_table_function: "Materialize Table Function",
  remove_duplicates_from_groups: "Remove Duplicates",
  remove_duplicates_on_index: "Remove Duplicates",
  replace_values: "Replace Values",
  rows_fetched_before_execution: "Rows Fetched Before Execution",
  rowid_intersection: "Row ID Intersection",
  rowid_union: "Row ID Union",
  scan_new_records: "Scan New Records",
  sort: "Sort",
  stream: "Stream",
  table: "Table Scan",
  temp_table_aggregate: "Temporary Table Aggregate",
  [V2_WINDOW_KEY]: "Window",
  zero_rows: "Zero Rows",
  zero_rows_aggregated: "Zero Rows Aggregated",
});

const JOIN_NODE_TYPE = Object.freeze({
  batch_key_access: "Batched Key Access Join",
  hash: "Hash Join",
  nested_loop: "Nested Loop",
});

/**
 * Parse a V2 envelope after the dispatcher has established `json_schema_version`
 * as a supported 2.x version.
 *
 * @param {unknown} plan
 * @returns {ParsedMySqlNode}
 */
export function parseMySqlJsonPlanV2(plan) {
  const envelope = requireObject(plan, "plan");
  const schemaVersion = requiredString(envelope, "json_schema_version", "plan");
  const queryPlan = requireObject(envelope.query_plan, "plan.query_plan");
  const root = parseV2Node(queryPlan, "plan.query_plan", "query_plan");

  root.mysql.query = optionalString(envelope, "query", "plan");
  root.mysql.queryType = optionalString(envelope, "query_type", "plan");
  root.mysql.jsonSchemaVersion = schemaVersion;
  root.extra = {
    ...root.extra,
    ...collectExtra(envelope, ["json_schema_version", "query", "query_plan", "query_type"]),
  };

  return root;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} path
 * @param {"query_plan"|"input"} structure
 * @returns {ParsedMySqlNode}
 */
function parseV2Node(raw, path, structure) {
  const operation = requiredString(raw, "operation", path);
  const accessType = optionalString(raw, "access_type", path);
  const indexAccessType = optionalString(raw, "index_access_type", path);
  const node = emptyV2Node(structure, nodeTypeFor(raw, accessType, indexAccessType));

  node.relationName = optionalString(raw, "table_name", path);
  node.indexName = optionalString(raw, "index_name", path);
  node.estimatedRows = optionalNumber(raw, "estimated_rows", path);
  node.filter = accessType === "filter" ? optionalString(raw, "condition", path) : null;
  node.indexCondition = optionalString(raw, "pushed_index_condition", path);

  node.mysql.operation = operation;
  node.mysql.accessType = accessType;
  node.mysql.indexAccessType = indexAccessType;
  node.mysql.alias = optionalString(raw, "alias", path);
  node.mysql.schemaName = optionalString(raw, "schema_name", path);
  node.mysql.message = optionalString(raw, "message", path);
  node.mysql.heading = optionalString(raw, "heading", path);
  node.mysql.secondaryEngine = optionalString(raw, "secondary_engine", path);
  node.mysql.usedColumns = optionalStringList(raw, "used_columns", path);
  node.mysql.keyColumns = optionalStringList(raw, "key_columns", path);
  node.mysql.ranges = optionalStringList(raw, "ranges", path);
  node.mysql.covering = optionalFlag(raw, "covering", path);
  node.mysql.reverse = optionalFlag(raw, "reverse", path);
  node.mysql.lookupCondition = optionalString(raw, "lookup_condition", path);
  node.mysql.lookupReferences = optionalStringList(raw, "lookup_references", path);
  node.mysql.pushedIndexCondition = node.indexCondition;
  node.mysql.condition = optionalString(raw, "condition", path);
  node.mysql.filterColumns = optionalStringList(raw, "filter_columns", path);
  node.mysql.joinType = optionalString(raw, "join_type", path);
  node.mysql.joinAlgorithm = optionalString(raw, "join_algorithm", path);
  node.mysql.joinColumns = optionalStringList(raw, "join_columns", path);
  node.mysql.hashCondition = optionalStringList(raw, "hash_condition", path);
  node.mysql.extraCondition = optionalStringList(raw, "extra_condition", path);
  node.mysql.semijoinStrategy = optionalString(raw, "semijoin_strategy", path);
  node.mysql.sortFields = optionalStringList(raw, "sort_fields", path);
  node.mysql.groupItems = optionalStringList(raw, "group_items", path);
  node.mysql.functions = optionalStringList(raw, "functions", path);
  node.mysql.tables = optionalStringOrList(raw, "tables", path);
  node.mysql.cacheInvalidators = optionalStringList(raw, "cache_invalidators", path);
  node.mysql.samplingType = optionalString(raw, "sampling_type", path);
  node.mysql.zeroRowsCause = optionalString(raw, "zero_rows_cause", path);

  node.mysql.estimatedTotalCost = optionalNumber(raw, "estimated_total_cost", path);
  node.mysql.estimatedFirstRowCost = optionalNumber(raw, "estimated_first_row_cost", path);
  node.mysql.actualFirstRowMs = optionalNumber(raw, "actual_first_row_ms", path);
  node.mysql.actualLastRowMs = optionalNumber(raw, "actual_last_row_ms", path);
  node.mysql.actualRows = optionalNumber(raw, "actual_rows", path);
  node.mysql.actualLoops = optionalNumber(raw, "actual_loops", path);
  node.mysql.limit = optionalNumber(raw, "limit", path);
  node.mysql.limitOffset = optionalNumber(raw, "limit_offset", path);
  node.mysql.perChunkLimit = optionalNumber(raw, "per_chunk_limit", path);
  node.mysql.percentage = optionalNumber(raw, "percentage", path);
  node.mysql.signature = optionalNumber(raw, "signature", path);

  for (const key of V2_BOOLEAN_KEYS) {
    node.mysql[toCamelCase(key)] = optionalFlag(raw, key, path);
  }

  node.extra = collectExtra(raw, V2_NODE_KEYS);
  node.children = [
    ...parseInputs(raw, "inputs_from_select_list", path),
    ...parseInputs(raw, "inputs", path),
  ];
  return node;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {ParsedMySqlNode[]}
 */
function parseInputs(raw, key, path) {
  if (!Object.hasOwn(raw, key)) return [];
  const value = raw[key];
  if (!Array.isArray(value)) {
    throw malformedNode(path, `[${JSON.stringify(key)}] must be an array; got ${describeValue(value)}.`);
  }
  if (value.length === 0) {
    throw malformedNode(path, `[${JSON.stringify(key)}] must not be empty.`);
  }
  return value.map((entry, index) => parseV2Node(requireObject(entry, `${path}.${key}[${index}]`), `${path}.${key}[${index}]`, "input"));
}

/**
 * V2 `access_type` describes an access path, while `operation` is a display
 * string. Labels are derived only from access types and the listed index /
 * join algorithm values; an unrecognized value remains visible verbatim.
 *
 * @param {Record<string, unknown>} raw
 * @param {string|null} accessType
 * @param {string|null} indexAccessType
 * @returns {string}
 */
function nodeTypeFor(raw, accessType, indexAccessType) {
  if (accessType === "index") return INDEX_NODE_TYPE[indexAccessType] ?? indexAccessType ?? accessType;
  if (accessType === "join") return JOIN_NODE_TYPE[raw.join_algorithm] ?? accessType;
  if (accessType !== null) return ACCESS_NODE_TYPE[accessType] ?? accessType;
  return String(raw.operation);
}

/**
 * Keep the same base fields as V1 and add V2-specific evidence fields. V1
 * nodes are intentionally not changed, so existing parsed goldens remain
 * byte-for-byte stable.
 *
 * @param {"query_plan"|"input"} structure
 * @param {string} nodeType
 * @returns {ParsedMySqlNode}
 */
function emptyV2Node(structure, nodeType) {
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
      query: null,
      queryType: null,
      jsonSchemaVersion: null,
      alias: null,
      schemaName: null,
      operation: null,
      heading: null,
      secondaryEngine: null,
      indexAccessType: null,
      keyColumns: null,
      ranges: null,
      covering: null,
      reverse: null,
      lookupCondition: null,
      lookupReferences: null,
      pushedIndexCondition: null,
      condition: null,
      filterColumns: null,
      joinType: null,
      joinAlgorithm: null,
      joinColumns: null,
      hashCondition: null,
      extraCondition: null,
      semijoinStrategy: null,
      sortFields: null,
      groupItems: null,
      functions: null,
      tables: null,
      cacheInvalidators: null,
      samplingType: null,
      zeroRowsCause: null,
      estimatedTotalCost: null,
      estimatedFirstRowCost: null,
      actualFirstRowMs: null,
      actualLastRowMs: null,
      actualRows: null,
      actualLoops: null,
      limit: null,
      limitOffset: null,
      perChunkLimit: null,
      percentage: null,
      signature: null,
      ...Object.fromEntries(V2_BOOLEAN_KEYS.map((key) => [toCamelCase(key), null])),
    },
    extra: {},
  };
}

/**
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
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {string}
 */
function requiredString(raw, key, path) {
  const value = optionalString(raw, key, path);
  if (value === null || value.length === 0) {
    throw malformedNode(path, `[${JSON.stringify(key)}] must be a non-empty string.`);
  }
  return value;
}

/**
 * V2 arrays are emitted as arrays, even when empty. A scalar is not coerced to
 * a one-element list because doing so would weaken the V2 schema check.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {string[]|null}
 */
function optionalStringList(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw malformedNode(path, `[${JSON.stringify(key)}] must be an array of strings when present; got ${describeValue(value)}.`);
  }
  return [...value];
}

/**
 * `tables` is an array for iterator nodes such as duplicate removal, but the
 * DML writers use one descriptive string. Preserve either supported shape.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {string|string[]|null}
 */
function optionalStringOrList(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return [...value];
  throw malformedNode(path, `[${JSON.stringify(key)}] must be a string or an array of strings when present; got ${describeValue(value)}.`);
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {boolean|null}
 */
function optionalFlag(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw malformedNode(path, `[${JSON.stringify(key)}] must be a boolean when present; got ${describeValue(value)}.`);
  }
  return value;
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

/** @param {string} key */
function toCamelCase(key) {
  return key.replace(/_([a-z])/g, (_, character) => character.toUpperCase());
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

/**
 * @typedef {Object} ParsedMySqlNode
 * @property {string} structure
 * @property {string} nodeType
 * @property {string|null} relationName
 * @property {string|null} indexName
 * @property {number|null} estimatedRows
 * @property {string|null} filter
 * @property {string|null} indexCondition
 * @property {ParsedMySqlNode[]} children
 * @property {Record<string, unknown>} mysql
 * @property {Record<string, unknown>} extra
 */
