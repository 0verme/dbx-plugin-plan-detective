import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { analyzePostgresCost } from "../../src/core/hotspots/self-cost.js";
import { walkNodes } from "../../src/core/tree.js";
import { loadAllFixtures, loadFixture } from "../helpers/fixtures.js";

/**
 * Fixture-level hotspot behavior.
 *
 * The golden files pin the exact hotspot output; these tests pin the *intent*
 * independently: which fixtures are positive/negative, why the PostgreSQL cost
 * signals are withheld where they are, and that `expect.hotspotNodeRefs`
 * (when declared) matches the deterministic attention order.
 */

const fixtures = await loadAllFixtures("postgresql");
const analysisByFixture = new Map(
  fixtures.map((fixture) => [`${fixture.mode}/${fixture.name}`, analyzePlan(fixture.input)]),
);

const PG_REASON_CODES = new Set(["cost-concentration", "large-sequential-scan", "nested-loop-amplification"]);
const LEVEL_RANK = { high: 0, warning: 1, info: 2 };

/** @param {string} key */
function analysisFor(key) {
  const analysis = analysisByFixture.get(key);
  assert.ok(analysis, `missing fixture ${key}`);
  return analysis;
}

test("every declared hotspot order matches the deterministic attention order", () => {
  for (const fixture of fixtures) {
    const expected = fixture.meta.expect.hotspotNodeRefs;
    if (expected === undefined) continue;
    const actual = analysisFor(`${fixture.mode}/${fixture.name}`).hotspots.items.map((hotspot) => hotspot.nodeId);
    assert.deepEqual(actual, expected, `${fixture.mode}/${fixture.name} hotspot order`);
  }
});

test("every PostgreSQL hotspot points at a real node with a strongest-first reason list", () => {
  for (const fixture of fixtures) {
    const analysis = analysisFor(`${fixture.mode}/${fixture.name}`);
    const nodeIds = new Set([...walkNodes(analysis.normalized.root)].map((node) => node.id));

    for (const hotspot of analysis.hotspots.items) {
      assert.equal(nodeIds.has(hotspot.nodeId), true, `${fixture.name}: ${hotspot.nodeId} must exist in the tree`);
      assert.equal(hotspot.level, hotspot.reasons[0].level, `${fixture.name}: level must be the strongest reason`);
      assert.ok(["high", "warning", "info"].includes(hotspot.level), `${fixture.name}: invalid level`);
      for (const reason of hotspot.reasons) {
        assert.equal(PG_REASON_CODES.has(reason.code), true, `${fixture.name}: unexpected reason ${reason.code}`);
        assert.equal("rowsExaminedPerScan" in hotspot.evidence, false, `${fixture.name}: no MySQL fields on PostgreSQL`);
      }
      const ranks = hotspot.reasons.map((reason) => LEVEL_RANK[reason.level]);
      assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${fixture.name}: reasons must be strongest-first`);
    }
  }
});

test("bitmap-scan is a hotspot without any rule finding", () => {
  const analysis = analysisFor("estimated/bitmap-scan");

  assert.deepEqual(analysis.findings, [], "the bitmap plan does not trip a rule");
  assert.deepEqual(analysis.hotspots.items.map((hotspot) => hotspot.nodeId), ["0"]);

  const [hotspot] = analysis.hotspots.items;
  assert.equal(hotspot.kind, "bitmap_heap_scan");
  assert.equal(hotspot.level, "high");
  assert.deepEqual(hotspot.reasons.map((reason) => reason.code), ["cost-concentration"]);
  assert.equal(hotspot.reasons[0].source, "Total Cost");
  assert.match(hotspot.reasons[0].statement, /estimated self cost/);
});

test("large-seq-scan combines cost concentration and a large row estimate", () => {
  const analysis = analysisFor("estimated/large-seq-scan");
  const [hotspot] = analysis.hotspots.items;

  assert.deepEqual(hotspot.reasons.map((reason) => reason.code), ["cost-concentration", "large-sequential-scan"]);
  assert.equal(hotspot.level, "high");
  assert.equal(hotspot.evidence.estimatedRows, 200_000);
  assert.equal(hotspot.evidence.estimatedTotalCost, 3_497);
  assert.equal(hotspot.evidence.selfCost, 3_497);
  assert.equal(hotspot.reasons[1].evidence.thresholds.highEstimatedRows, 100_000);
});

test("negative fixtures stay silent", () => {
  for (const key of [
    "estimated/index-scan",
    "estimated/seq-scan",
    "estimated/hash-join",
    "estimated/aggregate-sort",
    "estimated/index-only-scan",
    "actual/multi-level-aggregate",
  ]) {
    assert.deepEqual(analysisFor(key).hotspots.items, [], `${key} must not report hotspots`);
  }
});

test("a truncating Limit stops cost attribution below it but not above it", () => {
  const analysis = analysisFor("estimated/nested-loop");
  assert.equal(analysis.metrics.totalEstimatedCost, 165.5);
  assert.deepEqual(analysis.hotspots.items.map((hotspot) => hotspot.nodeId), ["0"]);

  const attribution = analyzePostgresCost(analysis.normalized.root, analysis.metrics.totalEstimatedCost);
  assert.equal(attribution.status, "available");
  assert.equal(attribution.byNodeId.get("0").selfCost, 152.97, "the nested loop is still attributable");
  assert.equal(attribution.byNodeId.has("0.1"), false, "Limit reports a negative own cost");
  assert.equal(attribution.byNodeId.has("0.1.0"), false, "Index Scan lives below the truncating node");

  const [hotspot] = analysis.hotspots.items;
  assert.deepEqual(hotspot.reasons.map((reason) => reason.code), ["cost-concentration"]);
  assert.equal(hotspot.reasons[0].evidence.selfCostShare, 0.9243);
});

test("the InitPlan fixture withholds PostgreSQL cost signals and keeps row signals", async () => {
  const fixture = await loadFixture({ mode: "estimated", name: "subplan-initplan" });
  const analysis = analyzePlan(fixture.input);

  assert.deepEqual(analysis.hotspots.cost, { engine: "postgresql", status: "withheld", reason: "PLAN_CONTAINS_SUBPLAN" });
  assert.deepEqual(analysis.hotspots.items.map((hotspot) => hotspot.nodeId), ["0.0.0", "0.1"]);
  for (const hotspot of analysis.hotspots.items) {
    assert.deepEqual(hotspot.reasons.map((reason) => reason.code), ["large-sequential-scan"]);
    assert.equal(hotspot.reasons[0].level, "high");
    assert.equal("selfCost" in hotspot.evidence, false, "withheld cost produces no self cost value");
    assert.equal("estimatedTotalCost" in hotspot.evidence, true, "the reported Total Cost is still shown");
  }
});

test("the PostgreSQL fixture set exercises both available and withheld cost signals", () => {
  const statuses = new Set(
    fixtures.map((fixture) => analysisFor(`${fixture.mode}/${fixture.name}`).hotspots.cost.status),
  );
  assert.deepEqual([...statuses].sort(), ["available", "withheld"]);
});
