import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { flattenNodes } from "../../src/core/tree.js";
import { MODES_BY_DATABASE, goldenPathFor, loadAllFixtures, planSuffixFor, relativeToRepo } from "../helpers/fixtures.js";

/**
 * Fixture-driven SQL Server contract.
 *
 * The golden files pin the full offline pipeline for every committed
 * ShowPlanXML fixture:
 *
 *     raw plan -> parsed -> normalized -> metrics -> findings -> hotspots
 *
 * The metadata sidecars are a second, independent assertion of the behavior the
 * fixture is meant to pin.
 */

const fixtures = await loadAllFixtures("sqlserver");
const STAGES = ["parsed", "normalized", "metrics", "findings", "hotspots"];

test("the SQL Server fixture set is non-empty and estimated-only", () => {
  assert.ok(fixtures.length >= 10, `expected at least 10 SQL Server fixtures, found ${fixtures.length}`);
  assert.deepEqual([...new Set(fixtures.map((fixture) => fixture.mode))], ["estimated"]);
});

test("every SQL Server fixture is explicitly synthetic", () => {
  for (const fixture of fixtures) {
    assert.equal(fixture.meta.source.kind, "synthetic", `${fixture.name} must declare its synthetic provenance`);
    assert.match(fixture.name, /\.synthetic$/, `${fixture.name} must be marked in the file name`);
    assert.equal(fixture.meta.source.reference?.startsWith("http"), true, `${fixture.name} must reference the observed shape`);
    assert.equal(fixture.meta.format, "xml");
    assert.equal(typeof fixture.plan, "string", `${fixture.name} must commit the raw ShowPlanXML string`);
  }
});

for (const stage of STAGES) {
  test(`pipeline stage "${stage}" matches the committed golden file for every SQL Server fixture`, async (t) => {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        const file = goldenPathFor(fixture.mode, fixture.name, "sqlserver");
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

test("SQL Server golden files pin all five stages and nothing else", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const file = goldenPathFor(fixture.mode, fixture.name, "sqlserver");
      const golden = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(Object.keys(golden).sort(), [...STAGES].sort(), `${relativeToRepo(file)} must contain the five pipeline stages`);
    });
  }
});

test("SQL Server golden directory mirrors the fixture directory and has no orphans", async () => {
  const mode = "estimated";
  const expected = fixtures.map((fixture) => `${fixture.name}.json`).sort();
  const actual = (await readdir(new URL(`../../fixtures/sqlserver/golden/${mode}/`, import.meta.url)))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  assert.deepEqual(actual, expected, `fixtures/sqlserver/golden/${mode} must mirror fixtures/sqlserver/${mode}`);
});

test("every SQL Server fixture parses and matches the behavior recorded in its metadata", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const analysis = analyzePlan(fixture.input);

      assert.equal(analysis.parsed.database, "sqlserver");
      assert.equal(analysis.parsed.format, "xml");
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
      assert.equal(hasActualValues, false, "estimated ShowPlanXML has no runtime fields");

      const ruleIds = [...new Set(analysis.findings.map((finding) => finding.ruleId))].sort();
      assert.deepEqual(
        ruleIds,
        [...new Set(fixture.meta.expect.findingRuleIds)].sort(),
        "rule ids in fixture metadata must match the rules that actually fired",
      );

      if (fixture.meta.expect.hotspotNodeRefs !== undefined) {
        assert.deepEqual(
          analysis.hotspots.items.map((hotspot) => hotspot.nodeId),
          fixture.meta.expect.hotspotNodeRefs,
          "hotspot order in fixture metadata must match the deterministic attention order",
        );
      }
    });
  }
});

test("the fixture set covers the SQL Server operators and kinds this parser claims", () => {
  const physicalOps = new Set();
  const kinds = new Set();
  const engineFields = new Set();
  const neutralFields = new Set();

  for (const fixture of fixtures) {
    const analysis = analyzePlan(fixture.input);
    for (const node of flattenNodes(analysis.parsed.root)) {
      if (node.physicalOp !== null) physicalOps.add(node.physicalOp);
    }
    for (const node of flattenNodes(analysis.normalized.root)) {
      kinds.add(node.kind);
      for (const key of ["indexCondition", "sortKeys", "groupKeys", "filter", "joinType"]) {
        if (node[key] !== null && node[key] !== undefined) neutralFields.add(key);
      }
      for (const [key, value] of Object.entries(node.engineSpecific.sqlServer)) {
        if (value !== null && value !== undefined) engineFields.add(key);
      }
    }
  }

  for (const physicalOp of [
    "Table Scan",
    "Index Scan",
    "Clustered Index Scan",
    "Clustered Index Seek",
    "Index Seek",
    "Nested Loops",
    "Hash Match",
    "Merge Join",
    "Sort",
    "Stream Aggregate",
    "Compute Scalar",
    "Filter",
    "Concatenation",
    "Parallelism",
    "Top",
    "Constant Scan",
    "Future Shuffle",
  ]) {
    assert.ok(physicalOps.has(physicalOp), `fixture set must exercise PhysicalOp "${physicalOp}"`);
  }

  for (const kind of [
    "seq_scan",
    "index_scan",
    "nested_loop",
    "hash_join",
    "merge_join",
    "sort",
    "aggregate",
    "compute_scalar",
    "filter",
    "append",
    "parallelism",
    "limit",
    "values_scan",
    "unknown",
  ]) {
    assert.ok(kinds.has(kind), `fixture set must exercise normalized kind "${kind}"`);
  }

  for (const field of ["indexCondition", "sortKeys", "groupKeys", "filter", "joinType"]) {
    assert.ok(neutralFields.has(field), `fixture set must exercise neutral field "${field}"`);
  }
  for (const field of [
    "estimatedTotalSubtreeCost",
    "estimateCpu",
    "estimateIo",
    "table",
    "index",
    "alias",
    "operator",
    "hashKeysBuild",
    "hashKeysProbe",
    "probeResidual",
    "residual",
    "definedValues",
  ]) {
    assert.ok(engineFields.has(field), `fixture set must exercise engineSpecific.sqlServer.${field}`);
  }
});

test("SQL Server pipeline is deterministic and JSON-serializable", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const first = analyzePlan(fixture.input);
      const second = analyzePlan(fixture.input);
      assert.deepStrictEqual(first, second, "two runs over the same input must be identical");
      assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), first, "pipeline output must survive a JSON round-trip");
    });
  }
});

test("SQL Server has no actual fixture directory by design", async () => {
  assert.deepEqual(MODES_BY_DATABASE.sqlserver, ["estimated"]);
  assert.equal(planSuffixFor("sqlserver"), ".plan.xml");
  await assert.rejects(readdir(new URL("../../fixtures/sqlserver/actual/", import.meta.url)), (error) => error.code === "ENOENT");
});
