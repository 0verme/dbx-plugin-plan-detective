import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { buildHotspotViews, buildNodeInspector, buildTreeRows, indexNodesById } from "../../src/lib/view-model.js";
import { loadFixture, loadAllFixtures } from "../helpers/fixtures.js";

function fieldsByLabel(inspector) {
  return new Map(inspector.groups.flatMap((group) => group.fields).map((field) => [field.label, field.value]));
}

test("generic Plan Tree exposes Doris operator classification and estimated rows", async () => {
  const fixture = await loadFixture({ database: "doris", mode: "estimated", name: "operator-mapping.synthetic" });
  const analysis = analyzePlan(fixture.input);
  const rows = buildTreeRows(analysis.normalized.root);
  const scan = analysis.normalized.root.children[0].children[0].children[0].children[0].children[0];
  const scanRow = rows.find((row) => row.id === scan.id);

  assert.equal(rows[0].kind, "structural");
  assert.equal(rows[1].kind, "structural");
  assert.equal(scanRow.kind, "scan");
  assert.equal(scanRow.nodeType, "VOlapScanNode");
  assert.equal(scanRow.relation, "sales.orders");
  assert.equal(scanRow.estimatedRows, 1200);
  assert.equal(scanRow.label, "VOlapScanNode · sales.orders");
  assert.ok(rows.length > analysis.metrics.nodeCount, "tree rows include structural plan / fragment containers but metrics do not");
});

test("generic Node Inspector shows Doris properties and fragment / sink metadata without a Doris UI branch", async () => {
  const fixture = await loadFixture({ database: "doris", mode: "estimated", name: "exchange-link.synthetic" });
  const analysis = analyzePlan(fixture.input);
  const nodes = indexNodesById(analysis.normalized.root);
  const fragment = analysis.normalized.root.children[1];
  const join = fragment.children[0];
  const scan = join.children.find((node) => node.kind === "scan");
  const fragmentFields = fieldsByLabel(buildNodeInspector(fragment));
  const joinFields = fieldsByLabel(buildNodeInspector(join));
  const scanFields = fieldsByLabel(buildNodeInspector(scan));
  const rootFields = fieldsByLabel(buildNodeInspector(analysis.normalized.root));

  assert.equal(fragmentFields.get("fragmentId"), "1");
  assert.equal(fragmentFields.get("sinkType"), "STREAM DATA SINK");
  assert.equal(fragmentFields.get("sinkExchangeId"), "007");
  assert.equal(fragmentFields.get("sinkDistribution"), "HASH_PARTITIONED");
  assert.equal(joinFields.get("joinOp"), "INNER JOIN(BROADCAST)[]");
  assert.equal(joinFields.get("fragmentId"), "1");
  assert.equal(scanFields.get("Estimated Rows"), "1,500,000");
  assert.equal(scanFields.get("table"), "analytics.orders");
  assert.equal(scanFields.get("operationId"), "8");
  assert.ok(rootFields.get("exchangeEdges").includes("matched"));
  assert.match(buildHotspotViews(analysis.hotspots, undefined, analysis.findings, "en").costNote, /Doris cardinality/);
  assert.equal(buildTreeRows(analysis.normalized.root).length, nodes.size);

  for (const node of nodes.values()) assert.ok(buildNodeInspector(node) !== null, node.nodeType);
});

test("every Doris fixture tree and inspector is renderable through the generic view model", async () => {
  for (const fixture of await loadAllFixtures("doris")) {
    const analysis = analyzePlan(fixture.input);
    const rows = buildTreeRows(analysis.normalized.root);
    const nodes = indexNodesById(analysis.normalized.root);
    assert.equal(rows.length, nodes.size, fixture.name);
    for (const [id, node] of nodes) assert.ok(buildNodeInspector(node) !== null, `${fixture.name} ${id}`);
  }
});
