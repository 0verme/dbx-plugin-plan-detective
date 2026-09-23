import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQuestDbPlan } from "../../src/core/normalize/normalize-questdb.js";
import { parseQuestDbTextPlan } from "../../src/core/questdb/parse-text-plan.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";

function normalize(text) {
  return normalizeQuestDbPlan(
    parseQuestDbTextPlan(createRawPlanInput({ database: "questdb", mode: "estimated", format: "text", plan: text })),
  );
}

test("documented QuestDB operators map only to conservative shared kinds", () => {
  const cases = [
    ["Async JIT Filter workers: 2", "filter"],
    ["PageFrame", "pipeline"],
    ["Row backward scan", "pipeline"],
    ["Frame forward scan on: trades", "scan"],
    ["Interval forward scan on: trades", "scan"],
    ["Index backward scan", "index_scan"],
    ["Hash Join Light", "join"],
    ["AsOf Join Fast", "join"],
    ["AsOf Join Light", "join"],
    ["Async Window Fast Join", "join"],
    ["Async Window Join", "join"],
    ["Nested Loop", "nested_loop"],
    ["Cross Join", "join"],
    ["Splice Join", "join"],
    ["Sort light", "sort"],
    ["GroupByRecord vectorized: true", "aggregate"],
    ["SampleBy", "aggregate"],
    ["SelectedRecord", "project"],
    ["Union", "append"],
  ];

  for (const [nodeLine, kind] of cases) {
    const plan = normalize(nodeLine);
    assert.equal(plan.root.kind, kind, nodeLine);
    assert.deepEqual(plan.unknownNodeTypes, [], nodeLine);
  }
});

test("QuestDB estimates are null and native properties remain engine-specific", () => {
  const plan = normalize(["Async JIT Filter workers: 4", "  filter: 100 < l", "    PageFrame", "        Row forward scan", "        Frame forward scan on: tab"].join("\n"));
  const scan = plan.root.children[0].children[1];

  assert.equal(plan.database, "questdb");
  assert.equal(plan.mode, "estimated");
  assert.equal(plan.format, "text");
  assert.equal(plan.root.filter, "100 < l");
  assert.equal(plan.root.engineSpecific.questdb.workers, 4);
  assert.equal(scan.relation.name, "tab");
  for (const node of [plan.root, ...plan.root.children, ...plan.root.children[0].children]) {
    assert.equal(node.estimatedRows, null);
    assert.equal(node.startupCost, null);
    assert.equal(node.totalCost, null);
    assert.equal(node.width, null);
    assert.equal(node.actualRows, null);
    assert.equal(node.actualTotalTime, null);
    assert.equal(node.loops, null);
    assert.equal(typeof node.engineSpecific.questdb.rawLine, "string");
  }
});

test("unknown operators preserve their label, children, and unknown properties", () => {
  const plan = normalize(
    ["Future QuestDB Operator", " future_key: future value", "    PageFrame futureInline: keep", "      Frame backward scan on: quotes"].join("\n"),
  );
  const unknown = plan.root;

  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.nodeType, "Future QuestDB Operator");
  assert.deepEqual(plan.unknownNodeTypes, ["Future QuestDB Operator"]);
  assert.equal(unknown.engineSpecific.questdb.properties[0].name, "future_key");
  assert.equal(unknown.children[0].engineSpecific.questdb.inlineProperties[0].name, "futureInline");
  assert.equal(unknown.children[0].children[0].relation.name, "quotes");
  assert.equal(unknown.children[0].children[0].engineSpecific.questdb.scanDirection, "backward");
});

test("only documented scan-on node syntax contributes a neutral relation", () => {
  const plan = normalize(["Hash Join on: not-a-relation-in-this-contract", "  Frame forward scan on: trades"].join("\n"));
  assert.equal(plan.root.relation, null);
  assert.equal(plan.root.children[0].relation.name, "trades");
});
