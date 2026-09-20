import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { formatNumber, formatPercent, formatRawValue } from "../../src/lib/format.js";
import {
  buildFindingViews,
  buildNodeInspector,
  buildPlanSummary,
  buildTreeRows,
  countFindingsBySeverity,
  describeNodeRef,
  expandAncestors,
  groupFindingsByNodeRef,
  indexNodesById,
  indexRowsById,
  nodeLabel,
  sortFindings,
  toggleCollapsed,
  visibleTreeRows,
} from "../../src/lib/view-model.js";
import { loadFixture } from "../helpers/fixtures.js";

/**
 * These tests cover the pure UI mapping layer only: the UI must render what
 * the offline core produced, without recomputing metrics or inventing values.
 */

const nestedLoop = await loadFixture({ mode: "estimated", name: "nested-loop-large-inner" });
const nestedLoopAnalysis = analyzePlan(nestedLoop.input);
const nestedLoopRows = buildTreeRows(nestedLoopAnalysis.normalized.root);
const nestedLoopRowsById = indexRowsById(nestedLoopRows);

const largeSeqScan = await loadFixture({ mode: "estimated", name: "large-seq-scan" });
const largeSeqScanAnalysis = analyzePlan(largeSeqScan.input);

const actualLoops = await loadFixture({ mode: "actual", name: "nested-loop-loops" });
const actualLoopsAnalysis = analyzePlan(actualLoops.input);

const expensiveSort = await loadFixture({ mode: "estimated", name: "expensive-sort" });
const expensiveSortAnalysis = analyzePlan(expensiveSort.input);

/* ------------------------------------------------------------------ format -- */

test("formatNumber keeps integers readable and trims fractional noise", () => {
  assert.equal(formatNumber(3497), "3,497");
  assert.equal(formatNumber(26394.64), "26,394.64");
  assert.equal(formatNumber(0), "0");
  assert.equal(formatNumber(null), null);
  assert.equal(formatNumber(Number.NaN), null);
  assert.equal(formatNumber("42"), null);
});

test("formatPercent renders a fraction as a percentage", () => {
  assert.equal(formatPercent(0.868), "86.8%");
  assert.equal(formatPercent(0.25), "25.0%");
  assert.equal(formatPercent(null), null);
});

test("formatRawValue handles engine values without losing information", () => {
  assert.equal(formatRawValue("Forward"), "Forward");
  assert.equal(formatRawValue(""), null);
  assert.equal(formatRawValue(false), "false");
  assert.equal(formatRawValue(["a", "b"]), "a, b");
  assert.equal(formatRawValue([]), null);
  assert.equal(formatRawValue({ nested: 1 }), '{"nested":1}');
  assert.equal(formatRawValue(null), null);
});

/* ----------------------------------------------------------------- summary -- */

test("buildPlanSummary shows the core metrics verbatim", () => {
  const summary = buildPlanSummary(largeSeqScanAnalysis.metrics);
  const byKey = new Map(summary.rows.map((row) => [row.key, row.value]));

  assert.equal(summary.rows.length, 11);
  assert.equal(byKey.get("totalEstimatedCost"), "3,497");
  assert.equal(byKey.get("rootEstimatedRows"), "200,000");
  assert.equal(byKey.get("nodeCount"), "1");
  assert.equal(byKey.get("maxDepth"), "1");
  assert.equal(byKey.get("scanCount"), "1");
  assert.equal(byKey.get("sequentialScanCount"), "1");
  assert.equal(byKey.get("indexScanCount"), "0");
  assert.equal(byKey.get("joinCount"), "0");
  assert.equal(byKey.get("sortCount"), "0");
  assert.equal(byKey.get("aggregateCount"), "0");
  assert.equal(byKey.get("unknownNodeTypeCount"), "0");

  const [largestRows, highestCost] = summary.highlights;
  assert.equal(largestRows.value, "200,000");
  assert.equal(largestRows.node.nodeId, "0");
  assert.equal(largestRows.node.relation, "pd_fix_events");
  assert.equal(highestCost.value, "3,497");
  assert.equal(highestCost.detail, "node total cost 3,497");
});

test("buildPlanSummary tolerates missing metric values without inventing numbers", () => {
  const summary = buildPlanSummary({
    ...largeSeqScanAnalysis.metrics,
    totalEstimatedCost: null,
    rootEstimatedRows: null,
    largestEstimatedRows: null,
    highestIncrementalCost: null,
  });
  const byKey = new Map(summary.rows.map((row) => [row.key, row.value]));

  assert.equal(byKey.get("totalEstimatedCost"), null);
  assert.equal(byKey.get("rootEstimatedRows"), null);
  assert.equal(summary.highlights.every((highlight) => highlight.value === null && highlight.node === null), true);
  assert.equal(buildPlanSummary({}).rows.length, 11);
});

/* -------------------------------------------------------------------- tree -- */

