/**
 * Deterministic rule thresholds.
 *
 * Every threshold is a named constant with one purpose: make rules reviewable
 * and testable. They are deliberately conservative and expressed in planner
 * units (estimated rows, cost units), never in wall-clock time.
 *
 * These are heuristics, not laws: each rule states an observation plus its
 * thresholds in the finding evidence, so a reader can see exactly why it fired.
 */

/** Large sequential scan: a Seq Scan is worth attention at these estimates. */
export const LARGE_SEQUENTIAL_SCAN = Object.freeze({
  warningEstimatedRows: 10_000,
  highEstimatedRows: 100_000,
  warningIncrementalCost: 10_000,
  highIncrementalCost: 100_000,
});

/**
 * Expensive sort: the sort's own (incremental) cost must clear an absolute
 * floor and take a meaningful share of the plan's estimated total cost.
 * Cost inherited from the sort's input does not count.
 */
export const EXPENSIVE_SORT = Object.freeze({
  minIncrementalCost: 1_000,
  minCostShare: 0.25,
});

/**
 * Nested loop with a large inner estimate: the inner side is expected to be
 * re-scanned for every outer row, so the comparison count multiplies.
 */
export const NESTED_LOOP_LARGE_INNER = Object.freeze({
  minOuterEstimatedRows: 10,
  warningInnerEstimatedRows: 10_000,
  highInnerEstimatedRows: 100_000,
});
