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
 * a SQL Server NormalizedPlan renders through the existing Plan Tree / Plan
 * Summary / Node Inspector / Hotspots / Findings helpers without a
 * SQL Server-only UI path, and without PostgreSQL vocabulary.
 */

const sort = await loadFixture({ database: "sqlserver", mode: "estimated", name: "sort.synthetic" });
const tableScan = await loadFixture({ database: "sqlserver", mode: "estimated", name: "table-scan.synthetic" });
const nestedLoops = await loadFixture({ database: "sqlserver", mode: "estimated", name: "nested-loops-large-inner.synthetic" });
const keyLookup = await loadFixture({ database: "sqlserver", mode: "estimated", name: "key-lookup.synthetic" });

const sortAnalysis = analyzePlan(sort.input);
const tableScanAnalysis = analyzePlan(tableScan.input);
const nestedLoopsAnalysis = analyzePlan(nestedLoops.input);
const keyLookupAnalysis = analyzePlan(keyLookup.input);

function inspectorFields(inspector) {
  return new Map(inspector.groups.flatMap((group) => group.fields).map((field) => [field.label, field.value]));
}

test("buildTreeRows renders the SQL Server tree with relation and index labels", () => {
  const rows = buildTreeRows(sortAnalysis.normalized.root);

  assert.deepEqual(
    rows.map((row) => row.id),
    ["0", "0.0", "0.0.0"],
  );
  assert.equal(rows[0].label, "Sort");
  assert.equal(rows[1].label, "Parallelism");
  assert.equal(rows[2].label, "Clustered Index Scan · Orders [o] via PK_Orders");
  assert.equal(rows[2].relation, "Orders");
  assert.equal(rows[2].indexName, "PK_Orders");
  assert.equal(rows[2].estimatedRows, 120_000);
  assert.equal(rows[2].totalCost, null, "SQL Server subtree cost is not a PostgreSQL total cost");
});

test("buildNodeInspector renders SQL Server engine-specific fields and no PostgreSQL vocabulary", () => {
  const nodes = indexNodesById(tableScanAnalysis.normalized.root);
  const inspector = buildNodeInspector(nodes.get("0"));
  const fields = inspectorFields(inspector);

  assert.equal(inspector.title, "Table Scan · Customers [c]");
  assert.equal(inspector.subtitle, "seq_scan · alias c");
  assert.equal(fields.get("Physical Op"), "Table Scan");
  assert.equal(fields.get("Logical Op"), "Table Scan");
  assert.equal(fields.get("Node ID (ShowPlanXML)"), "0");
  assert.equal(fields.get("Estimated Subtree Cost"), "12.5");
  assert.equal(fields.get("Estimate CPU"), "3.75");
  assert.equal(fields.get("Estimate IO"), "18.75");
  assert.equal(fields.get("Estimate Rebinds"), "0");
  assert.equal(fields.get("Relation"), "Customers");
  assert.equal(fields.get("Alias"), "c");
  assert.equal(fields.get("Object Database"), "[Sales]");
  assert.equal(fields.get("Object Schema"), "[dbo]");
  assert.equal(fields.get("Object Table"), "[Customers]");
  assert.equal(fields.get("Object Alias"), "[c]");
  assert.equal(fields.get("Storage"), "RowStore");
  assert.equal(fields.get("Statement Type"), "SELECT");
  assert.equal(fields.get("Degree of Parallelism"), "1");
  assert.equal(fields.get("Memory Grant"), "1,024");
  assert.equal(fields.get("Filter"), "[Sales].[dbo].[Customers].[Status]='ACTIVE'");

  // PostgreSQL-only fields must not leak into a SQL Server node.
  for (const label of ["Parallel Aware", "Async Capable", "Strategy", "Partial Mode", "Parent Relationship", "Presorted Keys", "Subplan Name"]) {
    assert.equal(fields.has(label), false, `${label} is not a SQL Server field`);
  }
});

