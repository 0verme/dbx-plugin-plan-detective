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
import { loadAllFixtures, loadFixture } from "../helpers/fixtures.js";

const nestedLoop = await loadFixture({ database: "dameng", mode: "estimated", name: "nested-loop-large-inner.synthetic" });
const analysis = analyzePlan(nestedLoop.input);

function inspectorFields(inspector) {
  return new Map(inspector.groups.flatMap((group) => group.fields).map((field) => [field.label, field.value]));
}

test("buildTreeRows renders Dameng operator labels and relations", () => {
  const rows = buildTreeRows(analysis.normalized.root);
  assert.deepEqual(rows.map((row) => row.id), ["0", "0.0", "0.0.0", "0.0.1"]);
  assert.equal(rows[0].label, "NSET2");
  assert.equal(rows[2].label, "CSCN2 · T_CUSTOMERS [C] via INDEX600");
  assert.equal(rows[3].label, "SSEK2 · T_ORDERS [O] via IDX_ORDERS_CUSTOMER");
});

test("Node Inspector shows Dameng-native tuple and predicate fields", () => {
  const nodes = indexNodesById(analysis.normalized.root);
  const inspector = buildNodeInspector(nodes.get("0.0.0"));
  const fields = inspectorFields(inspector);

  assert.equal(fields.get("Operation ID (Id)"), "3");
  assert.equal(fields.get("Operator"), "CSCN2");
  assert.equal(fields.get("Cost (cost)"), "1");
  assert.equal(fields.get("Rows"), "200");
  assert.equal(fields.get("Bytes / Row"), "52");
  assert.equal(fields.get("Detail"), "INDEX600(T_CUSTOMERS as C); btr_scan(1); need_slct(0)");
  assert.equal(fields.get("Startup Cost"), undefined);
  assert.equal(fields.get("Total Cost"), undefined);
});

test("Dameng cost note is engine-specific and hotspots keep native evidence", () => {
  const note = describeHotspotCost(analysis.hotspots.cost, "zh-CN");
  assert.match(note, /达梦/);
  assert.match(note, /bytes-per-row/);
  assert.doesNotMatch(note, /SQL Server/);

  const rows = buildTreeRows(analysis.normalized.root);
  const views = buildHotspotViews(analysis.hotspots, indexRowsById(rows), analysis.findings);
  assert.deepEqual(views.items.map((item) => item.nodeId), ["0.0"]);
  assert.equal(views.items[0].reasons[0].source, "[cost, rows, bytes-per-row]");
  const evidence = new Map(views.items[0].evidence.map((row) => [row.path, row.value]));
  assert.equal(evidence.get("cost"), "10");
  assert.equal(evidence.get("bytesPerRow"), "56");
});

test("the shared view model works for every Dameng fixture", async () => {
  for (const fixture of await loadAllFixtures("dameng")) {
    const current = analyzePlan(fixture.input);
    const rows = buildTreeRows(current.normalized.root);
    const nodes = indexNodesById(current.normalized.root);
    assert.equal(rows.length, current.metrics.nodeCount, fixture.name);
    for (const row of rows) assert.ok(buildNodeInspector(nodes.get(row.id)) !== null, `${fixture.name} ${row.id}`);
  }
});
