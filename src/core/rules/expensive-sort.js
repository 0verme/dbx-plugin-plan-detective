import { createFinding, nodeEvidence } from "../findings/finding.js";
import { incrementalCostOf, walkOperatorNodes } from "../tree.js";
import { EXPENSIVE_SORT } from "./thresholds.js";

const RULE_ID = "expensive-sort";

/**
 * Expensive sort.
 *
 * Fires on Sort / Incremental Sort nodes whose own (incremental) cost clears
 * both the absolute floor and the minimum share of the plan's estimated total
 * cost. Using incremental cost matters: a cheap sort sitting on top of an
 * expensive child inherits a large total cost but is not itself expensive.
 *
 * Only fires when the plan reports costs; without cost data the rule stays
 * silent instead of guessing.
 */
export const expensiveSortRule = {
  id: RULE_ID,

  /**
   * @param {import("../normalize/normalize-postgres.js").NormalizedPlan} normalized
   * @param {import("../metrics/compute-metrics.js").PlanMetrics} metrics
   * @returns {import("../findings/finding.js").Finding[]}
   */
  run(normalized, metrics) {
    const totalPlanCost = metrics.totalEstimatedCost;
    if (typeof totalPlanCost !== "number" || totalPlanCost <= 0) return [];

    const findings = [];
    for (const node of walkOperatorNodes(normalized.root)) {
      if (node.kind !== "sort" && node.kind !== "incremental_sort") continue;

      const incrementalCost = incrementalCostOf(node);
      if (incrementalCost === null) continue;

      const costShare = round4(incrementalCost / totalPlanCost);
      if (incrementalCost < EXPENSIVE_SORT.minIncrementalCost || costShare < EXPENSIVE_SORT.minCostShare) continue;

      findings.push(
        createFinding({
          ruleId: RULE_ID,
          severity: "warning",
          title: "Expensive sort",
          summary: summarize(node, incrementalCost, costShare),
          node,
          evidence: nodeEvidence(node, {
            incrementalCost,
            costShare,
            totalPlanCost,
            sortKeys: node.sortKeys,
            thresholds: {
              minIncrementalCost: EXPENSIVE_SORT.minIncrementalCost,
              minCostShare: EXPENSIVE_SORT.minCostShare,
            },
          }),
        }),
      );
    }
    return findings;
  },
};

/**
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} node
 * @param {number} incrementalCost
 * @param {number} costShare
 * @returns {string}
 */
function summarize(node, incrementalCost, costShare) {
  const label = node.relation?.name ?? node.nodeType;
  return (
    `${node.nodeType} on ${label} is estimated to add ${incrementalCost} cost, ` +
    `about ${(costShare * 100).toFixed(1)}% of the plan's estimated total cost. ` +
    `The sort itself, not only its input, is a visible part of the estimate; ` +
    `worth checking whether the ordering is required and whether a suitable index exists.`
  );
}

/**
 * @param {number} value
 * @returns {number}
 */
function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}
