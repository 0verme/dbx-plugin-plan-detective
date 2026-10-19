import { normalizePostgresPlan } from "./normalize-postgres.js";

/** DWS names with an unambiguous database-neutral operator kind. */
const DWS_KIND_BY_NODE_TYPE = Object.freeze({
  "row adapter": "adapter",
  "data node scan": "remote_scan",
  "cstore scan": "scan",
  "vector aggregate": "aggregate",
  "hash aggregate": "aggregate",
  "vector sonic hash aggregate": "aggregate",
  "vector sonic hash join": "hash_join",
  "vector limit": "limit",
  "vector sort": "sort",
  "seq scan": "seq_scan",
  "index scan": "index_scan",
  "index only scan": "index_only_scan",
  "bitmap heap scan": "bitmap_heap_scan",
  "bitmap index scan": "bitmap_index_scan",
  "tid scan": "tid_scan",
  "sample scan": "sample_scan",
  "nested loop": "nested_loop",
  "hash join": "hash_join",
  "merge join": "merge_join",
  hash: "hash",
  aggregate: "aggregate",
  hashaggregate: "aggregate",
  groupaggregate: "aggregate",
  "group aggregate": "aggregate",
  mixedaggregate: "aggregate",
  "mixed aggregate": "aggregate",
  group: "group",
  sort: "sort",
  "incremental sort": "incremental_sort",
  ["WindowAgg".toLowerCase()]: "analytic",
  unique: "unique",
  limit: "limit",
  memoize: "memoize",
  materialize: "materialize",
  gather: "gather",
  "gather merge": "gather_merge",
  append: "append",
  "merge append": "merge_append",
  result: "result",
  "subquery scan": "subquery_scan",
  "values scan": "values_scan",
  "function scan": "function_scan",
  "table function scan": "table_function_scan",
  "cte scan": "cte_scan",
  "worktable scan": "worktable_scan",
  setop: "setop",
  "recursive union": "recursive_union",
  modifytable: "modify_table",
  "modify table": "modify_table",
  lockrows: "lock_rows",
  "lock rows": "lock_rows",
  projectset: "project_set",
  "project set": "project_set",
});

/**
 * Normalize a GaussDB/DWS parsed tree. Shared estimate fields and traversal are
 * reused from PostgreSQL, but native cost values remain engine-specific so no
 * PostgreSQL cost attribution or cost-based finding is inferred.
 *
 * @param {import("../postgres/parse-json-plan.js").ParsedPlan} parsed
 */
export function normalizeGaussdbPlan(parsed) {
  const postgresShape = normalizePostgresPlan({ ...parsed, database: "postgresql" });
  const unknownNodeTypes = new Set();
  const root = normalizeNode(parsed.root, postgresShape.root, "0", unknownNodeTypes);

  return {
    database: "gaussdb",
    mode: parsed.mode,
    format: parsed.format,
    root,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  };
}

/**
 * @param {import("../postgres/parse-json-plan.js").ParsedPlanNode} source
 * @param {import("./normalize-postgres.js").NormalizedNode} shared
 * @param {string} id
 * @param {Set<string>} unknownNodeTypes
 */
function normalizeNode(source, shared, id, unknownNodeTypes) {
  const normalizedType = source.nodeType.trim().replace(/\s+/g, " ").toLowerCase();
  const isStreaming = isStreamingNodeType(source.nodeType);
  const streamType = streamTypeOf(source.nodeType);
  const kind = isStreaming ? "exchange" : DWS_KIND_BY_NODE_TYPE[normalizedType] ?? "unknown";
  if (kind === "unknown") unknownNodeTypes.add(source.nodeType);

  return {
    ...shared,
    id,
    kind,
    nodeType: source.nodeType,
    // The source plan reports these estimates, but they are not exposed as
    // PostgreSQL-style cost signals or used in cross-engine attribution.
    startupCost: null,
    totalCost: null,
    children: source.children.map((child, index) =>
      normalizeNode(child, shared.children[index], `${id}.${index}`, unknownNodeTypes),
    ),
    engineSpecific: {
      database: "gaussdb",
      gaussdb: {
        streamType,
        startupCost: source.startupCost,
        totalCost: source.totalCost,
        groupByKey: source.groupKeys,
        mergeSortKey: source.extra["Merge Sort Key"] ?? null,
      },
      extra: source.extra,
    },
  };
}

/**
 * Streaming is preserved as an exchange. Its distribution detail is evidence,
 * not a claim that DWS's operation has PostgreSQL Gather semantics.
 * @param {string} nodeType
 * @returns {string|null}
 */
function isStreamingNodeType(nodeType) {
  return /^(?:vector\s+)?streaming(?:\s*\(\s*type\s*:\s*[^)]*\))?$/i.test(nodeType.trim().replace(/\s+/g, " "));
}

/** @param {string} nodeType @returns {string|null} */
function streamTypeOf(nodeType) {
  const match = nodeType.trim().replace(/\s+/g, " ").match(/^(?:vector\s+)?streaming\s*\(\s*type\s*:\s*([^)]*)\)$/i);
  return match?.[1]?.trim().toUpperCase() || null;
}
