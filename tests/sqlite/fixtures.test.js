import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { flattenNodes } from "../../src/core/tree.js";
import { MODES_BY_DATABASE, goldenPathFor, loadAllFixtures, relativeToRepo } from "../helpers/fixtures.js";

const fixtures = await loadAllFixtures("sqlite");
const STAGES = ["parsed", "normalized", "metrics", "findings", "hotspots"];

test("SQLite fixture set is Estimated JSON only with explicit provenance", () => {
  assert.equal(fixtures.length, 6);
  assert.deepEqual(MODES_BY_DATABASE.sqlite, ["estimated"]);
  assert.equal(fixtures.filter((fixture) => fixture.meta.source.kind === "locally-generated").length, 5);
  assert.equal(fixtures.filter((fixture) => fixture.meta.source.kind === "synthetic").length, 1);
  assert.deepEqual(new Set(fixtures.map((fixture) => fixture.meta.format)), new Set(["json"]));
});

for (const stage of STAGES) {
  test(`SQLite pipeline stage "${stage}" matches its golden fixture`, async (t) => {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        const goldenPath = goldenPathFor(fixture.mode, fixture.name, "sqlite");
        const golden = JSON.parse(await readFile(goldenPath, "utf8"));
        const analysis = analyzePlan(fixture.input);
        assert.deepStrictEqual(
          analysis[stage],
          golden[stage],
          `${relativeToRepo(goldenPath)} is stale for ${stage}; review and regenerate the intended SQLite golden output.`,
        );
      });
    }
  });
}

test("all SQLite fixtures keep unavailable cost and row-count fields null", () => {
  for (const fixture of fixtures) {
    const result = analyzePlan(fixture.input);
    assert.equal(result.parsed.database, "sqlite");
    assert.equal(result.normalized.database, "sqlite");
    assert.equal(result.normalized.root.nodeType, "SQLite Query Plan");
    assert.ok(result.metrics.maxDepth >= fixture.meta.expect.minDepth);
    assert.equal(result.metrics.totalEstimatedCost, null);
    assert.equal(result.metrics.rootEstimatedRows, null);
    assert.equal(result.metrics.largestEstimatedRows, null);
    assert.equal(result.metrics.highestIncrementalCost, null);
    assert.equal(result.metrics.costAttribution.engine, "sqlite");
    assert.equal(result.metrics.costAttribution.status, "not-applicable");
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.hotspots.items, []);
    assert.equal(
      flattenNodes(result.normalized.root).some(
        (node) =>
          node.estimatedRows !== null ||
          node.totalCost !== null ||
          node.startupCost !== null ||
          node.actualRows !== null ||
          node.actualTotalTime !== null ||
          node.loops !== null,
      ),
      false,
    );
  }
});

test("SQLite golden directory mirrors the estimated fixture directory", async () => {
  const expected = fixtures.map((fixture) => `${fixture.name}.json`).sort();
  const actual = (await readdir(new URL("../../fixtures/sqlite/golden/estimated/", import.meta.url)))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  assert.deepEqual(actual, expected);
});
