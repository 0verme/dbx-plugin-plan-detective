import { createFinding, nodeEvidence } from "../findings/finding.js";
import { incrementalCostOf, walkNodes } from "../tree.js";
import { LARGE_SEQUENTIAL_SCAN } from "./thresholds.js";

const RULE_ID = "large-sequential-scan";

/**
 * Large sequential scan.
 *
 * Fires on a `Seq Scan` whose estimated row count or own (incremental) cost
 * reaches the configured threshold. Cost inherited from children does not
 * count, so a cheap scan under an expensive parent is not reported twice.
 *
 * The finding is an observation: it points at the node and its evidence and
 * leaves the conclusion (selectivity? missing index? intentional full scan?)
 * to the reader.
 */
export const largeSequentialScanRule = {
  id: RULE_ID,

  /**
   * @param {import("../normalize/normalize-postgres.js").NormalizedPlan} normalized
   * @returns {import("../findings/finding.js").Finding[]}
   */
  run(normalized) {
    const findings = [];
    for (const node of walkNodes(normalized.root)) {
      if (node.kind !== "seq_scan") continue;

      const estimatedRows = typeof node.estimatedRows === "number" ? node.estimatedRows : 0;
      const incrementalCost = incrementalCostOf(node) ?? 0;

      const reachesWarning =
        estimatedRows >= LARGE_SEQUENTIAL_SCAN.warningEstimatedRows ||
        incrementalCost >= LARGE_SEQUENTIAL_SCAN.warningIncrementalCost;
      if (!reachesWarning) continue;

      const reachesHigh =
        estimatedRows >= LARGE_SEQUENTIAL_SCAN.highEstimatedRows ||
        incrementalCost >= LARGE_SEQUENTIAL_SCAN.highIncrementalCost;

      findings.push(
        createFinding({
          ruleId: RULE_ID,
          severity: reachesHigh ? "high" : "warning",
          title: "Large sequential scan",
          summary: summarize(node, estimatedRows, incrementalCost),
          node,
          evidence: nodeEvidence(node, {
            incrementalCost,
            filter: node.filter,
            thresholds: {
              warningEstimatedRows: LARGE_SEQUENTIAL_SCAN.warningEstimatedRows,
              highEstimatedRows: LARGE_SEQUENTIAL_SCAN.highEstimatedRows,
              warningIncrementalCost: LARGE_SEQUENTIAL_SCAN.warningIncrementalCost,
              highIncrementalCost: LARGE_SEQUENTIAL_SCAN.highIncrementalCost,
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
 * @param {number} estimatedRows
 * @param {number} incrementalCost
 * @returns {string}
 */
function summarize(node, estimatedRows, incrementalCost) {
  const label = node.relation?.name ?? node.nodeType;
  const filterNote = node.filter === null ? " with no filter reported" : " with a filter";
  return (
    `Seq Scan on ${label}${filterNote} is estimated to read ${estimatedRows} rows ` +
    `and accounts for an incremental cost of ${incrementalCost}. ` +
    `Worth checking filter selectivity and available indexes before treating the scan as a problem.`
  );
}
