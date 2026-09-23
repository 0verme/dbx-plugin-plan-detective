import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { flattenNodes } from "../../src/core/tree.js";
import { buildNodeInspector, buildTreeRows, indexNodesById } from "../../src/lib/view-model.js";
import { loadFixture, loadAllFixtures } from "../helpers/fixtures.js";

function fieldsByLabel(inspector) {
  return new Map(inspector.groups.flatMap((group) => group.fields).map((field) => [field.label, field.value]));
}

test("generic Node Inspector presents reported QuestDB operator and property evidence", async () => {
  const fixture = await loadFixture({ database: "questdb", mode: "estimated", name: "async-jit-filter" });
  const analysis = analyzePlan(fixture.input);
  const inspector = buildNodeInspector(analysis.normalized.root);
  const fields = fieldsByLabel(inspector);

  assert.equal(fields.get("Operator"), "Async JIT Filter");
  assert.equal(fields.get("Inline Properties"), "workers: 47");
  assert.equal(fields.get("Properties"), "filter: 100.0<amount [pre-touch]");
  assert.equal(fields.get("Filter"), "100.0<amount [pre-touch]");
  assert.equal(fields.get("Workers"), "47");
  assert.equal(fields.get("Estimated Rows"), undefined);
  assert.equal(fields.get("Startup Cost"), undefined);
  assert.equal(fields.get("Total Cost"), undefined);
  assert.equal(fields.get("Raw Node"), "Async JIT Filter workers: 47");
});

test("QuestDB scan inspector shows relation and direction without adding component-specific branches", async () => {
  const fixture = await loadFixture({ database: "questdb", mode: "estimated", name: "ordered-backward" });
  const analysis = analyzePlan(fixture.input);
  const scan = flattenNodes(analysis.normalized.root).find((node) => node.nodeType === "Frame backward scan");
  const fields = fieldsByLabel(buildNodeInspector(scan));
  const rows = buildTreeRows(analysis.normalized.root);

  assert.equal(fields.get("Operator"), "Frame backward scan");
  assert.equal(fields.get("Relation"), "trades");
  assert.equal(fields.get("Scan Direction"), "backward");
  assert.equal(fields.get("Raw Node"), "    Frame backward scan on: trades");
  assert.equal(rows.find((row) => row.id === scan.id).label, "Frame backward scan · trades");
});

test("group-by vectorized and unknown properties appear only when present", async () => {
  const fixture = await loadFixture({ database: "questdb", mode: "estimated", name: "inline-properties.synthetic" });
  const analysis = analyzePlan(fixture.input);
  const group = flattenNodes(analysis.normalized.root).find((node) => node.nodeType === "GroupByRecord");
  const fields = fieldsByLabel(buildNodeInspector(group));

  assert.equal(fields.get("Vectorized"), "true");
  assert.equal(fields.get("Workers"), "2");
  assert.equal(fields.get("Properties"), "workers: 2\nfuture_group_option: preserved");
  assert.equal(fields.get("Filter"), undefined);
});

test("every QuestDB fixture node has a generic inspector view", async () => {
  for (const fixture of await loadAllFixtures("questdb")) {
    const analysis = analyzePlan(fixture.input);
    const nodes = indexNodesById(analysis.normalized.root);
    assert.equal(buildTreeRows(analysis.normalized.root).length, analysis.metrics.nodeCount, fixture.name);
    for (const [id, node] of nodes) assert.ok(buildNodeInspector(node) !== null, `${fixture.name} ${id}`);
  }
});
