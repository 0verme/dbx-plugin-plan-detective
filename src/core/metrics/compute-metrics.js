import { depthOf, flattenNodes, incrementalCostOf } from "../tree.js";

/**
 * Deterministic plan metrics.
 *
 * Metrics are pure arithmetic over the normalized tree. They contain no score,
 * no ranking and no judgement: judgement belongs to the rules. Every value is
 * derived from fields the plan actually reported, and stays `null` when the
 * input did not.
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
const JOIN_KINDS = new Set(["nested_loop", "hash_join", "merge_join"]);
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
 * @property {HighestCostSummary|null} highestIncrementalCost
 */

/**
 * @param {import("../normalize/normalize-postgres.js").NormalizedPlan} normalized
 * @returns {PlanMetrics}
 */
export function computeMetrics(normalized) {
  const nodes = flattenNodes(normalized.root);

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

    const incrementalCost = incrementalCostOf(node);
    if (incrementalCost !== null && typeof node.totalCost === "number") {
      if (highestIncrementalCost === null || incrementalCost > highestIncrementalCost.incrementalCost) {
        highestIncrementalCost = { ...summarize(node), incrementalCost, totalCost: node.totalCost };
      }
    }
  }

  return {
    nodeCount: nodes.length,
    maxDepth: depthOf(normalized.root),
    totalEstimatedCost: typeof normalized.root.totalCost === "number" ? normalized.root.totalCost : null,
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
    highestIncrementalCost,
  };
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
