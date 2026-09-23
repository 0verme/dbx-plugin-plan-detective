import { createFinding, nodeEvidence } from "../findings/finding.js";
import { incrementalCostOf, walkOperatorNodes } from "../tree.js";
import { LARGE_SEQUENTIAL_SCAN } from "./thresholds.js";

const RULE_ID = "large-sequential-scan";

/**
 * Large sequential scan.
 *
 * Fires on a `seq_scan` whose estimated row count or own (incremental) cost
 * reaches the configured threshold. Cost inherited from children does not
 * count, so a cheap scan under an expensive parent is not reported twice.
 *
 * The row branch works for every engine whose table scan maps to `seq_scan`
 * (PostgreSQL `Seq Scan`, MySQL `access_type = ALL`). The cost branch only
 * applies when the node reports a total cost: MySQL cost is a different model,
 * stays under `engineSpecific`, and must never be compared against these
 * PostgreSQL-unit thresholds.
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
    for (const node of walkOperatorNodes(normalized.root)) {
      if (node.kind !== "seq_scan") continue;

      const estimatedRows = typeof node.estimatedRows === "number" ? node.estimatedRows : 0;
      // `null` means the plan reported no cost. It is not a cost of 0 and must
      // not be presented as one; only a real cost can reach a cost threshold.
      const incrementalCost = incrementalCostOf(node);

      const reachesWarning =
        estimatedRows >= LARGE_SEQUENTIAL_SCAN.warningEstimatedRows ||
        (incrementalCost !== null && incrementalCost >= LARGE_SEQUENTIAL_SCAN.warningIncrementalCost);
      if (!reachesWarning) continue;

      const reachesHigh =
        estimatedRows >= LARGE_SEQUENTIAL_SCAN.highEstimatedRows ||
        (incrementalCost !== null && incrementalCost >= LARGE_SEQUENTIAL_SCAN.highIncrementalCost);

      findings.push(
        createFinding({
          ruleId: RULE_ID,
          severity: reachesHigh ? "high" : "warning",
          title: "Large sequential scan",
          summary: summarize(node, estimatedRows, incrementalCost),
          node,
          facts: {
            database: normalized.database,
            mode: normalized.mode,
            runtimeVerified: normalized.mode === "actual",
            nodeType: node.nodeType,
            relation: node.relation?.name ?? null,
            estimatedRows: node.estimatedRows,
            estimatedTotalCost: node.totalCost,
            incrementalCost,
            accessType: node.engineSpecific?.mysql?.accessType ?? null,
            hasFilter: node.filter !== null && node.filter !== undefined,
          },
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
 * @param {number|null} incrementalCost own cost, or null when the plan reports none
 * @returns {string}
 */
function summarize(node, estimatedRows, incrementalCost) {
  const label = node.relation?.name ?? node.nodeType;
  const filterNote = node.filter === null ? " with no filter reported" : " with a filter";
  // `node.nodeType` is the engine's own label: "Seq Scan" for PostgreSQL,
  // "Table Scan" for MySQL. The rule must not put PostgreSQL vocabulary into a
  // MySQL finding.
  const costNote =
    incrementalCost === null
      ? " and this plan does not report a cost estimate for this node."
      : ` and accounts for an incremental cost of ${incrementalCost}.`;
  return (
    `${node.nodeType} on ${label}${filterNote} is estimated to read ${estimatedRows} rows` +
    `${costNote} ` +
    `Worth checking filter selectivity and available indexes before treating the scan as a problem.`
  );
}
