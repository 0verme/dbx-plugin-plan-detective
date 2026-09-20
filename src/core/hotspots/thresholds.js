/**
 * Deterministic hotspot thresholds.
 *
 * Hotspot signals answer "which nodes deserve attention first", so every
 * threshold is a named, reviewable constant. Row-based thresholds reuse the
 * existing rule thresholds on purpose: a node that trips a rule and the same
 * pattern as a hotspot must not disagree about what "large" means.
 *
 * Cost thresholds are engine-scoped and must never be compared across engines:
 * `postgresCost` uses PostgreSQL planner cost units, `mysqlCost` uses MySQL
 * cost units. Both are expressed as a *share* of a cost total that belongs to
 * the same plan, which keeps every comparison inside one engine and one plan.
 */

import { LARGE_SEQUENTIAL_SCAN, NESTED_LOOP_LARGE_INNER } from "../rules/thresholds.js";

export const HOTSPOT = Object.freeze({
  /**
   * Large sequential scan. PostgreSQL reads `Plan Rows`, MySQL reads
   * `rows_examined_per_scan`; both are planner estimates for one access.
   */
  largeSequentialScan: Object.freeze({
    warningEstimatedRows: LARGE_SEQUENTIAL_SCAN.warningEstimatedRows,
    highEstimatedRows: LARGE_SEQUENTIAL_SCAN.highEstimatedRows,
  }),

  /**
   * Nested loop amplification: the inner side is estimated to be re-scanned
   * for every outer row, so the row counts multiply.
   */
  nestedLoopAmplification: Object.freeze({
    minOuterEstimatedRows: NESTED_LOOP_LARGE_INNER.minOuterEstimatedRows,
    warningInnerEstimatedRows: NESTED_LOOP_LARGE_INNER.warningInnerEstimatedRows,
    highInnerEstimatedRows: NESTED_LOOP_LARGE_INNER.highInnerEstimatedRows,
  }),

  /**
   * PostgreSQL cost concentration: a node's own (incremental) cost relative to
   * the root Total Cost. Only used when the plan's cost accounting is
   * cumulative; see self-cost.js.
   */
  postgresCost: Object.freeze({
    minSelfCost: 100,
    warningShare: 0.25,
    highShare: 0.5,
  }),

  /**
   * MySQL cost concentration: one table access' `read_cost + eval_cost` share
   * of the enclosing query block's `query_cost`. MySQL cost units only.
   */
  mysqlCost: Object.freeze({
    minAccessCost: 100,
    minCostedAccessesPerBlock: 2,
    warningShare: 0.25,
    highShare: 0.5,
  }),

  /** MySQL row access without a full table scan (`access_type != ALL`). */
  mysqlRows: Object.freeze({
    warningRowsExamined: 10_000,
    highRowsExamined: 100_000,
  }),

  /**
   * MySQL condition filtering: a low `filtered` percentage means most examined
   * rows are discarded by the access condition.
   */
  mysqlFiltered: Object.freeze({
    warningFilteredPercent: 10,
    warningMinRowsExamined: 1_000,
    highFilteredPercent: 1,
    highMinRowsExamined: 100_000,
  }),

  /**
   * MySQL operation flags (`using_filesort`, `using_temporary_table`,
   * `using_join_buffer`). A flag is only worth attention when the operation's
   * subtree is large; the largest estimated row count in the subtree is the
   * deterministic magnitude.
   */
  mysqlFlags: Object.freeze({
    warningSubtreeRows: 10_000,
    highSubtreeRows: 100_000,
  }),
});
