import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { flattenNodes } from "../../src/core/tree.js";
import { MODES_BY_DATABASE, goldenPathFor, loadAllFixtures, relativeToRepo } from "../helpers/fixtures.js";

const fixtures = await loadAllFixtures("db2");
const STAGES = ["parsed", "normalized", "metrics", "findings", "hotspots"];

test("DB2 fixture set is DB2 LUW Estimated JSON only with explicit source provenance", () => {
  assert.equal(fixtures.length, 3);
  assert.deepEqual(MODES_BY_DATABASE.db2, ["estimated"]);
  assert.equal(fixtures.find((fixture) => fixture.name === "shared-temp-plan").meta.source.kind, "official");
  assert.ok(fixtures.filter((fixture) => fixture.name.includes(".synthetic")).every((fixture) => fixture.meta.source.kind === "synthetic"));
  assert.deepEqual(new Set(fixtures.map((fixture) => fixture.meta.format)), new Set(["json"]));
});

for (const stage of STAGES) {
  test(`DB2 pipeline stage "${stage}" matches its golden fixture`, async (t) => {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        const goldenPath = goldenPathFor(fixture.mode, fixture.name, "db2");
        const golden = JSON.parse(await readFile(goldenPath, "utf8"));
        const analysis = analyzePlan(fixture.input);
        assert.deepStrictEqual(
          analysis[stage],
          golden[stage],
          `${relativeToRepo(goldenPath)} is stale for ${stage}; review and regenerate the intended DB2 golden output.`,
        );
      });
    }
  });
}

test("all DB2 fixtures remain structured DB2 plans with only estimate evidence", () => {
  for (const fixture of fixtures) {
    const result = analyzePlan(fixture.input);
    assert.equal(result.parsed.database, "db2");
    assert.equal(result.normalized.database, "db2");
    assert.equal(result.normalized.root.nodeType, "DB2 Estimated Plan");
    assert.ok(result.metrics.nodeCount >= fixture.meta.expect.minDepth);
    assert.equal(result.metrics.costAttribution.engine, "db2");
    assert.equal(result.metrics.costAttribution.status, "not-applicable");
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.hotspots.items, []);
    assert.equal(
      flattenNodes(result.normalized.root).some((node) => node.actualRows !== null || node.actualTotalTime !== null || node.loops !== null),
      false,
    );
    assert.deepEqual([...new Set(result.findings.map((finding) => finding.ruleId))], fixture.meta.expect.findingRuleIds);
  }
});

test("DB2 golden directory mirrors the estimated fixture directory", async () => {
  const expected = fixtures.map((fixture) => `${fixture.name}.json`).sort();
  const actual = (await readdir(new URL("../../fixtures/db2/golden/estimated/", import.meta.url)))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  assert.deepEqual(actual, expected);
});
