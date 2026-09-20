import assert from "node:assert/strict";
import test from "node:test";
import { computeMetrics } from "../../src/core/metrics/compute-metrics.js";
import { runRules } from "../../src/core/rules/index.js";
import { expensiveSortRule } from "../../src/core/rules/expensive-sort.js";
import { largeSequentialScanRule } from "../../src/core/rules/large-sequential-scan.js";
import { nestedLoopLargeInnerRule } from "../../src/core/rules/nested-loop-large-inner.js";
import { normalizedNode, normalizedPlan } from "../helpers/plan-builders.js";

/**
 * @param {any} root
 * @returns {any[]} findings for a plan whose root is `root`
 */
function run(rule, root, mode = "estimated") {
  const plan = normalizedPlan({ mode, root });
  return rule.run(plan, computeMetrics(plan));
}

test("large-sequential-scan stays silent below both thresholds", () => {
  const root = normalizedNode({ kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 9_999, totalCost: 9_999 });
  assert.deepEqual(run(largeSequentialScanRule, root), []);
});

test("large-sequential-scan reports a warning at the row threshold", () => {
  const root = normalizedNode({
    kind: "seq_scan",
    nodeType: "Seq Scan",
    relation: { name: "pd_fix_events", alias: "e", indexName: null },
    estimatedRows: 10_000,
    totalCost: 100,
  });

  const [finding] = run(largeSequentialScanRule, root);
  assert.equal(finding.id, "large-sequential-scan:0");
  assert.equal(finding.severity, "warning");
  assert.equal(finding.nodeRef, "0");
  assert.equal(finding.evidence.relation, "pd_fix_events");
  assert.equal(finding.evidence.estimatedRows, 10_000);
  assert.equal(finding.evidence.incrementalCost, 100);
  assert.equal(finding.evidence.filter, null);
  assert.equal(finding.evidence.thresholds.warningEstimatedRows, 10_000);
});

test("large-sequential-scan escalates to high at the high row threshold", () => {
  const root = normalizedNode({ kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 100_000, totalCost: 100 });
  const [finding] = run(largeSequentialScanRule, root);
  assert.equal(finding.severity, "high");
});

test("large-sequential-scan can be triggered by cost alone when rows are unknown", () => {
  const warning = normalizedNode({ kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: null, totalCost: 10_000 });
  assert.equal(run(largeSequentialScanRule, warning)[0]?.severity, "warning");

  const high = normalizedNode({ kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: null, totalCost: 100_000 });
  assert.equal(run(largeSequentialScanRule, high)[0]?.severity, "high");
});

test("large-sequential-scan does not treat a missing cost as zero", () => {
  // MySQL table scans map to `seq_scan` but carry no PostgreSQL-style cost;
  // the row branch must still fire and must not print a fabricated 0.
  const root = normalizedNode({
    kind: "seq_scan",
    nodeType: "Table Scan",
    relation: { name: "events", alias: null, indexName: null },
    estimatedRows: 20_000,
    totalCost: null,
  });

  const [finding] = run(largeSequentialScanRule, root);
  assert.equal(finding.severity, "warning");
  assert.equal(finding.nodeRef, "0");
  assert.equal(finding.evidence.incrementalCost, null);
  assert.equal(finding.evidence.estimatedTotalCost, null);
  assert.match(finding.summary, /^Table Scan on events/);
  assert.match(finding.summary, /does not report a cost estimate/);
  assert.doesNotMatch(finding.summary, /incremental cost of 0/);
});

test("large-sequential-scan cannot trigger on cost when the plan reports none", () => {
  const root = normalizedNode({ kind: "seq_scan", nodeType: "Table Scan", estimatedRows: null, totalCost: null });
  assert.deepEqual(run(largeSequentialScanRule, root), []);
});

test("large-sequential-scan uses incremental cost, not the parent's cost", () => {
  const root = normalizedNode({
    kind: "sort",
    nodeType: "Sort",
    totalCost: 20_000,
    children: [normalizedNode({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 500, totalCost: 100 })],
  });
  assert.deepEqual(run(largeSequentialScanRule, root), []);
});

test("large-sequential-scan ignores known node types that are not sequential scans", () => {
  const root = normalizedNode({ kind: "index_scan", nodeType: "Index Scan", estimatedRows: 1_000_000, totalCost: 1_000_000 });
  assert.deepEqual(run(largeSequentialScanRule, root), []);
});

test("expensive-sort stays silent below the absolute cost floor", () => {
  const root = normalizedNode({ kind: "sort", nodeType: "Sort", totalCost: 999, estimatedRows: 100 });
  assert.deepEqual(run(expensiveSortRule, root), []);
});

