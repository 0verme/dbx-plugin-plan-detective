import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import {
  buildFindingViews,
  buildHotspotViews,
  buildNodeInspector,
  buildPlanSummary,
  buildTreeRows,
  describeHotspotCost,
  indexNodesById,
  indexRowsById,
} from "../../src/lib/view-model.js";
import { loadAllFixtures, loadFixture } from "../helpers/fixtures.js";

/**
 * The UI consumes the same view-model for every database. These tests pin that
 * an OceanBase Oracle NormalizedPlan renders through the existing Plan Tree /
 * Plan Summary / Node Inspector / Hotspots / Findings helpers without an
 * OceanBase-only component path, and without PostgreSQL vocabulary.
 */

const tableScan = await loadFixture({ database: "oceanbase-oracle", mode: "estimated", name: "table-full-scan.synthetic" });
const nestedLoop = await loadFixture({ database: "oceanbase-oracle", mode: "estimated", name: "nested-loop-large-inner.synthetic" });
const tableGet = await loadFixture({ database: "oceanbase-oracle", mode: "estimated", name: "table-get-filter.synthetic" });

const tableScanAnalysis = analyzePlan(tableScan.input);
const nestedLoopAnalysis = analyzePlan(nestedLoop.input);
const tableGetAnalysis = analyzePlan(tableGet.input);

function inspectorFields(inspector) {
  return new Map(inspector.groups.flatMap((group) => group.fields).map((field) => [field.label, field.value]));
}

test("buildTreeRows renders the OceanBase Oracle tree with engine labels and relations", () => {
  const rows = buildTreeRows(nestedLoopAnalysis.normalized.root);

  assert.deepEqual(
    rows.map((row) => row.id),
    ["0", "0.0", "0.1"],
  );
  assert.equal(rows[0].label, "NESTED-LOOP JOIN");
  assert.equal(rows[0].estimatedRows, 5_000_000);
  assert.equal(rows[0].totalCost, null, "OceanBase EST.TIME(us) is not a PostgreSQL total cost");
  assert.equal(rows[1].label, "TABLE RANGE SCAN · T_CUSTOMERS(IDX_T_CUSTOMERS_REGION)");
  assert.equal(rows[1].relation, "T_CUSTOMERS(IDX_T_CUSTOMERS_REGION)");
  assert.equal(rows[2].label, "TABLE FULL SCAN · T_ORDERS");
});

test("buildNodeInspector renders OceanBase engine-specific fields and no PostgreSQL vocabulary", () => {
  const nodes = indexNodesById(tableScanAnalysis.normalized.root);
  const inspector = buildNodeInspector(nodes.get("0"));
  const fields = inspectorFields(inspector);

  assert.equal(inspector.title, "TABLE FULL SCAN · T_ORDERS");
  assert.equal(inspector.subtitle, "seq_scan");
  assert.equal(fields.get("Operator ID (ID)"), "0");
  assert.equal(fields.get("Operator (OPERATOR)"), "TABLE FULL SCAN");
  assert.equal(fields.get("Object Name (NAME)"), "T_ORDERS");
  assert.equal(fields.get("Estimated Time (EST.TIME(us))"), "41,200");
  assert.equal(fields.get("Output"), "output([T_ORDERS.ID], [T_ORDERS.STATUS], [T_ORDERS.TOTAL])");
  assert.equal(fields.get("Estimated Rows"), "250,000");
  assert.equal(fields.get("Startup Cost"), undefined, "PostgreSQL cost fields stay hidden");
  assert.equal(fields.get("Total Cost"), undefined);

  // PostgreSQL / MySQL / SQL Server fields must not leak into an OceanBase node.
  for (const label of [
    "Parallel Aware",
    "Async Capable",
    "Strategy",
    "Partial Mode",
    "Parent Relationship",
    "Presorted Keys",
    "Subplan Name",
    "Physical Op",
    "Access Type",
    "Rows Examined Per Scan",
  ]) {
    assert.equal(fields.has(label), false, `${label} is not an OceanBase Oracle field`);
  }
});

