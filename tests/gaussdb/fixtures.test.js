import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { flattenNodes } from "../../src/core/tree.js";
import { MODES_BY_DATABASE, GAUSSDB_FIXTURES_DIR, goldenPathFor, loadAllFixtures, planSuffixFor, relativeToRepo } from "../helpers/fixtures.js";

const fixtures = await loadAllFixtures("gaussdb");
const STAGES = ["parsed", "normalized", "metrics", "findings", "hotspots"];

test("GaussDB fixtures are synthetic, estimated-only JSON inputs", () => {
  assert.equal(fixtures.length, 3);
  assert.deepEqual(MODES_BY_DATABASE.gaussdb, ["estimated"]);
  assert.equal(planSuffixFor("gaussdb"), ".plan.json");
  assert.equal(fixtures.every((fixture) => fixture.meta.format === "json" && Array.isArray(fixture.plan)), true);
  assert.equal(fixtures.every((fixture) => fixture.meta.source.kind === "synthetic"), true);
  assert.equal(fixtures.some((fixture) => fixture.mode === "actual"), false);
  assert.equal(fixtures.every((fixture) => fixture.meta.databaseVersion === null && fixture.meta.sql === null), true);
});

for (const stage of STAGES) {
  test(`GaussDB golden stage "${stage}" matches every fixture`, async (t) => {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        const file = goldenPathFor(fixture.mode, fixture.name, "gaussdb");
        const golden = JSON.parse(await readFile(file, "utf8"));
        const analysis = analyzePlan(fixture.input);
        assert.deepEqual(analysis[stage], golden[stage], `${relativeToRepo(file)} is stale; review before updating goldens`);
      });
    }
  });
}

test("GaussDB golden directory mirrors all fixture plans and pins every pipeline stage", async () => {
  const expected = fixtures.map((fixture) => `${fixture.name}.json`).sort();
  const actual = (await readdir(`${GAUSSDB_FIXTURES_DIR}/golden/estimated`)).filter((entry) => entry.endsWith(".json")).sort();
  assert.deepEqual(actual, expected);
  for (const fixture of fixtures) {
    const golden = JSON.parse(await readFile(goldenPathFor(fixture.mode, fixture.name, "gaussdb"), "utf8"));
    assert.deepEqual(Object.keys(golden).sort(), [...STAGES].sort());
  }
});

test("DWS JSON parsing is deterministic and retains native fields without actual values", () => {
  for (const fixture of fixtures) {
    const first = analyzePlan(fixture.input);
    const second = analyzePlan(fixture.input);
    assert.deepEqual(first, second);
    assert.equal(first.normalized.database, "gaussdb");
    for (const node of flattenNodes(first.normalized.root)) {
      assert.equal(node.actualRows, null);
      assert.equal(node.actualTotalTime, null);
      assert.equal(node.loops, null);
      assert.equal(node.startupCost, null);
      assert.equal(node.totalCost, null);
      assert.equal(node.engineSpecific.database, "gaussdb");
      assert.equal(typeof node.engineSpecific.gaussdb, "object");
    }
  }
});
