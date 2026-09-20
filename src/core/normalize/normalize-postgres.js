/**
 * PostgreSQL parsed plan -> database-neutral NormalizedPlan.
 *
 * The normalizer is the semantic bridge: it gives every node a stable `kind`,
 * promotes the fields rules and metrics care about into database-neutral names,
 * and keeps everything PostgreSQL-specific under `engineSpecific` so no native
 * information is lost.
 *
 * It never interprets cost, never guesses missing values and never depends on
 * the number of nodes: the same input always produces the same output.
 */

/**
 * PostgreSQL node type -> stable semantic kind.
 *
 * The map is deliberately finite. Unknown or future node types become
 * "unknown"; the raw `nodeType` string and the whole child subtree are always
 * preserved, and the plan records which raw types were not classified.
 */
const KIND_BY_NODE_TYPE = Object.freeze({
  "Seq Scan": "seq_scan",
  "Index Scan": "index_scan",
  "Index Only Scan": "index_only_scan",
  "Bitmap Heap Scan": "bitmap_heap_scan",
  "Bitmap Index Scan": "bitmap_index_scan",
  "Tid Scan": "tid_scan",
  "Sample Scan": "sample_scan",
  "Nested Loop": "nested_loop",
  "Hash Join": "hash_join",
  "Merge Join": "merge_join",
  Hash: "hash",
  Sort: "sort",
  "Incremental Sort": "incremental_sort",
  Aggregate: "aggregate",
  HashAggregate: "aggregate",
  GroupAggregate: "aggregate",
  MixedAggregate: "aggregate",
  Group: "group",
  WindowAgg: "analytic",
  Unique: "unique",
  Limit: "limit",
  Memoize: "memoize",
  Materialize: "materialize",
  Gather: "gather",
  "Gather Merge": "gather_merge",
  Append: "append",
  "Merge Append": "merge_append",
  Result: "result",
  "Subquery Scan": "subquery_scan",
  "Values Scan": "values_scan",
  "Function Scan": "function_scan",
  "Table Function Scan": "table_function_scan",
  "CTE Scan": "cte_scan",
  "WorkTable Scan": "worktable_scan",
  SetOp: "setop",
  "Recursive Union": "recursive_union",
  ModifyTable: "modify_table",
  LockRows: "lock_rows",
  ProjectSet: "project_set",
});

/**
 * @typedef {Object} NormalizedNode
 * @property {string} id stable path id: "0", "0.0", "0.1.0", ...
 * @property {string} kind semantic kind; "unknown" for unclassified node types
 * @property {string} nodeType raw PostgreSQL node type
 * @property {{ name: string|null, alias: string|null, indexName: string|null }|null} relation
 * @property {number|null} estimatedRows
 * @property {number|null} actualRows
 * @property {number|null} actualStartupTime
 * @property {number|null} actualTotalTime
 * @property {number|null} loops
 * @property {number|null} startupCost
 * @property {number|null} totalCost
 * @property {number|null} width
 * @property {string|null} filter
 * @property {string|null} joinType
 * @property {string|null} joinCondition primary condition of a join node, when present
 * @property {string|null} indexCondition
 * @property {string[]|null} sortKeys
 * @property {string[]|null} groupKeys
 * @property {NormalizedNode[]} children
 * @property {Record<string, unknown>} engineSpecific PostgreSQL-only fields
 *
 * @typedef {Object} NormalizedPlan
 * @property {"postgresql"} database
 * @property {"estimated"|"actual"} mode
 * @property {"json"} format
 * @property {NormalizedNode} root
 * @property {string[]} unknownNodeTypes sorted unique raw node types that had no kind
 */

/**
 * @param {import("../postgres/parse-json-plan.js").ParsedPlan} parsed
 * @returns {NormalizedPlan}
 */
export function normalizePostgresPlan(parsed) {
  const unknownNodeTypes = new Set();
  const root = normalizeNode(parsed.root, "0", unknownNodeTypes);

  return {
    database: "postgresql",
    mode: parsed.mode,
    format: parsed.format,
    root,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  };
}

/**
 * @param {import("../postgres/parse-json-plan.js").ParsedPlanNode} node
 * @param {string} id
 * @param {Set<string>} unknownNodeTypes
 * @returns {NormalizedNode}
 */
function normalizeNode(node, id, unknownNodeTypes) {
  const kind = KIND_BY_NODE_TYPE[node.nodeType] ?? "unknown";
  if (kind === "unknown") unknownNodeTypes.add(node.nodeType);

  const hasRelation = node.relationName !== null || node.alias !== null || node.indexName !== null;

  return {
    id,
    kind,
    nodeType: node.nodeType,
    relation: hasRelation
      ? { name: node.relationName, alias: node.alias, indexName: node.indexName }
      : null,
    estimatedRows: node.planRows,
    actualRows: node.actualRows,
    actualStartupTime: node.actualStartupTime,
    actualTotalTime: node.actualTotalTime,
    loops: node.actualLoops,
    startupCost: node.startupCost,
    totalCost: node.totalCost,
    width: node.planWidth,
    filter: node.filter,
    joinType: node.joinType,
    joinCondition: node.hashCondition ?? node.mergeCondition ?? node.joinFilter ?? null,
    indexCondition: node.indexCondition,
    sortKeys: node.sortKeys,
    groupKeys: node.groupKeys,
    children: node.children.map((child, index) => normalizeNode(child, `${id}.${index}`, unknownNodeTypes)),
    engineSpecific: {
      database: "postgresql",
      parentRelationship: node.parentRelationship,
      subplanName: node.subplanName,
      strategy: node.strategy,
      partialMode: node.partialMode,
      parallelAware: node.parallelAware,
      asyncCapable: node.asyncCapable,
      hashCondition: node.hashCondition,
      mergeCondition: node.mergeCondition,
      joinFilter: node.joinFilter,
      recheckCondition: node.recheckCondition,
      presortedKeys: node.presortedKeys,
      extra: node.extra,
    },
  };
}