test("buildNodeInspector shows SQL Server sort keys, seek predicates and lookup flags", () => {
  const nodes = indexNodesById(sortAnalysis.normalized.root);
  const sortFields = inspectorFields(buildNodeInspector(nodes.get("0")));
  assert.equal(sortFields.get("Sort Keys"), "[o].OrderDate ASC, [o].TotalDue DESC");
  assert.equal(sortFields.get("Distinct"), undefined, "false flags stay hidden");

  const lookupNodes = indexNodesById(keyLookupAnalysis.normalized.root);
  const lookupFields = inspectorFields(buildNodeInspector(lookupNodes.get("0")));
  assert.equal(lookupFields.get("Lookup"), "true");
  assert.equal(lookupFields.get("Index Condition"), "Prefix(EQ) [o].OrderID = [Sales].[dbo].[Orders].[OrderID] as [o].[OrderID]");
});

test("buildPlanSummary omits the PostgreSQL incremental-cost highlight for SQL Server", () => {
  const summary = buildPlanSummary(sortAnalysis.metrics);
  const rows = new Map(summary.rows.map((row) => [row.key, row.value]));

  assert.equal(rows.get("totalEstimatedCost"), null);
  assert.equal(rows.get("nodeCount"), "3");
  assert.equal(rows.get("sortCount"), "1");
  assert.equal(rows.get("indexScanCount"), "1");
  assert.deepEqual(
    summary.highlights.map((highlight) => highlight.key),
    ["largestEstimatedRows"],
    "PostgreSQL incremental cost is not a SQL Server metric and must not appear",
  );
});

test("the hotspot panel explains the SQL Server cost context in display copy", () => {
  const note = describeHotspotCost(sortAnalysis.hotspots.cost);
  assert.match(note, /SQL Server/);
  assert.match(note, /EstimatedTotalSubtreeCost/);

  const view = buildHotspotViews(sortAnalysis.hotspots, indexRowsById(buildTreeRows(sortAnalysis.normalized.root)), sortAnalysis.findings);
  assert.deepEqual(view.costNote, note);
  assert.deepEqual(
    view.items.map((item) => item.nodeId),
    ["0", "0.0.0"],
  );
  assert.deepEqual(view.items[0].reasons.map((reason) => reason.code), ["sqlserver-sort"]);
});

test("findings render with SQL Server node labels and missing costs shown as missing", () => {
  const rows = buildTreeRows(tableScanAnalysis.normalized.root);
  const rowsById = indexRowsById(rows);
  const views = buildFindingViews(tableScanAnalysis.findings, rowsById);

  assert.deepEqual(views.map((view) => view.ruleId), ["large-sequential-scan"]);
  const [scan] = views;
  assert.equal(scan.nodeLabel, "0 · Table Scan · Customers [c]");

  const evidence = new Map(scan.evidence.map((row) => [row.path, row.value]));
  assert.equal(evidence.get("incrementalCost"), "—", "a missing SQL Server cost is shown as missing, not as 0");
  assert.equal(evidence.get("estimatedRows"), "250,000");
});

test("the nested-loop finding renders SQL Server estimates without runtime loops", () => {
  const rows = buildTreeRows(nestedLoopsAnalysis.normalized.root);
  const views = buildFindingViews(nestedLoopsAnalysis.findings, indexRowsById(rows));
  const nested = views.find((view) => view.ruleId === "nested-loop-large-inner");

  assert.ok(nested);
  assert.equal(nested.nodeLabel, "0 · Nested Loops");
  const evidence = new Map(nested.evidence.map((row) => [row.path, row.value]));
  assert.equal(evidence.get("estimatedRowComparisons"), "50,000,000");
  assert.equal(evidence.get("estimateOnly"), "true");
  assert.equal(evidence.get("actualLoops"), "—");
});

test("the view-model works on every committed SQL Server fixture", async () => {
  for (const fixture of await loadAllFixtures("sqlserver")) {
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