test("expensive-sort needs both the absolute cost and the plan share", () => {
  const dominant = normalizedNode({ kind: "sort", nodeType: "Sort", totalCost: 3_000, estimatedRows: 10_000 });
  assert.equal(run(expensiveSortRule, dominant)[0]?.severity, "warning");

  const smallShare = normalizedNode({
    kind: "sort",
    nodeType: "Sort",
    totalCost: 100_000,
    children: [normalizedNode({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 97_000, estimatedRows: 500_000 })],
  });
  assert.deepEqual(run(expensiveSortRule, smallShare), [], "a sort worth 3% of the plan is not reported");
});

test("expensive-sort ignores cost inherited from its input", () => {
  const root = normalizedNode({
    kind: "sort",
    nodeType: "Sort",
    totalCost: 29_000,
    estimatedRows: 200_000,
    children: [normalizedNode({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 26_000, estimatedRows: 200_000 })],
  });
  assert.deepEqual(run(expensiveSortRule, root), [], "only the sort's own 3000 cost may count, which is under the share");
});

test("expensive-sort exposes its evidence when it fires", () => {
  const root = normalizedNode({
    kind: "sort",
    nodeType: "Sort",
    relation: { name: "pd_fix_events", alias: "e", indexName: null },
    totalCost: 10_000,
    estimatedRows: 200_000,
    sortKeys: ["total DESC"],
    children: [normalizedNode({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 2_000, estimatedRows: 200_000 })],
  });

  const [finding] = run(expensiveSortRule, root);
  assert.equal(finding.id, "expensive-sort:0");
  assert.equal(finding.evidence.incrementalCost, 8_000);
  assert.equal(finding.evidence.costShare, 0.8);
  assert.equal(finding.evidence.totalPlanCost, 10_000);
  assert.deepEqual(finding.evidence.sortKeys, ["total DESC"]);
});

test("expensive-sort stays silent without cost data", () => {
  const root = normalizedNode({ kind: "sort", nodeType: "Sort", totalCost: null, estimatedRows: 10_000 });
  assert.deepEqual(run(expensiveSortRule, root), []);
});

test("nested-loop-large-inner fires on a large inner estimate", () => {
  const root = normalizedNode({
    kind: "nested_loop",
    nodeType: "Nested Loop",
    totalCost: 1_166_072,
    children: [
      normalizedNode({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 200, totalCost: 4 }),
      normalizedNode({ id: "0.1", kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 66_667, totalCost: 4_497 }),
    ],
  });

  const [finding] = run(nestedLoopLargeInnerRule, root);
  assert.equal(finding.id, "nested-loop-large-inner:0");
  assert.equal(finding.severity, "warning");
  assert.equal(finding.evidence.outerNodeRef, "0.0");
  assert.equal(finding.evidence.innerNodeRef, "0.1");
  assert.equal(finding.evidence.outerEstimatedRows, 200);
  assert.equal(finding.evidence.innerEstimatedRows, 66_667);
  assert.equal(finding.evidence.estimatedRowComparisons, 13_333_400);
  assert.equal(finding.evidence.actualLoops, null);
  assert.equal(finding.evidence.estimateOnly, true);
  assert.match(finding.summary, /no runtime loop count/);
});

test("nested-loop-large-inner stays silent when the outer side is tiny", () => {
  const root = normalizedNode({
    kind: "nested_loop",
    nodeType: "Nested Loop",
    children: [
      normalizedNode({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 5 }),
      normalizedNode({ id: "0.1", kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 500_000 }),
    ],
  });
  assert.deepEqual(run(nestedLoopLargeInnerRule, root), []);
});

test("nested-loop-large-inner escalates to high and reports actual loops in actual mode", () => {
  const root = normalizedNode({
    kind: "nested_loop",
    nodeType: "Nested Loop",
    loops: 80,
    children: [
      normalizedNode({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 1_000 }),
      normalizedNode({ id: "0.1", kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 100_000 }),
    ],
  });

  const [finding] = run(nestedLoopLargeInnerRule, root, "actual");
  assert.equal(finding.severity, "high");
  assert.equal(finding.evidence.estimateOnly, false);
  assert.equal(finding.evidence.actualLoops, 80);
  assert.match(finding.summary, /80 actual loops/);
});

test("nested-loop-large-inner tolerates a malformed child list instead of failing", () => {
  const root = normalizedNode({ kind: "nested_loop", nodeType: "Nested Loop", children: [] });
  assert.deepEqual(run(nestedLoopLargeInnerRule, root), []);
});

test("runRules returns findings in a fixed rule order with deterministic ids", () => {
  const root = normalizedNode({
    kind: "sort",
    nodeType: "Sort",
    totalCost: 10_000,
    estimatedRows: 200_000,
    children: [normalizedNode({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 2_000, estimatedRows: 200_000 })],
  });
  const plan = normalizedPlan({ root });
  const findings = runRules(plan, computeMetrics(plan));

  assert.deepEqual(
    findings.map((finding) => finding.id),
    ["large-sequential-scan:0.0", "expensive-sort:0"],
  );
});
