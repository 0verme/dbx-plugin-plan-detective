import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { flattenNodes } from "../../src/core/tree.js";
import { MODES_BY_DATABASE, goldenPathFor, loadAllFixtures, planSuffixFor, relativeToRepo } from "../helpers/fixtures.js";

const fixtures = await loadAllFixtures("oracle");
const STAGES = ["parsed", "normalized", "metrics", "findings", "hotspots"];

test("Oracle DBMS_XPLAN fixtures are estimated-only text plans", () => {
  assert.ok(fixtures.length >= 5, `expected at least 5 Oracle fixtures, found ${fixtures.length}`);
  assert.deepEqual(MODES_BY_DATABASE.oracle, ["estimated"]);
  assert.equal(planSuffixFor("oracle"), ".plan.txt");
  for (const fixture of fixtures) {
    assert.equal(fixture.meta.format, "text");
    assert.equal(typeof fixture.plan, "string");
    assert.equal(fixture.meta.source.kind, "synthetic");
  }
});

for (const stage of STAGES) {
  test(`Oracle golden stage "${stage}" matches every fixture`, async (t) => {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        const file = goldenPathFor(fixture.mode, fixture.name, "oracle");
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

test("Oracle golden files mirror the fixture directory and pin all pipeline stages", async () => {
  const expected = fixtures.map((fixture) => `${fixture.name}.json`).sort();
  const actual = (await readdir(new URL("../../fixtures/oracle/golden/estimated/", import.meta.url)))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  assert.deepEqual(actual, expected);

  for (const fixture of fixtures) {
    const golden = JSON.parse(await readFile(goldenPathFor(fixture.mode, fixture.name, "oracle"), "utf8"));
    assert.deepEqual(Object.keys(golden).sort(), [...STAGES].sort());
  }
});

test("Oracle fixture metadata and native fields remain consistent", () => {
  for (const fixture of fixtures) {
    const analysis = analyzePlan(fixture.input);
    assert.equal(analysis.parsed.database, "oracle");
    assert.equal(analysis.parsed.format, "text");
    assert.equal(analysis.parsed.root.nodeType, fixture.meta.expect.rootNodeType);
    assert.ok(analysis.metrics.maxDepth >= fixture.meta.expect.minDepth);
    assert.equal(
      flattenNodes(analysis.normalized.root).some(
        (node) => node.actualRows !== null || node.actualTotalTime !== null || node.loops !== null,
      ),
      false,
    );
    assert.deepEqual(
      [...new Set(analysis.findings.map((finding) => finding.ruleId))].sort(),
      [...new Set(fixture.meta.expect.findingRuleIds)].sort(),
    );
    assert.equal(analysis.metrics.costAttribution.status, "not-applicable");
    assert.equal(analysis.normalized.root.startupCost, null);
    assert.equal(analysis.normalized.root.totalCost, null);
  }
});
