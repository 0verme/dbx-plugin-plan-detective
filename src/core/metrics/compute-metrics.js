import { analyzePostgresCost } from "../cost/postgres-cost.js";
import { depthOf, flattenNodes } from "../tree.js";

/**
 * Deterministic plan metrics.
 *
 * Metrics are pure arithmetic over the normalized tree. They contain no score,
 * no ranking and no judgement: judgement belongs to the rules. Every value is
 * derived from fields the plan actually reported, and stays `null` when the
 * input did not.
 *
 * Cost-derived values first pass the PostgreSQL attribution envelope in
 * `../cost/postgres-cost.js`. When that envelope is not safe for the plan, the
 * metric is `null` and `costAttribution` states why, instead of publishing a
 * number the planner's own accounting does not support.
 */

const SCAN_KINDS = new Set([
  "seq_scan",
  "index_scan",
  "index_only_scan",
  "bitmap_heap_scan",
  "bitmap_index_scan",
  "tid_scan",
  "sample_scan",
]);
const INDEX_SCAN_KINDS = new Set(["index_scan", "index_only_scan"]);
const BITMAP_SCAN_KINDS = new Set(["bitmap_heap_scan", "bitmap_index_scan"]);
const JOIN_KINDS = new Set(["nested_loop", "hash_join", "merge_join", "join"]);
const SORT_KINDS = new Set(["sort", "incremental_sort"]);
const AGGREGATE_KINDS = new Set(["aggregate", "group"]);

/**
 * @typedef {Object} NodeSummary
 * @property {string} nodeId
 * @property {string} kind
 * @property {string} nodeType
 * @property {string|null} relation
 *
 * @typedef {NodeSummary & { estimatedRows: number }} LargestRowsSummary
 * @typedef {NodeSummary & { incrementalCost: number, totalCost: number }} HighestCostSummary
 *
 * @typedef {Object} CostAttribution
 * @property {string} engine database family the cost model belongs to
 * @property {"available"|"withheld"|"not-applicable"} status `not-applicable`
 *   means the metric is PostgreSQL-specific and this plan uses another engine
 * @property {string|null} reason stable reason code, `null` when available
 *
 * @typedef {Object} PlanMetrics
 * @property {number} nodeCount
 * @property {number} maxDepth
 * @property {number|null} totalEstimatedCost root Total Cost
 * @property {number|null} rootEstimatedRows rows the root is estimated to produce
 * @property {number} scanCount
 * @property {number} sequentialScanCount
 * @property {number} indexScanCount includes Index Only Scan
 * @property {number} bitmapScanCount Bitmap Heap Scan and Bitmap Index Scan nodes
 * @property {number} joinCount
 * @property {number} sortCount
 * @property {number} aggregateCount includes Group and Aggregate family nodes
 * @property {number} unknownNodeTypeCount
 * @property {LargestRowsSummary|null} largestEstimatedRows
 * @property {CostAttribution} costAttribution whether PostgreSQL cumulative
 *   cost attribution is safe for this plan; `highestIncrementalCost` is only
 *   ever filled when this says `available`
 * @property {HighestCostSummary|null} highestIncrementalCost attributable self
 *   cost of one node, or `null` when no trustworthy value exists
 */

/**
 * @param {import("../normalize/normalize-postgres.js").NormalizedPlan} normalized
 * @returns {PlanMetrics}
 */
