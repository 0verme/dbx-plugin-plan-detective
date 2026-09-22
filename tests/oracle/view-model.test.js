import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import {
  buildHotspotViews,
  buildNodeInspector,
  buildTreeRows,
  describeHotspotCost,
  indexNodesById,
  indexRowsById,
} from "../../src/lib/view-model.js";
import { loadAllFixtures } from "../helpers/fixtures.js";

const fixtures = await loadAllFixtures("oracle");
const tableScan = analyzePlan(fixtures.find((fixture) => fixture.name === "table-scan.synthetic").input);

function inspectorFields(inspector) {
  return new Map(inspector.groups.flatMap((group) => group.fields).map((field) => [field.label, field.value]));
}

test("shared tree and inspector render Oracle normalized nodes", () => {
  const rows = buildTreeRows(tableScan.normalized.root);
  assert.deepEqual(rows.map((row) => row.id), ["0", "0.0"]);
  assert.equal(rows[1].label, "TABLE ACCESS FULL · PD_ORDERS");
  assert.equal(rows[1].totalCost, null);

  const inspector = buildNodeInspector(indexNodesById(tableScan.normalized.root).get("0.0"));
  const fields = inspectorFields(inspector);
  assert.equal(fields.get("Operation ID (Id)"), "1");
  assert.equal(fields.get("Raw Operation"), "TABLE ACCESS FULL");
  assert.equal(fields.get("Rows"), "10,000");
  assert.equal(fields.get("Cost (Cost)"), "2");
  assert.equal(fields.get("Predicate Marker"), "true");
  assert.equal(fields.get("Startup Cost"), undefined);
  assert.equal(fields.get("Total Cost"), undefined);
});

test("shared hotspot UI uses Oracle row and cost wording", () => {
  const note = describeHotspotCost(tableScan.hotspots.cost);
  assert.match(note, /Oracle/);
  assert.match(note, /Rows/);
  assert.doesNotMatch(note, /SQL Server/);

  const rows = buildTreeRows(tableScan.normalized.root);
  const views = buildHotspotViews(tableScan.hotspots, indexRowsById(rows), tableScan.findings);
  assert.deepEqual(views.items.map((item) => item.nodeId), ["0.0"]);
  assert.equal(views.items[0].reasons[0].source, "Rows");
});

test("shared UI helpers work for every Oracle fixture", () => {
  for (const fixture of fixtures) {
    const analysis = analyzePlan(fixture.input);
    const rows = buildTreeRows(analysis.normalized.root);
    const nodes = indexNodesById(analysis.normalized.root);
    assert.equal(rows.length, analysis.metrics.nodeCount);
    for (const row of rows) assert.ok(buildNodeInspector(nodes.get(row.id)) !== null);
  }
});
