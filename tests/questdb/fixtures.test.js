import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { flattenNodes } from "../../src/core/tree.js";
import { MODES_BY_DATABASE, goldenPathFor, loadAllFixtures, planSuffixFor, relativeToRepo } from "../helpers/fixtures.js";

const fixtures = await loadAllFixtures("questdb");
const STAGES = ["parsed", "normalized", "metrics", "findings", "hotspots"];

test("QuestDB fixtures are estimated-only text plans with honest provenance", () => {
  assert.equal(fixtures.length, 6);
  assert.deepEqual(MODES_BY_DATABASE.questdb, ["estimated"]);
  assert.equal(planSuffixFor("questdb"), ".plan.txt");
  assert.equal(fixtures.every((fixture) => fixture.meta.format === "text" && typeof fixture.plan === "string"), true);
  assert.equal(fixtures.filter((fixture) => fixture.meta.source.kind === "official").length, 3);
  assert.equal(fixtures.filter((fixture) => fixture.meta.source.kind === "synthetic").length, 3);
  assert.equal(fixtures.filter((fixture) => fixture.meta.source.kind === "locally-generated").length, 0);
  assert.equal(fixtures.some((fixture) => fixture.mode === "actual"), false);
});

for (const stage of STAGES) {
  test(`QuestDB golden stage "${stage}" matches every fixture`, async (t) => {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        const file = goldenPathFor(fixture.mode, fixture.name, "questdb");
        const golden = JSON.parse(await readFile(file, "utf8"));
        const analysis = analyzePlan(fixture.input);
        assert.deepEqual(
          analysis[stage],
          golden[stage],
          `${relativeToRepo(file)} is stale for stage "${stage}"; review the intended change before updating goldens`,
        );
      });
    }
  });
}

test("QuestDB golden files mirror the fixture directory and pin all stages", async () => {
  const expected = fixtures.map((fixture) => `${fixture.name}.json`).sort();
  const actual = (await readdir(new URL("../../fixtures/questdb/golden/estimated/", import.meta.url)))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  assert.deepEqual(actual, expected);

  for (const fixture of fixtures) {
    const golden = JSON.parse(await readFile(goldenPathFor(fixture.mode, fixture.name, "questdb"), "utf8"));
    assert.deepEqual(Object.keys(golden).sort(), [...STAGES].sort());
  }
});

test("QuestDB never infers rows or PostgreSQL costs or emits unsupported signals", () => {
  for (const fixture of fixtures) {
    const analysis = analyzePlan(fixture.input);
    assert.equal(analysis.parsed.database, "questdb");
    assert.equal(analysis.parsed.format, "text");
    assert.equal(analysis.parsed.root.nodeType, fixture.meta.expect.rootNodeType);
    assert.ok(analysis.metrics.maxDepth >= fixture.meta.expect.minDepth);
    assert.equal(analysis.metrics.costAttribution.status, "not-applicable");
    assert.equal(analysis.metrics.costAttribution.engine, "questdb");
    assert.equal(analysis.metrics.totalEstimatedCost, null);
    assert.equal(analysis.metrics.rootEstimatedRows, null);
    assert.equal(analysis.metrics.largestEstimatedRows, null);
    assert.equal(analysis.metrics.highestIncrementalCost, null);
    assert.deepEqual(analysis.findings, []);
    assert.deepEqual(analysis.hotspots, {
      cost: { engine: "questdb", status: "not-applicable", reason: "NOT_POSTGRES_COST_MODEL" },
      items: [],
    });

    for (const node of flattenNodes(analysis.normalized.root)) {
      assert.equal(node.estimatedRows, null);
      assert.equal(node.startupCost, null);
      assert.equal(node.totalCost, null);
      assert.equal(node.width, null);
      assert.equal(node.actualRows, null);
      assert.equal(node.actualTotalTime, null);
      assert.equal(node.loops, null);
      assert.equal(node.engineSpecific.database, "questdb");
      assert.equal(typeof node.engineSpecific.questdb, "object");
    }
    assert.deepEqual(
      analysis.findings.map((finding) => finding.ruleId),
      fixture.meta.expect.findingRuleIds,
    );
    assert.deepEqual(analysis.hotspots.items.map((hotspot) => hotspot.nodeId), fixture.meta.expect.hotspotNodeRefs);
  }
});

test("PageFrame + Row cursor + Frame cursor is one relation-access metric", () => {
  const fixture = fixtures.find((entry) => entry.name === "async-jit-filter");
  const analysis = analyzePlan(fixture.input);
  assert.equal(analysis.metrics.nodeCount, 4);
  assert.equal(analysis.metrics.scanCount, 1);
  assert.equal(analysis.metrics.sequentialScanCount, 0);
  assert.equal(analysis.metrics.indexScanCount, 0);
  assert.deepEqual(
    flattenNodes(analysis.normalized.root).map((node) => [node.nodeType, node.kind]),
    [
      ["Async JIT Filter", "filter"],
      ["PageFrame", "pipeline"],
      ["Row forward scan", "pipeline"],
      ["Frame forward scan", "scan"],
    ],
  );
});

test("unknown QuestDB operators remain visible and preserve their subtrees", () => {
  const fixture = fixtures.find((entry) => entry.name === "future-operator.synthetic");
  const analysis = analyzePlan(fixture.input);
  assert.equal(analysis.normalized.root.kind, "unknown");
  assert.equal(analysis.normalized.root.children[0].kind, "pipeline");
  assert.equal(analysis.normalized.root.children[0].children[0].kind, "pipeline");
  assert.equal(analysis.normalized.root.children[0].children[0].children[0].kind, "scan");
  assert.deepEqual(analysis.normalized.unknownNodeTypes, ["QuestDB Future Operator"]);
});

test("QuestDB pipeline is deterministic and JSON serializable", () => {
  for (const fixture of fixtures) {
    const first = analyzePlan(fixture.input);
    const second = analyzePlan(fixture.input);
    assert.deepEqual(first, second, fixture.name);
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first, fixture.name);
  }
});
