import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { walkNodes } from "../../src/core/tree.js";
import { loadAllFixtures } from "../helpers/fixtures.js";

/**
 * MySQL hotspot behavior.
 *
 * MySQL costs live in MySQL's own cost model: a hotspot must never reuse
 * PostgreSQL cost semantics or PostgreSQL reason codes. These tests pin the
 * rows-based signals and the MySQL-only cost concentration independently of
 * the golden files.
 */

const fixtures = await loadAllFixtures("mysql");
const analysisByFixture = new Map(fixtures.map((fixture) => [fixture.name, analyzePlan(fixture.input)]));

const MYSQL_REASON_CODES = new Set([
  "large-sequential-scan",
  "nested-loop-amplification",
  "mysql-rows-examined",
  "mysql-filtered-out",
  "mysql-cost-concentration",
  "mysql-filesort",
  "mysql-temporary-table",
  "mysql-join-buffer",
]);
const PG_ONLY_REASON_CODES = new Set(["cost-concentration", "expensive-sort"]);
const PG_ONLY_EVIDENCE_KEYS = ["selfCost", "selfCostShare", "estimatedTotalCost"];

/** @param {string} name */
function analysisFor(name) {
  const analysis = analysisByFixture.get(name);
  assert.ok(analysis, `missing fixture ${name}`);
  return analysis;
}

test("every declared hotspot order matches the deterministic attention order", () => {
  for (const fixture of fixtures) {
    const expected = fixture.meta.expect.hotspotNodeRefs;
    if (expected === undefined) continue;
    const actual = analysisFor(fixture.name).hotspots.items.map((hotspot) => hotspot.nodeId);
    assert.deepEqual(actual, expected, `${fixture.name} hotspot order`);
  }
});

test("MySQL hotspots never use PostgreSQL cost semantics", () => {
  for (const fixture of fixtures) {
    const analysis = analysisFor(fixture.name);
    assert.equal(analysis.hotspots.cost.engine, "mysql");

    for (const hotspot of analysis.hotspots.items) {
      for (const reason of hotspot.reasons) {
        assert.equal(MYSQL_REASON_CODES.has(reason.code), true, `${fixture.name}: unexpected reason ${reason.code}`);
        assert.equal(PG_ONLY_REASON_CODES.has(reason.code), false, `${fixture.name}: PostgreSQL-only reason on MySQL`);
      }
      for (const key of PG_ONLY_EVIDENCE_KEYS) {
        assert.equal(key in hotspot.evidence, false, `${fixture.name}: PostgreSQL-only evidence key ${key}`);
      }
    }
  }
});

test("large-table-scan reports a rows-based hotspot", () => {
  const analysis = analysisFor("large-table-scan.synthetic");

  assert.deepEqual(analysis.hotspots.items.map((hotspot) => hotspot.nodeId), ["0.0"]);
  const [hotspot] = analysis.hotspots.items;
  assert.equal(hotspot.level, "high");
  assert.deepEqual(hotspot.reasons.map((reason) => reason.code), ["large-sequential-scan"]);
  assert.equal(hotspot.reasons[0].source, "table.rows_examined_per_scan");
  assert.equal(hotspot.reasons[0].evidence.estimatedRows, 240_000);
  assert.match(hotspot.reasons[0].statement, /examine 240000 rows per scan/);
  assert.equal(hotspot.evidence.accessType, "ALL");
});

test("nested-loop-large-inner reports amplification plus MySQL cost concentration", () => {
  const analysis = analysisFor("nested-loop-large-inner.synthetic");

  assert.deepEqual(analysis.hotspots.items.map((hotspot) => hotspot.nodeId), ["0.0.1", "0.0"]);

  const inner = analysis.hotspots.items[0];
  assert.equal(inner.level, "high");
  assert.deepEqual(inner.reasons.map((reason) => reason.code), [
    "mysql-cost-concentration",
    "large-sequential-scan",
  ]);
  assert.equal(inner.reasons[0].evidence.accessCost, 10_000);
  assert.equal(inner.reasons[0].evidence.queryCost, 10_500);
  assert.equal(inner.reasons[0].evidence.costShare, 0.9524);

  const join = analysis.hotspots.items[1];
  assert.equal(join.level, "warning");
  assert.deepEqual(join.reasons.map((reason) => reason.code), ["nested-loop-amplification"]);
  assert.equal(join.reasons[0].evidence.outerEstimatedRows, 1_000);
  assert.equal(join.reasons[0].evidence.innerEstimatedRows, 50_000);
});

test("complex-mixed concentrates MySQL cost inside the enclosing query block", () => {
  const analysis = analysisFor("complex-mixed.synthetic");
  assert.deepEqual(analysis.hotspots.items.map((hotspot) => hotspot.nodeId), ["0.0.0.0.1", "0.0.0.0.0.0"]);

  for (const hotspot of analysis.hotspots.items) {
    assert.deepEqual(hotspot.reasons.map((reason) => reason.code), ["mysql-cost-concentration"]);
    assert.equal(hotspot.reasons[0].evidence.blockNodeRef, "0", "the root query block owns the table accesses");
  }
  assert.equal(analysis.hotspots.items[0].reasons[0].evidence.costShare, 0.6222);
  assert.equal(analysis.hotspots.items[1].reasons[0].level, "warning");
});

test("table-scan reports discarded rows through the MySQL filtered signal", () => {
  const analysis = analysisFor("table-scan.synthetic");
  assert.deepEqual(analysis.hotspots.items.map((hotspot) => hotspot.nodeId), ["0.0"]);
  const [reason] = analysis.hotspots.items[0].reasons;
  assert.equal(reason.code, "mysql-filtered-out");
  assert.equal(reason.level, "warning");
  assert.equal(reason.source, "table.filtered");
});

test("small and single-access MySQL plans stay silent", () => {
  for (const name of ["const-lookup.synthetic", "ordering-filesort.synthetic", "nested-loop-join.synthetic", "index-lookup.synthetic", "grouping-temporary.synthetic", "future-shape.synthetic", "union-result.synthetic"]) {
    assert.deepEqual(analysisFor(name).hotspots.items, [], `${name} must not report hotspots`);
  }
});

test("every MySQL hotspot points at a real node", () => {
  for (const fixture of fixtures) {
    const analysis = analysisFor(fixture.name);
    const nodeIds = new Set([...walkNodes(analysis.normalized.root)].map((node) => node.id));
    for (const hotspot of analysis.hotspots.items) {
      assert.equal(nodeIds.has(hotspot.nodeId), true, `${fixture.name}: ${hotspot.nodeId} must exist in the tree`);
      assert.equal(hotspot.estimateOnly, true);
    }
  }
});