test("buildTreeRows flattens the normalized tree in pre-order with stable ids", () => {
  assert.deepEqual(
    nestedLoopRows.map((row) => row.id),
    ["0", "0.0", "0.1"],
  );
  assert.deepEqual(
    nestedLoopRows.map((row) => row.depth),
    [0, 1, 1],
  );
  assert.deepEqual(
    nestedLoopRows.map((row) => row.parentId),
    [null, "0", "0"],
  );
  assert.deepEqual(nestedLoopRows[2].ancestorIds, ["0"]);
  assert.deepEqual(
    nestedLoopRows.map((row) => row.hasChildren),
    [true, false, false],
  );
  assert.equal(nestedLoopRows[0].label, "Nested Loop");
  assert.equal(nestedLoopRows[1].label, "Seq Scan · pd_fix_customers [c]");
});

test("nodeLabel keeps scan target and index name visible", () => {
  assert.equal(nodeLabel({ nodeType: "Sort", relation: null }), "Sort");
  assert.equal(
    nodeLabel({
      nodeType: "Index Scan",
      relation: { name: "pd_fix_orders", alias: "o", indexName: "pd_fix_orders_pkey" },
    }),
    "Index Scan · pd_fix_orders [o] via pd_fix_orders_pkey",
  );
  assert.equal(
    nodeLabel({ nodeType: "Seq Scan", relation: { name: "t", alias: "t", indexName: null } }),
    "Seq Scan · t",
  );
});

test("visibleTreeRows hides descendants of collapsed nodes only", () => {
  assert.equal(visibleTreeRows(nestedLoopRows, new Set()).length, 3);
  assert.deepEqual(
    visibleTreeRows(nestedLoopRows, new Set(["0"])).map((row) => row.id),
    ["0"],
  );
  assert.deepEqual(
    visibleTreeRows(nestedLoopRows, new Set(["0.0"])).map((row) => row.id),
    ["0", "0.0", "0.1"],
  );
});

test("toggleCollapsed returns a new set and never mutates the input", () => {
  const original = new Set(["0.1"]);
  const collapsed = toggleCollapsed(original, "0");

  assert.deepEqual([...collapsed].sort(), ["0", "0.1"]);
  assert.deepEqual([...original], ["0.1"]);

  const expanded = toggleCollapsed(collapsed, "0");
  assert.deepEqual([...expanded], ["0.1"]);
});

test("expandAncestors reveals a node without touching unrelated collapse state", () => {
  const collapsed = new Set(["0", "0.0", "other"]);
  const expanded = expandAncestors(collapsed, nestedLoopRows[2]);

  assert.deepEqual([...expanded].sort(), ["0.0", "other"]);
  assert.equal(expandAncestors(collapsed, undefined), collapsed);
});

/* ---------------------------------------------------------------- findings -- */

test("sortFindings orders by severity and keeps rule order as tie-breaker", () => {
  const findings = [
    { id: "a", severity: "warning" },
    { id: "b", severity: "high" },
    { id: "c", severity: "info" },
    { id: "d", severity: "warning" },
  ];
  assert.deepEqual(
    sortFindings(findings).map((finding) => finding.id),
    ["b", "a", "d", "c"],
  );
});

test("countFindingsBySeverity and groupFindingsByNodeRef summarize without re-running rules", () => {
  const counts = countFindingsBySeverity(nestedLoopAnalysis.findings);
  assert.deepEqual(counts, { high: 0, warning: 2, info: 0, total: 2 });

  const grouped = groupFindingsByNodeRef(nestedLoopAnalysis.findings);
  assert.deepEqual(grouped.get("0"), { count: 1, severity: "warning" });
  assert.deepEqual(grouped.get("0.1"), { count: 1, severity: "warning" });

  const highGrouped = groupFindingsByNodeRef([
    { nodeRef: "0", severity: "warning" },
    { nodeRef: "0", severity: "high" },
  ]);
  assert.deepEqual(highGrouped.get("0"), { count: 2, severity: "high" });
});

test("buildFindingViews keeps rule semantics and renders node labels", () => {
  const views = buildFindingViews(nestedLoopAnalysis.findings, nestedLoopRowsById);
  const ruleIds = views.map((view) => view.ruleId).sort();

  assert.deepEqual(ruleIds, ["large-sequential-scan", "nested-loop-large-inner"]);
  assert.equal(views.every((view) => view.severity === "warning"), true);
  assert.equal(views.every((view) => view.nodeLabel.startsWith(`${view.nodeRef} · `)), true);

  const nestedLoopView = views.find((view) => view.ruleId === "nested-loop-large-inner");
  assert.equal(nestedLoopView.summary.includes("estimated row comparisons"), true);
  assert.equal(nestedLoopView.summary.includes("should create an index"), false);
});

