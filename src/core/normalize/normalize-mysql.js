/**
 * MySQL parsed plan -> database-neutral NormalizedPlan.
 *
 * The normalizer mirrors the PostgreSQL stage: it maps MySQL node labels onto
 * stable semantic `kind` values, promotes the fields metrics and rules care
 * about into database-neutral names, and keeps everything MySQL-specific under
 * `engineSpecific.mysql`.
 *
 * Cost mapping decision (deliberate, see docs/PLAN_INPUT_AND_FIXTURES.md):
 * MySQL costs are not comparable with PostgreSQL costs. MySQL reports
 * `read_cost` / `eval_cost` / `prefix_cost` / `query_cost` in its own cost
 * model, and `prefix_cost` is cumulative over the join prefix, so subtracting
 * child costs (the PostgreSQL "incremental cost" semantics) would produce
 * meaningless numbers. This round therefore maps **no** MySQL cost onto
 * `startupCost` / `totalCost`: those stay `null`, and every server-reported cost
 * stays under `engineSpecific.mysql` for display. As a consequence the
 * cost-based branches of the existing rules cannot fire for MySQL; rules still
 * work through kind / estimated rows / access pattern.
 *
 * It never interprets cost, never guesses missing values and never depends on
 * the number of nodes: the same input always produces the same output.
 */

/**
 * MySQL node label -> stable semantic kind.
 *
 * The MySQL labels come from the V1/V2 MySQL parsers; an access type the parser
 * does not recognize is used verbatim as the label and lands in
 * `unknown` here, then in `unknownNodeTypes`.
 *
 * `const_scan` and `subquery` are MySQL-side additions to the kind vocabulary;
 * no existing metric or rule depends on them. `View`/`Table` scans of a
 * `const`/`system` access are single-row lookups, which is why they are not
 * classified as `index_scan`.
 */
const KIND_BY_NODE_TYPE = Object.freeze({
  "Query Block": "query_block",
  "Table Scan": "seq_scan",
  "Full Index Scan": "index_scan",
  "Index Range Scan": "index_scan",
  "Index Lookup": "index_scan",
  "Unique Index Lookup": "index_scan",
  "Index Lookup Or Null": "index_scan",
  "Fulltext Lookup": "index_scan",
  "Index Merge": "index_scan",
  "Unique Subquery Lookup": "index_scan",
  "Index Subquery Lookup": "index_scan",
  "Const Row Lookup": "const_scan",
  "System Row Lookup": "const_scan",
  "Nested Loop": "nested_loop",
  "Ordering Operation": "sort",
  "Grouping Operation": "aggregate",
  "Duplicates Removal": "unique",
  "Union Result": "append",
  "Unary Result": "result",
  "Intersect Result": "setop",
  "Except Result": "setop",
  "Materialized Subquery": "materialize",
  Subquery: "subquery",
  // MySQL JSON Explain V2 access-path labels.
  Append: "append",
  Aggregate: "aggregate",
  "Count Rows": "aggregate",
  "Temporary Table Aggregate": "aggregate",
  Filter: "filter",
  "Hash Join": "hash_join",
  "Batched Key Access Join": "join",
  Join: "join",
  "Merge Join": "merge_join",
  Sort: "sort",
  Limit: "limit",
  Stream: "stream",
  Window: "analytic",
  "Remove Duplicates": "unique",
  Materialize: "materialize",
  "Materialize Information Schema": "materialize",
  "Materialize Table Function": "materialize",
  "Index Distance Scan": "index_scan",
  "Index Skip Scan": "index_scan",
  "Group Index Skip Scan": "index_scan",
  "Dynamic Index Range Scan": "index_scan",
  "Multi-Range Index Lookup": "index_scan",
  "Rows Fetched Before Execution": "const_scan",
  "Insert Values": "modify_table",
  "Replace Values": "modify_table",
  "Delete Rows": "modify_table",
  "Scan New Records": "modify_table",
  "Invalidate Materialized Tables": "modify_table",
  "Zero Rows": "result",
  "Zero Rows Aggregated": "aggregate",
  "Row ID Union": "append",
  "Row ID Intersection": "append",
});

