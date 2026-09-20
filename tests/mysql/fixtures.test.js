import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { flattenNodes } from "../../src/core/tree.js";
import { MODES_BY_DATABASE, goldenPathFor, loadAllFixtures, relativeToRepo } from "../helpers/fixtures.js";

/**
 * Fixture-driven MySQL contract.
 *
 * The golden files pin the full offline pipeline for every committed MySQL
 * fixture:
 *
 *     raw plan -> parsed -> normalized -> metrics -> findings
 *
 * The metadata sidecars are a second, independent assertion of the behavior the
 * fixture is meant to pin.
 */

const fixtures = await loadAllFixtures("mysql");
const STAGES = ["parsed", "normalized", "metrics", "findings", "hotspots"];

test("the MySQL fixture set is non-empty and estimated-only", () => {
  assert.ok(fixtures.length >= 8, `expected at least 8 MySQL fixtures, found ${fixtures.length}`);
  assert.deepEqual([...new Set(fixtures.map((fixture) => fixture.mode))], ["estimated"]);
});

test("every MySQL fixture is explicitly synthetic", () => {
  for (const fixture of fixtures) {
    assert.equal(fixture.meta.source.kind, "synthetic", `${fixture.name} must declare its synthetic provenance`);
    assert.match(fixture.name, /\.synthetic$/, `${fixture.name} must be marked in the file name`);
    assert.equal(fixture.meta.source.reference?.startsWith("http"), true, `${fixture.name} must reference the observed shape`);
  }
});

for (const stage of STAGES) {
  test(`pipeline stage "${stage}" matches the committed golden file for every MySQL fixture`, async (t) => {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        const file = goldenPathFor(fixture.mode, fixture.name, "mysql");
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

test("MySQL golden files pin all five stages and nothing else", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const file = goldenPathFor(fixture.mode, fixture.name, "mysql");
      const golden = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(Object.keys(golden).sort(), [...STAGES].sort(), `${relativeToRepo(file)} must contain the five pipeline stages`);
    });
  }
});

test("MySQL golden directory mirrors the fixture directory and has no orphans", async () => {
  const mode = "estimated";
  const expected = fixtures.filter((fixture) => fixture.mode === mode).map((fixture) => `${fixture.name}.json`).sort();
  const actual = (await readdir(new URL(`../../fixtures/mysql/golden/${mode}/`, import.meta.url)))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  assert.deepEqual(actual, expected, `fixtures/mysql/golden/${mode} must mirror fixtures/mysql/${mode}`);
});

test("every MySQL fixture parses and matches the behavior recorded in its metadata", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const analysis = analyzePlan(fixture.input);

      assert.equal(analysis.parsed.database, "mysql");
      assert.equal(analysis.parsed.root.nodeType, fixture.meta.expect.rootNodeType, "root node type");
      assert.ok(
        analysis.metrics.maxDepth >= fixture.meta.expect.minDepth,
        `expected depth >= ${fixture.meta.expect.minDepth}, got ${analysis.metrics.maxDepth}`,
      );
      assert.equal(analysis.metrics.nodeCount >= 1, true);

      const hasActualValues = flattenNodes(analysis.normalized.root).some(
        (node) => node.actualRows !== null || node.actualTotalTime !== null || node.loops !== null,
      );
      assert.equal(hasActualValues, fixture.meta.expect.hasActualFields, "actual-execution fields must match metadata");
      assert.equal(hasActualValues, false, "MySQL estimated JSON has no runtime fields");

      const ruleIds = [...new Set(analysis.findings.map((finding) => finding.ruleId))].sort();
      assert.deepEqual(
        ruleIds,
        [...new Set(fixture.meta.expect.findingRuleIds)].sort(),
        "rule ids in fixture metadata must match the rules that actually fired",
      );
    });
  }
});

test("the fixture set covers the MySQL access types and structures this parser claims", () => {
  const accessTypes = new Set();
  const kinds = new Set();
  const structures = new Set();

  for (const fixture of fixtures) {
    const analysis = analyzePlan(fixture.input);
    for (const node of flattenNodes(analysis.parsed.root)) {
      if (node.mysql.accessType !== null) accessTypes.add(node.mysql.accessType);
      structures.add(node.structure);
    }
    for (const node of flattenNodes(analysis.normalized.root)) kinds.add(node.kind);
  }

  for (const accessType of ["ALL", "ref", "eq_ref", "const", "range"]) {
    assert.ok(accessTypes.has(accessType), `fixture set must exercise access_type ${accessType}`);
  }
  for (const kind of ["query_block", "seq_scan", "index_scan", "const_scan", "nested_loop", "sort", "aggregate", "append", "subquery", "materialize"]) {
    assert.ok(kinds.has(kind), `fixture set must exercise normalized kind "${kind}"`);
  }
  for (const structure of ["query_block", "table", "nested_loop", "ordering_operation", "grouping_operation", "union_result", "materialized_from_subquery", "attached_subqueries"]) {
    assert.ok(structures.has(structure), `fixture set must exercise structure ${structure}`);
  }
});

test("MySQL pipeline is deterministic and JSON-serializable", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const first = analyzePlan(fixture.input);
      const second = analyzePlan(fixture.input);
      assert.deepStrictEqual(first, second, "two runs over the same input must be identical");
      assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), first, "pipeline output must survive a JSON round-trip");
    });
  }
});

test("MySQL has no actual fixture directory by design", async () => {
  assert.deepEqual(MODES_BY_DATABASE.mysql, ["estimated"]);
  await assert.rejects(readdir(new URL("../../fixtures/mysql/actual/", import.meta.url)), (error) => error.code === "ENOENT");
});
