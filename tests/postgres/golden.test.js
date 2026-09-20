import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { MODES, goldenPathFor, loadAllFixtures, relativeToRepo } from "../helpers/fixtures.js";

const fixtures = await loadAllFixtures();

const STAGES = ["parsed", "normalized", "metrics", "findings"];

for (const stage of STAGES) {
  test(`pipeline stage "${stage}" matches the committed golden file for every fixture`, async (t) => {
    for (const fixture of fixtures) {
      await t.test(`${fixture.mode}/${fixture.name}`, async () => {
        const file = goldenPathFor(fixture.mode, fixture.name);
        const golden = JSON.parse(await readFile(file, "utf8"));
        const analysis = analyzePlan(fixture.input);
        assert.deepStrictEqual(
          analysis[stage],
          golden[stage],
          `${relativeToRepo(file)} is stale for stage "${stage}". If the pipeline change is intentional, run: npm run test:update-goldens`,
        );
      });
    }
  });
}

test("every golden file pins all four pipeline stages and nothing else", async (t) => {
  for (const fixture of fixtures) {
    await t.test(`${fixture.mode}/${fixture.name}`, async () => {
      const file = goldenPathFor(fixture.mode, fixture.name);
      const golden = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(Object.keys(golden).sort(), [...STAGES].sort(), `${relativeToRepo(file)} must contain the four pipeline stages`);
    });
  }
});

test("golden directory contains no orphan files", async () => {
  for (const mode of MODES) {
    const expected = fixtures
      .filter((fixture) => fixture.mode === mode)
      .map((fixture) => `${fixture.name}.json`)
      .sort();
    const actual = (await readdir(new URL(`../../fixtures/postgres/golden/${mode}/`, import.meta.url)))
      .filter((entry) => entry.endsWith(".json"))
      .sort();
    assert.deepEqual(actual, expected, `fixtures/postgres/golden/${mode} must mirror fixtures/postgres/${mode}`);
  }
});

test("the pipeline is deterministic and JSON-serializable", async (t) => {
  for (const fixture of fixtures) {
    await t.test(`${fixture.mode}/${fixture.name}`, () => {
      const first = analyzePlan(fixture.input);
      const second = analyzePlan(fixture.input);
      assert.deepStrictEqual(first, second, "two runs over the same input must be identical");

      const roundTripped = JSON.parse(JSON.stringify(first));
      assert.deepStrictEqual(roundTripped, first, "pipeline output must survive a JSON round-trip unchanged");
    });
  }
});