/**
 * @typedef {Object} NormalizedNode
 * @property {string} id stable path id: "0", "0.0", "0.1.0", ...
 * @property {string} kind semantic kind; "unknown" for unclassified labels
 * @property {string} nodeType raw MySQL label (access type for unknown access types)
 * @property {{ name: string|null, alias: string|null, indexName: string|null }|null} relation
 * @property {number|null} estimatedRows
 * @property {number|null} actualRows always null: MySQL estimated JSON has no runtime fields
 * @property {number|null} actualStartupTime always null
 * @property {number|null} actualTotalTime always null
 * @property {number|null} loops always null
 * @property {number|null} startupCost always null: MySQL has no startup cost
 * @property {number|null} totalCost always null: MySQL costs stay under engineSpecific
 * @property {number|null} width always null
 * @property {string|null} filter
 * @property {string|null} joinType V2 `join_type`, when the access path reports it
 * @property {string|null} joinCondition always null: V2 keeps condition arrays under MySQL evidence
 * @property {string|null} indexCondition V1 `index_condition` or V2 `pushed_index_condition`
 * @property {string[]|null} sortKeys V2 `sort_fields`, when reported
 * @property {string[]|null} groupKeys V2 `group_items`, when reported
 * @property {NormalizedNode[]} children
 * @property {Record<string, unknown>} engineSpecific MySQL-only fields
 *
 * @typedef {Object} NormalizedPlan
 * @property {"mysql"} database
 * @property {"estimated"} mode
 * @property {"json"} format
 * @property {NormalizedNode} root
 * @property {string[]} unknownNodeTypes sorted unique labels that had no kind
 */

/**
 * @param {import("../mysql/parse-json-plan.js").ParsedPlan} parsed
 * @returns {NormalizedPlan}
 */
export function normalizeMySqlPlan(parsed) {
  const unknownNodeTypes = new Set();
  const root = normalizeNode(parsed.root, "0", unknownNodeTypes);

  return {
    database: "mysql",
    mode: parsed.mode,
    format: parsed.format,
    root,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  };
}

/**
 * @param {import("../mysql/parse-json-plan.js").ParsedMySqlNode} node
 * @param {string} id
 * @param {Set<string>} unknownNodeTypes
 * @returns {NormalizedNode}
 */
function normalizeNode(node, id, unknownNodeTypes) {
  const kind = KIND_BY_NODE_TYPE[node.nodeType] ?? "unknown";
  if (kind === "unknown") unknownNodeTypes.add(node.nodeType);

  const mysql = node.mysql ?? {};
  const alias = typeof mysql.alias === "string" ? mysql.alias : null;
  const hasRelation = node.relationName !== null || node.indexName !== null || alias !== null;

  return {
    id,
    kind,
    nodeType: node.nodeType,
    relation: hasRelation
      ? { name: node.relationName, alias, indexName: node.indexName }
      : null,
    estimatedRows: node.estimatedRows,
    // MySQL estimated plans never carry runtime values; nothing to map.
    actualRows: null,
    actualStartupTime: null,
    actualTotalTime: null,
    loops: null,
    // MySQL has no startup cost and reports costs in its own model; see the
    // module header for why nothing is promoted here.
    startupCost: null,
    totalCost: null,
    width: null,
    filter: node.filter,
    joinType: typeof mysql.joinType === "string" ? mysql.joinType : null,
    // V2 hash conditions are arrays and remain under engineSpecific.mysql;
    // the neutral field is not populated by coercing them into one string.
    joinCondition: null,
    indexCondition: node.indexCondition,
    sortKeys: Array.isArray(mysql.sortFields) ? [...mysql.sortFields] : null,
    groupKeys: Array.isArray(mysql.groupItems) ? [...mysql.groupItems] : null,
    children: node.children.map((child, index) => normalizeNode(child, `${id}.${index}`, unknownNodeTypes)),
    engineSpecific: {
      database: "mysql",
      mysql: { structure: node.structure, ...node.mysql },
      extra: node.extra,
    },
  };
}
