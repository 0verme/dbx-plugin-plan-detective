import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { flattenNodes } from "../../src/core/tree.js";
import { MODES_BY_DATABASE, goldenPathFor, loadAllFixtures, relativeToRepo } from "../helpers/fixtures.js";

const fixtures = await loadAllFixtures("duckdb");
const STAGES = ["parsed", "normalized", "metrics", "findings", "hotspots"];

test("DuckDB fixture set is Estimated text only with explicit provenance", () => {
  assert.equal(fixtures.length, 5);
  assert.deepEqual(MODES_BY_DATABASE.duckdb, ["estimated"]);
  assert.equal(fixtures.find((fixture) => fixture.name === "official-hash-join-filter")?.meta.source.kind, "official");
  assert.equal(fixtures.filter((fixture) => fixture.meta.source.kind === "synthetic").length, 4);
  assert.deepEqual(new Set(fixtures.map((fixture) => fixture.meta.format)), new Set(["text"]));
});

for (const stage of STAGES) {
  test(`DuckDB pipeline stage "${stage}" matches its golden fixture`, async (t) => {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        const goldenPath = goldenPathFor(fixture.mode, fixture.name, "duckdb");
        const golden = JSON.parse(await readFile(goldenPath, "utf8"));
        const analysis = analyzePlan(fixture.input);
        assert.deepStrictEqual(
          analysis[stage],
          golden[stage],
          `${relativeToRepo(goldenPath)} is stale for ${stage}; review and regenerate the intended DuckDB golden output.`,
        );
      });
    }
  });
}

test("all DuckDB fixtures keep cost and actual runtime fields null while mapping EC to estimatedRows", () => {
  for (const fixture of fixtures) {
    const result = analyzePlan(fixture.input);
    assert.equal(result.parsed.database, "duckdb");
    assert.equal(result.normalized.database, "duckdb");
    assert.equal(result.normalized.root.nodeType, fixture.meta.expect.rootNodeType);
    assert.ok(result.metrics.maxDepth >= fixture.meta.expect.minDepth);
    assert.equal(result.metrics.totalEstimatedCost, null);
    assert.equal(result.metrics.highestIncrementalCost, null);
    assert.equal(result.metrics.costAttribution.engine, "duckdb");
    assert.equal(result.metrics.costAttribution.status, "not-applicable");
    assert.equal(
      flattenNodes(result.normalized.root).some(
        (node) =>
          node.totalCost !== null ||
          node.startupCost !== null ||
          node.actualRows !== null ||
          node.actualTotalTime !== null ||
          node.loops !== null,
      ),
      false,
    );
    assert.deepEqual(
      result.findings.map((finding) => finding.ruleId),
      fixture.meta.expect.findingRuleIds,
    );
  }
});

test("DuckDB golden directory mirrors the estimated fixture directory", async () => {
  const expected = fixtures.map((fixture) => `${fixture.name}.json`).sort();
  const actual = (await readdir(new URL("../../fixtures/duckdb/golden/estimated/", import.meta.url)))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  assert.deepEqual(actual, expected);
});
