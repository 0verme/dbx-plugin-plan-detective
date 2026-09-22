import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { flattenNodes } from "../../src/core/tree.js";
import { MODES_BY_DATABASE, goldenPathFor, loadAllFixtures, planSuffixFor, relativeToRepo } from "../helpers/fixtures.js";

/**
 * Fixture-driven OceanBase Oracle contract.
 *
 * The golden files pin the full offline pipeline for every committed JSON
 * fixture:
 *
 *     raw plan -> parsed -> normalized -> metrics -> findings -> hotspots
 *
 * The metadata sidecars are a second, independent assertion of the behavior the
 * fixture is meant to pin.
 */

const fixtures = await loadAllFixtures("oceanbase-oracle");
const STAGES = ["parsed", "normalized", "metrics", "findings", "hotspots"];

test("the OceanBase Oracle fixture set is non-empty and estimated-only", () => {
  assert.ok(fixtures.length >= 11, `expected at least 11 OceanBase Oracle fixtures, found ${fixtures.length}`);
  assert.deepEqual([...new Set(fixtures.map((fixture) => fixture.mode))], ["estimated"]);
  assert.deepEqual(MODES_BY_DATABASE["oceanbase-oracle"], ["estimated"]);
  assert.equal(planSuffixFor("oceanbase-oracle"), ".plan.json");
});

test("every OceanBase Oracle fixture declares how its shape was verified", () => {
  for (const fixture of fixtures) {
    assert.equal(fixture.meta.format, "json");
    assert.equal(typeof fixture.plan, "object", `${fixture.name} must commit a decoded JSON plan object`);
    assert.equal(Array.isArray(fixture.plan), false, `${fixture.name} must commit a plan node object`);

    const markedSynthetic = fixture.name.includes(".synthetic");
    assert.equal(
      markedSynthetic,
      fixture.meta.source.kind === "synthetic",
      `${fixture.name}: the .synthetic file name and source.kind must agree`,
    );
    assert.equal(
      typeof fixture.meta.source.reference === "string" && fixture.meta.source.reference.startsWith("http"),
      true,
      `${fixture.name} must reference the public shape source it was checked against`,
    );
  }

  const official = fixtures.filter((fixture) => fixture.meta.source.kind === "official");
  assert.equal(official.length, 1, "the documented OceanBase Oracle example is the only non-synthetic fixture");
  assert.equal(official[0].name, "hash-join");
  assert.match(official[0].meta.databaseVersion, /^4\./);
});

for (const stage of STAGES) {
  test(`pipeline stage "${stage}" matches the committed golden file for every OceanBase Oracle fixture`, async (t) => {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        const file = goldenPathFor(fixture.mode, fixture.name, "oceanbase-oracle");
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

test("OceanBase Oracle golden files pin all five stages and nothing else", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const file = goldenPathFor(fixture.mode, fixture.name, "oceanbase-oracle");
      const golden = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(Object.keys(golden).sort(), [...STAGES].sort(), `${relativeToRepo(file)} must contain the five pipeline stages`);
    });
  }
});

test("the OceanBase Oracle golden directory mirrors the fixture directory and has no orphans", async () => {
  const mode = "estimated";
  const expected = fixtures.map((fixture) => `${fixture.name}.json`).sort();
  const actual = (await readdir(new URL(`../../fixtures/oceanbase-oracle/golden/${mode}/`, import.meta.url)))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  assert.deepEqual(actual, expected, `fixtures/oceanbase-oracle/golden/${mode} must mirror fixtures/oceanbase-oracle/${mode}`);
});

test("every OceanBase Oracle fixture matches the behavior recorded in its metadata", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const analysis = analyzePlan(fixture.input);

      assert.equal(analysis.parsed.database, "oceanbase-oracle");
      assert.equal(analysis.parsed.format, "json");
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
      assert.equal(hasActualValues, false, "an estimated OceanBase Oracle plan has no runtime fields");

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

test("the fixture set covers the OceanBase Oracle operators and fields this parser claims", () => {
  const operators = new Set();
  const kinds = new Set();
  const engineFields = new Set();
  const extraKeys = new Set();

  for (const fixture of fixtures) {
    const analysis = analyzePlan(fixture.input);
    for (const node of flattenNodes(analysis.parsed.root)) {
      if (node.operator !== null) operators.add(node.operator);
    }
    for (const node of flattenNodes(analysis.normalized.root)) {
      kinds.add(node.kind);
      for (const [key, value] of Object.entries(node.engineSpecific.oceanBase)) {
        if (value !== null && value !== undefined) engineFields.add(key);
      }
      for (const key of Object.keys(node.engineSpecific.extra)) extraKeys.add(key);
    }
  }

  for (const operator of [
    "TABLE FULL SCAN",
    "TABLE RANGE SCAN",
    "TABLE GET",
    "NESTED-LOOP JOIN",
    "HASH JOIN",
    "SORT",
    "SCALAR GROUP BY",
    "LIMIT",
    "MATERIAL",
    "UNION ALL",
    "EXCHANGE OUT DISTRIBUTED",
    "PX FUTURE SHUFFLE",
  ]) {
    assert.ok(operators.has(operator), `fixture set must exercise operator "${operator}"`);
  }

  for (const kind of ["seq_scan", "index_scan", "nested_loop", "hash_join", "sort", "aggregate", "limit", "materialize", "append", "unknown"]) {
    assert.ok(kinds.has(kind), `fixture set must exercise normalized kind "${kind}"`);
  }

  for (const field of ["id", "operator", "name", "estimatedRows", "estimatedTimeUs", "output"]) {
    assert.ok(engineFields.has(field), `fixture set must exercise engineSpecific.oceanBase.${field}`);
  }

  for (const key of ["filter", "access", "use_hash", "gi_partition_id", "CHILD_9"]) {
    assert.ok(extraKeys.has(key), `fixture set must exercise the preserved extra member "${key}"`);
  }
});

test("the OceanBase Oracle pipeline is deterministic and JSON-serializable", async (t) => {
  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      const first = analyzePlan(fixture.input);
      const second = analyzePlan(fixture.input);
      assert.deepStrictEqual(first, second);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), first);
    });
  }
});