test("flattenEvidence exposes thresholds with their path and keeps null meaningful", () => {
  const views = buildFindingViews(nestedLoopAnalysis.findings, nestedLoopRowsById);
  const view = views.find((finding) => finding.ruleId === "nested-loop-large-inner");
  const byPath = new Map(view.evidence.map((row) => [row.path, row]));

  assert.equal(byPath.get("thresholds.warningInnerEstimatedRows").value, "10,000");
  assert.equal(byPath.get("thresholds.warningInnerEstimatedRows").depth, 1);
  assert.equal(byPath.get("estimateOnly").value, "true");
  assert.equal(byPath.get("actualLoops").value, "—");
  assert.equal(byPath.get("relation").value, "—");
});

test("flattenEvidence renders cost shares as percentages", () => {
  const views = buildFindingViews(expensiveSortAnalysis.findings, indexRowsById(buildTreeRows(expensiveSortAnalysis.normalized.root)));
  const view = views.find((finding) => finding.ruleId === "expensive-sort");
  const byPath = new Map(view.evidence.map((row) => [row.path, row.value]));

  assert.match(byPath.get("costShare"), /^\d+(\.\d+)?%$/);
  assert.equal(byPath.get("thresholds.minCostShare"), "25.0%");
});

test("indexNodesById gives every normalized node a stable lookup entry", () => {
  const nodes = indexNodesById(nestedLoopAnalysis.normalized.root);

  assert.deepEqual([...nodes.keys()], ["0", "0.0", "0.1"]);
  assert.equal(nodes.get("0.1").nodeType, "Seq Scan");
});

test("describeNodeRef falls back to the raw reference when the row is unknown", () => {
  assert.equal(describeNodeRef(nestedLoopRowsById, "9.9"), "9.9");
  assert.match(describeNodeRef(nestedLoopRowsById, "0.0"), /^0\.0 · Seq Scan/);
});

/* --------------------------------------------------------------- inspector -- */

test("buildNodeInspector omits unavailable values instead of showing null noise", () => {
  const inspector = buildNodeInspector(nestedLoopAnalysis.normalized.root.children[0]);
  const groupKeys = inspector.groups.map((group) => group.key);
  const allLabels = inspector.groups.flatMap((group) => group.fields.map((field) => field.label));

  assert.deepEqual(groupKeys, ["identity", "estimates", "engine"]);
  assert.equal(allLabels.includes("Actual Rows"), false);
  assert.equal(allLabels.includes("Filter"), false);
  assert.equal(allLabels.includes("Index Name"), false);
  assert.equal(allLabels.includes("Plan Width"), true);
  assert.equal(inspector.title, "Seq Scan · pd_fix_customers [c]");
  assert.equal(inspector.subtitle, "seq_scan · alias c");
});

test("buildNodeInspector shows actual-execution fields for actual plans", () => {
  const indexScan = actualLoopsAnalysis.normalized.root.children[1].children[0];
  const inspector = buildNodeInspector(indexScan);
  const fields = new Map(inspector.groups.flatMap((group) => group.fields).map((field) => [field.label, field.value]));

  assert.equal(fields.get("Actual Rows"), "1");
  assert.equal(fields.get("Actual Loops"), "80");
  assert.equal(fields.get("Filter"), "(customer_id = c.id)");
  assert.equal(fields.get("Index Name"), "pd_fix_orders_pkey");
  assert.equal(fields.get("Incremental Cost"), "155.28");
  assert.equal(fields.get("Scan Direction"), "Forward");
});

test("buildNodeInspector keeps engine-specific booleans only when meaningful", () => {
  const inspector = buildNodeInspector(actualLoopsAnalysis.normalized.root);
  const fields = new Map(inspector.groups.flatMap((group) => group.fields).map((field) => [field.label, field.value]));

  assert.equal(fields.get("Parallel Aware"), undefined);
  assert.equal(fields.get("Inner Unique"), "false");
  assert.equal(buildNodeInspector(null), null);
});

/* ------------------------------------------------------------------ extras -- */

test("view-model works on every committed fixture", async () => {
  const { loadAllFixtures } = await import("../helpers/fixtures.js");
  for (const fixture of await loadAllFixtures()) {
    const analysis = analyzePlan(fixture.input);
    const rows = buildTreeRows(analysis.normalized.root);
    const rowsById = indexRowsById(rows);
    const views = buildFindingViews(analysis.findings, rowsById);

    assert.equal(rows.length, analysis.metrics.nodeCount, `${fixture.mode}/${fixture.name} tree row count`);
    assert.equal(views.length, analysis.findings.length, `${fixture.mode}/${fixture.name} finding views`);
    assert.notEqual(buildNodeInspector(analysis.normalized.root), null, `${fixture.mode}/${fixture.name} root inspector`);
    for (const row of rows) {
      assert.ok(row.label.length > 0, `${fixture.mode}/${fixture.name} row ${row.id} has a label`);
    }
  }
});
