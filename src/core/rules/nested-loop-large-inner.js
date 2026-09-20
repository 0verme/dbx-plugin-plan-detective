import { createFinding, nodeEvidence } from "../findings/finding.js";
import { walkNodes } from "../tree.js";
import { NESTED_LOOP_LARGE_INNER } from "./thresholds.js";

const RULE_ID = "nested-loop-large-inner";

/**
 * Nested loop with a large inner estimate.
 *
 * The inner side of a Nested Loop is expected to be re-scanned for every outer
 * row, so the planner's estimated row counts multiply:
 *
 *     estimated row comparisons ~= outer estimated rows * inner estimated rows
 *
 * This rule uses estimated rows only. It does not claim a runtime loop count:
 * `estimatedRowComparisons` is a derived estimate, and in estimated mode there
 * is no `Actual Loops` value to report.
 */
export const nestedLoopLargeInnerRule = {
  id: RULE_ID,

  /**
   * @param {import("../normalize/normalize-postgres.js").NormalizedPlan} normalized
   * @returns {import("../findings/finding.js").Finding[]}
   */
  run(normalized) {
    const findings = [];
    for (const node of walkNodes(normalized.root)) {
      if (node.kind !== "nested_loop") continue;

      const [outer, inner] = node.children;
      if (outer === undefined || inner === undefined) continue;

      const outerEstimatedRows = typeof outer.estimatedRows === "number" ? outer.estimatedRows : 0;
      const innerEstimatedRows = typeof inner.estimatedRows === "number" ? inner.estimatedRows : 0;

      if (outerEstimatedRows < NESTED_LOOP_LARGE_INNER.minOuterEstimatedRows) continue;
      if (innerEstimatedRows < NESTED_LOOP_LARGE_INNER.warningInnerEstimatedRows) continue;

      const reachesHigh = innerEstimatedRows >= NESTED_LOOP_LARGE_INNER.highInnerEstimatedRows;

      findings.push(
        createFinding({
          ruleId: RULE_ID,
          severity: reachesHigh ? "high" : "warning",
          title: "Nested loop with a large inner estimate",
          summary: summarize(normalized, node, outerEstimatedRows, innerEstimatedRows),
          node,
          evidence: nodeEvidence(node, {
            outerNodeRef: outer.id,
            innerNodeRef: inner.id,
            outerEstimatedRows,
            innerEstimatedRows,
            estimatedRowComparisons: outerEstimatedRows * innerEstimatedRows,
            actualLoops: node.loops,
            estimateOnly: normalized.mode === "estimated",
            thresholds: {
              minOuterEstimatedRows: NESTED_LOOP_LARGE_INNER.minOuterEstimatedRows,
              warningInnerEstimatedRows: NESTED_LOOP_LARGE_INNER.warningInnerEstimatedRows,
              highInnerEstimatedRows: NESTED_LOOP_LARGE_INNER.highInnerEstimatedRows,
            },
          }),
        }),
      );
    }
    return findings;
  },
};

/**
 * @param {import("../normalize/normalize-postgres.js").NormalizedPlan} normalized
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} node
 * @param {number} outerEstimatedRows
 * @param {number} innerEstimatedRows
 * @returns {string}
 */
function summarize(normalized, node, outerEstimatedRows, innerEstimatedRows) {
  const comparisons = outerEstimatedRows * innerEstimatedRows;
  const runtimeNote =
    normalized.mode === "estimated"
      ? "These are planner estimates; no runtime loop count is available for this plan."
      : `The plan reports ${node.loops} actual loops for this node.`;
  return (
    `Nested Loop is estimated to combine ${outerEstimatedRows} outer rows with an inner side estimated at ` +
    `${innerEstimatedRows} rows, about ${comparisons} estimated row comparisons. ` +
    `The inner side is expected to be re-scanned for every outer row. ${runtimeNote}`
  );
}
