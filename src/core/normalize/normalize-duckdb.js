const KIND_BY_OPERATOR = Object.freeze({
  SEQ_SCAN: "seq_scan",
  TABLE_SCAN: "seq_scan",
  INDEX_SCAN: "index_scan",
  ART_INDEX_SCAN: "index_scan",
  PARQUET_SCAN: "scan",
  CSV_SCAN: "scan",
  READ_PARQUET: "scan",
  READ_CSV: "scan",
  ARROW_SCAN: "scan",
  DATA_SCAN: "scan",
  COLUMN_DATA_SCAN: "scan",
  CHUNK_SCAN: "scan",
  DELIM_SCAN: "scan",
  CTE_SCAN: "scan",
  DUMMY_SCAN: "scan",
  EMPTY_RESULT: "result",
  HASH_JOIN: "hash_join",
  NESTED_LOOP_JOIN: "nested_loop",
  BLOCKWISE_NL_JOIN: "nested_loop",
  PIECEWISE_MERGE_JOIN: "merge_join",
  MERGE_JOIN: "merge_join",
  ASOF_JOIN: "join",
  IE_JOIN: "join",
  INDEX_JOIN: "join",
  POSITIONAL_JOIN: "join",
  DELIM_JOIN: "join",
  CROSS_PRODUCT: "join",
  FILTER: "filter",
  PROJECTION: "project",
  ORDER_BY: "sort",
  TOP_N: "sort",
  HASH_GROUP_BY: "aggregate",
  PERFECT_HASH_GROUP_BY: "aggregate",
  UNGROUPED_AGGREGATE: "aggregate",
  AGGREGATE: "aggregate",
  DISTINCT: "aggregate",
  WINDOW: "analytic",
  STREAMING_WINDOW: "analytic",
  LIMIT: "limit",
  STREAMING_LIMIT: "limit",
  RESERVOIR_SAMPLE: "sample_scan",
  STREAMING_SAMPLE: "sample_scan",
  UNION: "append",
  UNION_ALL: "append",
  INTERSECT: "setop",
  EXCEPT: "setop",
  CTE: "materialize",
  RECURSIVE_CTE: "materialize",
  TABLE_IN_OUT: "table_function",
});

/**
 * DuckDB EXPLAIN physical operator tree -> database-neutral NormalizedPlan.
 *
 * DuckDB's estimated cardinality (`EC` / `~N rows`) maps to `estimatedRows`
 * when reported as a safe integer; DuckDB does not expose PostgreSQL-style
 * cumulative cost units, so `startupCost` and `totalCost` remain `null` and
 * cost attribution stays `not-applicable`.
 *
 * @typedef {Object} NormalizedDuckDbPlan
 * @property {"duckdb"} database
 * @property {"estimated"} mode
 * @property {"text"} format
 * @property {import("./normalize-postgres.js").NormalizedNode} root
 * @property {string[]} unknownNodeTypes
 */

/**
 * @param {import("../duckdb/parse-text-plan.js").ParsedDuckDbPlan} parsed
 * @returns {NormalizedDuckDbPlan}
 */
export function normalizeDuckDbPlan(parsed) {
  const unknownNodeTypes = new Set();
  const root = normalizeNode(parsed.root, "0", unknownNodeTypes, parsed.planHeader);
  return {
    database: "duckdb",
    mode: parsed.mode,
    format: parsed.format,
    root,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  };
}

/**
 * @param {import("../duckdb/parse-text-plan.js").ParsedDuckDbNode} node
 * @param {string} id
 * @param {Set<string>} unknownNodeTypes
 * @param {string|null} [planHeader]
 * @returns {import("./normalize-postgres.js").NormalizedNode}
 */
function normalizeNode(node, id, unknownNodeTypes, planHeader = null) {
  const kind = KIND_BY_OPERATOR[node.operator] ?? "unknown";
  if (kind === "unknown") unknownNodeTypes.add(node.nodeType);

  return {
    id,
    kind,
    nodeType: node.nodeType,
    relation: node.table === null ? null : { name: node.table, alias: null, indexName: null },
    estimatedRows: node.estimatedRows,
    actualRows: null,
    actualStartupTime: null,
    actualTotalTime: null,
    loops: null,
    startupCost: null,
    totalCost: null,
    width: null,
    filter: node.filter,
    joinType: node.joinType,
    joinCondition: node.joinCondition,
    indexCondition: null,
    sortKeys: node.sortKeys === null ? null : [...node.sortKeys],
    groupKeys: node.groupKeys === null ? null : [...node.groupKeys],
    children: node.children.map((child, index) => normalizeNode(child, `${id}.${index}`, unknownNodeTypes)),
    engineSpecific: {
      database: "duckdb",
      duckdb: {
        operator: node.operator,
        nodeType: node.nodeType,
        table: node.table,
        estimatedCardinality: node.estimatedRows,
        filter: node.filter,
        joinType: node.joinType,
        joinCondition: node.joinCondition,
        projections: node.projections === null ? null : [...node.projections],
        sortKeys: node.sortKeys === null ? null : [...node.sortKeys],
        groupKeys: node.groupKeys === null ? null : [...node.groupKeys],
        properties: node.properties.map((prop) => ({ ...prop })),
        sections: node.sections.map((sec) => [...sec]),
        ...(planHeader === null ? {} : { planHeader }),
      },
      extra: isPlainObject(node.extra) ? { ...node.extra } : {},
    },
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
