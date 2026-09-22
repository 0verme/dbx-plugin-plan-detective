import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { walkNodes } from "../../src/core/tree.js";
import { loadAllFixtures } from "../helpers/fixtures.js";

/**
 * SQL Server hotspot behavior.
 *
 * SQL Server reports `EstimatedTotalSubtreeCost` (a cumulative subtree cost) in
 * its own cost model. A hotspot must never reuse PostgreSQL cost semantics:
 * these tests pin the rows-based signals, the engine-specific reason codes and
 * the `not-applicable` cost context independently of the golden files.
 */

const fixtures = await loadAllFixtures("sqlserver");
const analysisByFixture = new Map(fixtures.map((fixture) => [fixture.name, analyzePlan(fixture.input)]));

const SQLSERVER_REASON_CODES = new Set([
  "large-sequential-scan",
  "nested-loop-amplification",
  "sqlserver-large-index-scan",
  "sqlserver-sort",
]);
const PG_ONLY_REASON_CODES = new Set(["cost-concentration"]);
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

test("SQL Server hotspots never use PostgreSQL cost semantics", () => {
  for (const fixture of fixtures) {
    const analysis = analysisFor(fixture.name);
    assert.deepEqual(
      analysis.hotspots.cost,
      { engine: "sqlserver", status: "not-applicable", reason: "NOT_POSTGRES_COST_MODEL" },
      `${fixture.name} cost context`,
    );

    for (const hotspot of analysis.hotspots.items) {
      for (const reason of hotspot.reasons) {
        assert.equal(SQLSERVER_REASON_CODES.has(reason.code), true, `${fixture.name}: unexpected reason ${reason.code}`);
        assert.equal(PG_ONLY_REASON_CODES.has(reason.code), false, `${fixture.name}: PostgreSQL-only reason on SQL Server`);
      }
      for (const key of PG_ONLY_EVIDENCE_KEYS) {
        assert.equal(key in hotspot.evidence, false, `${fixture.name}: PostgreSQL-only evidence key ${key}`);
      }
    }
  }
});

test("table-scan reports a rows-based hotspot with the SQL Server row source", () => {
  const analysis = analysisFor("table-scan.synthetic");

  assert.deepEqual(analysis.hotspots.items.map((hotspot) => hotspot.nodeId), ["0"]);
  const [hotspot] = analysis.hotspots.items;
  assert.equal(hotspot.level, "high");
  assert.equal(hotspot.kind, "seq_scan");
  assert.deepEqual(hotspot.reasons.map((reason) => reason.code), ["large-sequential-scan"]);
  assert.equal(hotspot.reasons[0].source, "RelOp@EstimateRows");
  assert.equal(hotspot.reasons[0].evidence.estimatedRows, 250_000);
  assert.match(hotspot.reasons[0].statement, /full table scan/);
  assert.equal(hotspot.evidence.physicalOp, "Table Scan");
  assert.equal(hotspot.evidence.table, "[Customers]");
  assert.equal(hotspot.evidence.estimatedTotalSubtreeCost, 12.5);
});

test("a large index scan is signalled, a seek is not", () => {
  const indexScan = analysisFor("index-scan.synthetic");
  assert.deepEqual(indexScan.hotspots.items.map((hotspot) => hotspot.nodeId), ["0"]);
  const [reason] = indexScan.hotspots.items[0].reasons;
  assert.equal(reason.code, "sqlserver-large-index-scan");
  assert.equal(reason.level, "high");
  assert.equal(reason.source, "RelOp@EstimateRows");
  assert.equal(reason.evidence.physicalOp, "Index Scan");
  assert.equal(reason.evidence.estimatedRows, 150_000);

  assert.deepEqual(analysisFor("index-seek.synthetic").hotspots.items, [], "a seek must not be reported as a scan signal");
  assert.deepEqual(analysisFor("key-lookup.synthetic").hotspots.items, [], "a key lookup must not be reported as a scan signal");
});

test("sort reports its own signal plus the underlying index scan", () => {
  const analysis = analysisFor("sort.synthetic");
  assert.deepEqual(analysis.hotspots.items.map((hotspot) => hotspot.nodeId), ["0", "0.0.0"]);

  const [sort, indexScan] = analysis.hotspots.items;
  assert.deepEqual(sort.reasons.map((reason) => reason.code), ["sqlserver-sort"]);
  assert.equal(sort.level, "high");
  assert.deepEqual(sort.reasons[0].evidence.sortKeys, ["[o].OrderDate ASC", "[o].TotalDue DESC"]);
  assert.equal(sort.reasons[0].evidence.estimatedRows, 120_000);
  assert.match(sort.reasons[0].statement, /estimated to sort 120000 rows/);

  assert.deepEqual(indexScan.reasons.map((reason) => reason.code), ["sqlserver-large-index-scan"]);
  assert.equal(indexScan.kind, "index_scan");
});

test("nested-loop amplification uses the two input estimates", () => {
  const analysis = analysisFor("nested-loops-large-inner.synthetic");

  assert.deepEqual(analysis.hotspots.items.map((hotspot) => hotspot.nodeId), ["0"]);
  const [reason] = analysis.hotspots.items[0].reasons;
  assert.equal(reason.code, "nested-loop-amplification");
  assert.equal(reason.level, "warning");
  assert.equal(reason.source, "RelOp@EstimateRows");
  assert.equal(reason.evidence.outerEstimatedRows, 1_000);
  assert.equal(reason.evidence.innerEstimatedRows, 50_000);
  assert.equal(reason.evidence.estimatedRowComparisons, 50_000_000);

  assert.deepEqual(analysisFor("nested-loops.synthetic").hotspots.items, [], "a small nested loop stays silent");
});

test("concatenation branches report their scans in plan order", () => {
  const analysis = analysisFor("top-concatenation.synthetic");
  assert.deepEqual(analysis.hotspots.items.map((hotspot) => hotspot.nodeId), ["0.0.0", "0.0.1"]);
  for (const hotspot of analysis.hotspots.items) {
    assert.deepEqual(hotspot.reasons.map((reason) => reason.code), ["sqlserver-large-index-scan"]);
  }
});

test("fixtures without a large row estimate stay silent", () => {
  for (const name of [
    "compute-scalar-filter.synthetic",
    "hash-match.synthetic",
    "merge-join.synthetic",
    "minimal-fields.synthetic",
    "stream-aggregate.synthetic",
    "unknown-operator.synthetic",
  ]) {
    assert.deepEqual(analysisFor(name).hotspots.items, [], `${name} must not report hotspots`);
  }
});

test("every SQL Server hotspot points at a real node and is estimate-only", () => {
  for (const fixture of fixtures) {
    const analysis = analysisFor(fixture.name);
    const nodeIds = new Set([...walkNodes(analysis.normalized.root)].map((node) => node.id));
    for (const hotspot of analysis.hotspots.items) {
      assert.equal(nodeIds.has(hotspot.nodeId), true, `${fixture.name}: ${hotspot.nodeId} must exist in the tree`);
      assert.equal(hotspot.estimateOnly, true);
      assert.ok(hotspot.reasons.length > 0);
    }
  }
});
