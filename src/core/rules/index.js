import { expensiveSortRule } from "./expensive-sort.js";
import { largeSequentialScanRule } from "./large-sequential-scan.js";
import { nestedLoopLargeInnerRule } from "./nested-loop-large-inner.js";

/**
 * All deterministic rules, in a fixed order.
 *
 * Adding a rule means adding it here; findings stay deterministic because the
 * rule order is fixed and each rule walks the tree in pre-order.
 */
export const RULES = Object.freeze([largeSequentialScanRule, expensiveSortRule, nestedLoopLargeInnerRule]);

/**
 * Run every rule and concatenate the findings.
 *
 * @param {import("../normalize/normalize-postgres.js").NormalizedPlan} normalized
 * @param {import("../metrics/compute-metrics.js").PlanMetrics} metrics
 * @returns {import("../findings/finding.js").Finding[]}
 */
export function runRules(normalized, metrics) {
  const findings = [];
  for (const rule of RULES) {
    findings.push(...rule.run(normalized, metrics));
  }
  return findings;
}
