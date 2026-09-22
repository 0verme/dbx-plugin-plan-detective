import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { flattenNodes } from "../../src/core/tree.js";
import { MODES_BY_DATABASE, goldenPathFor, loadAllFixtures, planSuffixFor, relativeToRepo } from "../helpers/fixtures.js";

const fixtures = await loadAllFixtures("dameng");
const STAGES = ["parsed", "normalized", "metrics", "findings", "hotspots"];

test("Dameng fixtures are estimated-only native text plans", () => {
  assert.ok(fixtures.length >= 6, `expected at least 6 Dameng fixtures, found ${fixtures.length}`);
  assert.deepEqual(MODES_BY_DATABASE.dameng, ["estimated"]);
  assert.equal(planSuffixFor("dameng"), ".plan.txt");
  assert.equal(fixtures.every((fixture) => fixture.meta.format === "text" && typeof fixture.plan === "string"), true);
  assert.equal(fixtures.filter((fixture) => fixture.meta.source.kind === "official").length, 1);
});

for (const stage of STAGES) {
  test(`Dameng golden stage "${stage}" matches every fixture`, async (t) => {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        const file = goldenPathFor(fixture.mode, fixture.name, "dameng");
        const golden = JSON.parse(await readFile(file, "utf8"));
        const analysis = analyzePlan(fixture.input);
        assert.deepEqual(
          analysis[stage],
          golden[stage],
          `${relativeToRepo(file)} is stale for stage "${stage}"; run npm run test:update-goldens after reviewing the intended change`,
        );
      });
    }
  });
}

test("Dameng golden files mirror the fixture directory and pin all stages", async () => {
  const expected = fixtures.map((fixture) => `${fixture.name}.json`).sort();
  const actual = (await readdir(new URL("../../fixtures/dameng/golden/estimated/", import.meta.url)))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  assert.deepEqual(actual, expected);

  for (const fixture of fixtures) {
    const golden = JSON.parse(await readFile(goldenPathFor(fixture.mode, fixture.name, "dameng"), "utf8"));
    assert.deepEqual(Object.keys(golden).sort(), [...STAGES].sort());
  }
});

test("Dameng fixture metadata and estimated-only fields remain consistent", () => {
  const operators = new Set();
  const kinds = new Set();

  for (const fixture of fixtures) {
    const analysis = analyzePlan(fixture.input);
    assert.equal(analysis.parsed.database, "dameng");
    assert.equal(analysis.parsed.format, "text");
    assert.equal(analysis.parsed.root.nodeType, fixture.meta.expect.rootNodeType);
    assert.ok(analysis.metrics.maxDepth >= fixture.meta.expect.minDepth);
    assert.equal(analysis.metrics.costAttribution.status, "not-applicable");
    assert.equal(analysis.metrics.costAttribution.engine, "dameng");

    for (const node of flattenNodes(analysis.parsed.root)) operators.add(node.operator);
    for (const node of flattenNodes(analysis.normalized.root)) {
      kinds.add(node.kind);
      assert.equal(node.actualRows, null);
      assert.equal(node.actualTotalTime, null);
      assert.equal(node.loops, null);
      assert.equal(node.startupCost, null);
      assert.equal(node.totalCost, null);
      assert.equal(node.engineSpecific.database, "dameng");
      assert.equal(typeof node.engineSpecific.dameng, "object");
    }

    assert.deepEqual(
      [...new Set(analysis.findings.map((finding) => finding.ruleId))].sort(),
      [...new Set(fixture.meta.expect.findingRuleIds)].sort(),
    );
    if (fixture.meta.expect.hotspotNodeRefs !== undefined) {
      assert.deepEqual(
        analysis.hotspots.items.map((hotspot) => hotspot.nodeId),
        fixture.meta.expect.hotspotNodeRefs,
      );
    }
  }

  for (const operator of ["NSET2", "PRJT2", "NEST LOOP INDEX JOIN2", "CSCN2", "SSEK2", "HASH2 INNER JOIN2", "SAGR2", "SORT3", "PX FUTURE SHUFFLE"]) {
    assert.ok(operators.has(operator), `fixture set must exercise operator ${operator}`);
  }
  for (const kind of ["result", "project", "nested_loop", "seq_scan", "index_scan", "hash_join", "aggregate", "sort", "unknown"]) {
    assert.ok(kinds.has(kind), `fixture set must exercise normalized kind ${kind}`);
  }
});

test("Dameng pipeline is deterministic and JSON serializable", () => {
  for (const fixture of fixtures) {
    const first = analyzePlan(fixture.input);
    const second = analyzePlan(fixture.input);
    assert.deepEqual(first, second);
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  }
});