test("an unverified extended key is displayed as a native field, not as a predicate", () => {
  const nodes = indexNodesById(tableGetAnalysis.normalized.root);
  const fields = inspectorFields(buildNodeInspector(nodes.get("0")));

  assert.equal(fields.get("Filter"), undefined, "the extended filter member is not promoted to a neutral predicate");
  assert.equal(fields.get("filter"), "filter([T_ORDERS.ID = 42])", "it is still visible as a native field");
  assert.equal(fields.get("range_key"), "range_key([T_ORDERS.ID])");
});

test("buildPlanSummary omits the PostgreSQL incremental-cost highlight for OceanBase Oracle", () => {
  const summary = buildPlanSummary(nestedLoopAnalysis.metrics);
  const rows = new Map(summary.rows.map((row) => [row.key, row.value]));

  assert.equal(rows.get("totalEstimatedCost"), null);
  assert.equal(rows.get("nodeCount"), "3");
  assert.equal(rows.get("joinCount"), "1");
  assert.deepEqual(
    summary.highlights.map((highlight) => highlight.key),
    ["largestEstimatedRows"],
    "PostgreSQL incremental cost is not an OceanBase metric and must not appear",
  );
});

test("the hotspot panel explains the OceanBase Oracle cost context in display copy", () => {
  const note = describeHotspotCost(nestedLoopAnalysis.hotspots.cost);
  assert.match(note, /OceanBase Oracle/);
  assert.match(note, /EST\.TIME\(us\)/);
  assert.doesNotMatch(note, /SQL Server/, "the shared not-applicable reason must not borrow SQL Server copy");

  const view = buildHotspotViews(
    nestedLoopAnalysis.hotspots,
    indexRowsById(buildTreeRows(nestedLoopAnalysis.normalized.root)),
    nestedLoopAnalysis.findings,
  );
  assert.deepEqual(view.costNote, note);
  assert.deepEqual(
    view.items.map((item) => item.nodeId),
    ["0", "0.1"],
  );
  assert.deepEqual(view.items[0].reasons.map((reason) => reason.code), ["nested-loop-amplification"]);
});

test("findings render with OceanBase node labels and a missing cost shown as missing", () => {
  const rows = buildTreeRows(tableScanAnalysis.normalized.root);
  const views = buildFindingViews(tableScanAnalysis.findings, indexRowsById(rows));

  assert.deepEqual(views.map((view) => view.ruleId), ["large-sequential-scan"]);
  const [scan] = views;
  assert.equal(scan.nodeLabel, "0 · TABLE FULL SCAN · T_ORDERS");

  const evidence = new Map(scan.evidence.map((row) => [row.path, row.value]));
  assert.equal(evidence.get("incrementalCost"), "—", "a missing OceanBase cost is shown as missing, not as 0");
  assert.equal(evidence.get("estimatedRows"), "250,000");
});

test("the view-model works on every committed OceanBase Oracle fixture", async () => {
  for (const fixture of await loadAllFixtures("oceanbase-oracle")) {
    const analysis = analyzePlan(fixture.input);
    const rows = buildTreeRows(analysis.normalized.root);
    const rowsById = indexRowsById(rows);
    const nodesById = indexNodesById(analysis.normalized.root);
    const views = buildFindingViews(analysis.findings, rowsById);
    const hotspots = buildHotspotViews(analysis.hotspots, rowsById, analysis.findings);

    assert.equal(rows.length, analysis.metrics.nodeCount, `${fixture.name} tree row count`);
    assert.equal(views.length, analysis.findings.length, `${fixture.name} finding views`);
    assert.equal(hotspots.items.length, analysis.hotspots.items.length, `${fixture.name} hotspot views`);
    for (const row of rows) {
      assert.ok(row.label.length > 0, `${fixture.name} row ${row.id} has a label`);
      assert.notEqual(buildNodeInspector(nodesById.get(row.id)), null);
    }
  }
});