export function computeMetrics(normalized) {
  const nodes = flattenNodes(normalized.root);
  const totalPlanCost = typeof normalized.root.totalCost === "number" ? normalized.root.totalCost : null;
  const cost = costAttributionOf(normalized, totalPlanCost);

  let scanCount = 0;
  let sequentialScanCount = 0;
  let indexScanCount = 0;
  let bitmapScanCount = 0;
  let joinCount = 0;
  let sortCount = 0;
  let aggregateCount = 0;
  /** @type {LargestRowsSummary|null} */
  let largestEstimatedRows = null;
  /** @type {HighestCostSummary|null} */
  let highestIncrementalCost = null;

  for (const node of nodes) {
    if (SCAN_KINDS.has(node.kind)) scanCount += 1;
    if (node.kind === "seq_scan") sequentialScanCount += 1;
    if (INDEX_SCAN_KINDS.has(node.kind)) indexScanCount += 1;
    if (BITMAP_SCAN_KINDS.has(node.kind)) bitmapScanCount += 1;
    if (JOIN_KINDS.has(node.kind)) joinCount += 1;
    if (SORT_KINDS.has(node.kind)) sortCount += 1;
    if (AGGREGATE_KINDS.has(node.kind)) aggregateCount += 1;

    if (typeof node.estimatedRows === "number") {
      if (largestEstimatedRows === null || node.estimatedRows > largestEstimatedRows.estimatedRows) {
        largestEstimatedRows = { ...summarize(node), estimatedRows: node.estimatedRows };
      }
    }

    const attributed = cost.byNodeId?.get(node.id);
    if (attributed !== undefined) {
      if (highestIncrementalCost === null || attributed.selfCost > highestIncrementalCost.incrementalCost) {
        highestIncrementalCost = { ...summarize(node), incrementalCost: attributed.selfCost, totalCost: node.totalCost };
      }
    }
  }

  return {
    nodeCount: nodes.length,
    maxDepth: depthOf(normalized.root),
    totalEstimatedCost: totalPlanCost,
    rootEstimatedRows: typeof normalized.root.estimatedRows === "number" ? normalized.root.estimatedRows : null,
    scanCount,
    sequentialScanCount,
    indexScanCount,
    bitmapScanCount,
    joinCount,
    sortCount,
    aggregateCount,
    unknownNodeTypeCount: normalized.unknownNodeTypes.length,
    largestEstimatedRows,
    costAttribution: cost.summary,
    highestIncrementalCost,
  };
}

/**
 * Decide whether PostgreSQL cumulative-cost attribution is safe for this plan,
 * and hand back the attributable self cost per node when it is.
 *
 * The Hotspot stage consumes the very same envelope for `hotspots.cost`, so the
 * two stages can never disagree about whether a plan's cost signal is usable.
 * Only nodes returned in `byNodeId` may back `highestIncrementalCost`: a child
 * without a Total Cost is not counted as `0`, and nodes below a truncating node
 * (a `Limit` with a negative self cost) are not comparable with the root total.
 *
 * @param {import("../normalize/normalize-postgres.js").NormalizedPlan} normalized
 * @param {number|null} totalPlanCost
 * @returns {{ summary: CostAttribution, byNodeId: Map<string, { selfCost: number, selfCostShare: number }>|null }}
 */
function costAttributionOf(normalized, totalPlanCost) {
  if (normalized.database !== "postgresql") {
    // Self cost is a PostgreSQL cumulative-Total-Cost concept. MySQL reports
    // its costs inside `engineSpecific.mysql` and never fills `totalCost`, so
    // no other family may inherit a PostgreSQL incremental-cost value.
    return {
      summary: { engine: normalized.database, status: "not-applicable", reason: "NOT_POSTGRES_COST_MODEL" },
      byNodeId: null,
    };
  }

  const attribution = analyzePostgresCost(normalized.root, totalPlanCost);
  if (attribution.status === "withheld") {
    return { summary: { engine: "postgresql", status: "withheld", reason: attribution.reason }, byNodeId: null };
  }

  if (attribution.byNodeId.size === 0) {
    // The envelope is reliable, but every node truncated its children (for
    // example a `Limit` root), so no node owns an attributable self cost.
    return { summary: { engine: "postgresql", status: "withheld", reason: "NO_ATTRIBUTABLE_COST" }, byNodeId: null };
  }

  return { summary: { engine: "postgresql", status: "available", reason: null }, byNodeId: attribution.byNodeId };
}

/**
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} node
 * @returns {NodeSummary}
 */
function summarize(node) {
  return {
    nodeId: node.id,
    kind: node.kind,
    nodeType: node.nodeType,
    relation: node.relation?.name ?? null,
  };
}
