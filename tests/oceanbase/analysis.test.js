import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { PlanParseError } from "../../src/core/errors.js";
import { analyzeRawPlan, describeParserSupport } from "../../src/core/parsers/index.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";
import { flattenNodes } from "../../src/core/tree.js";
import { loadAllFixtures, loadFixture } from "../helpers/fixtures.js";

/**
 * End-to-end Core contract for OceanBase Oracle:
 *
 *     RawPlanInput(oceanbase-oracle, json) -> analyzeRawPlan -> structured
 *       -> normalized -> metrics -> findings -> hotspots
 *
 * These tests pin the metrics the shared engine derives from the JSON plan and
 * the exact applicability of the existing rules. OceanBase `EST.TIME(us)` /
 * `COST` are not a PostgreSQL cost model, so no cost-based metric or rule may
 * fire.
 */

const fixtures = await loadAllFixtures("oceanbase-oracle");
const analysisByFixture = new Map(fixtures.map((fixture) => [fixture.name, analyzePlan(fixture.input)]));

/** @param {string} name */
function analysisFor(name) {
  const analysis = analysisByFixture.get(name);
  assert.ok(analysis, `missing fixture ${name}`);
  return analysis;
}

test("analyzeRawPlan reports OceanBase Oracle as structured and fills every stage", async () => {
  const loaded = await loadFixture({ database: "oceanbase-oracle", mode: "estimated", name: "hash-join" });
  const result = analyzeRawPlan(loaded.input);

  assert.equal(result.status, "structured");
  assert.equal(result.parser, "oceanbase-oracle");
  assert.equal(result.reasonCode, null);
  assert.equal(result.reason, null);
  assert.equal(result.parsed.database, "oceanbase-oracle");
  assert.equal(result.parsed.format, "json");
  assert.equal(result.normalized.database, "oceanbase-oracle");
  assert.ok(result.metrics.nodeCount >= 1);
  assert.ok(result.hotspots !== null);

  const strict = analyzePlan(loaded.input);
  assert.deepEqual(result.parsed, strict.parsed);
  assert.deepEqual(result.normalized, strict.normalized);
  assert.deepEqual(result.metrics, strict.metrics);
  assert.deepEqual(result.findings, strict.findings);
  assert.deepEqual(result.hotspots, strict.hotspots);
});

test("the registry claims OceanBase Oracle only for JSON", () => {
  assert.deepEqual(describeParserSupport("oceanbase-oracle", "json"), {
    structured: true,
    parser: "oceanbase-oracle",
    reasonCode: null,
  });
  assert.deepEqual(describeParserSupport("oceanbase-oracle", "text"), {
    structured: false,
    parser: "oceanbase-oracle",
    reasonCode: "UNSUPPORTED_FORMAT",
  });
  assert.deepEqual(describeParserSupport("oceanbase-oracle", "xml"), {
    structured: false,
    parser: "oceanbase-oracle",
    reasonCode: "UNSUPPORTED_FORMAT",
  });
});

test("a text payload for OceanBase Oracle stays raw-only instead of being guessed at", () => {
  const textInput = createRawPlanInput({
    database: "oceanbase-oracle",
    mode: "estimated",
    format: "text",
    plan: "| 0 | HASH JOIN |",
  });

  const result = analyzeRawPlan(textInput);
  assert.equal(result.status, "raw-only");
  assert.equal(result.reasonCode, "UNSUPPORTED_FORMAT");
  assert.equal(result.parsed, null);
  assert.equal(result.normalized, null);
  assert.equal(result.metrics, null);
  assert.equal(result.hotspots, null);
  assert.deepEqual(result.findings, []);
  assert.match(result.reason, /format "text"/);

  assert.throws(
    () => analyzePlan(textInput),
    (error) => error instanceof PlanParseError && error.code === "UNSUPPORTED_FORMAT",
    "the strict entry point refuses a raw-only family",
  );
});

test("metrics read estimated rows and never fabricate a cost", () => {
  const scan = analysisFor("table-full-scan.synthetic").metrics;
  assert.deepEqual(
    {
      nodeCount: scan.nodeCount,
      maxDepth: scan.maxDepth,
      scanCount: scan.scanCount,
      sequentialScanCount: scan.sequentialScanCount,
      indexScanCount: scan.indexScanCount,
      joinCount: scan.joinCount,
      sortCount: scan.sortCount,
      aggregateCount: scan.aggregateCount,
      rootEstimatedRows: scan.rootEstimatedRows,
      largestEstimatedRows: scan.largestEstimatedRows?.estimatedRows,
    },
    {
      nodeCount: 1,
      maxDepth: 1,
      scanCount: 1,
      sequentialScanCount: 1,
      indexScanCount: 0,
      joinCount: 0,
      sortCount: 0,
      aggregateCount: 0,
      rootEstimatedRows: 250_000,
      largestEstimatedRows: 250_000,
    },
  );
  assert.equal(scan.totalEstimatedCost, null, "OceanBase reports no PostgreSQL total cost");
  assert.equal(scan.highestIncrementalCost, null);
  assert.deepEqual(scan.costAttribution, {
    engine: "oceanbase-oracle",
    status: "not-applicable",
    reason: "NOT_POSTGRES_COST_MODEL",
  });
});

test("metrics classify the fixture set without PostgreSQL vocabulary", () => {
  const multiLevel = analysisFor("multi-level-tree.synthetic").metrics;
  assert.equal(multiLevel.nodeCount, 6);
  assert.equal(multiLevel.maxDepth, 5);
  assert.equal(multiLevel.scanCount, 2);
  assert.equal(multiLevel.sequentialScanCount, 1);
  assert.equal(multiLevel.indexScanCount, 1);
  assert.equal(multiLevel.joinCount, 1);
  assert.equal(multiLevel.sortCount, 1);
  assert.equal(multiLevel.aggregateCount, 0);
  assert.equal(multiLevel.unknownNodeTypeCount, 0);

  const aggregate = analysisFor("aggregate.synthetic").metrics;
  assert.equal(aggregate.aggregateCount, 1);

  const childOrder = analysisFor("child-order.synthetic").metrics;
  assert.equal(childOrder.scanCount, 3, "every CHILD_<n> becomes a scan node");

  const unknownOperator = analysisFor("unknown-operator.synthetic").metrics;
  assert.equal(unknownOperator.unknownNodeTypeCount, 1, "an unclassified operator is reported, not hidden");

  const missing = analysisFor("missing-optional-fields.synthetic").metrics;
  assert.equal(missing.nodeCount, 3, "a null CHILD_<n> is not a node");
  assert.equal(missing.rootEstimatedRows, null);
  assert.equal(missing.largestEstimatedRows?.estimatedRows, 5);
});

test("row-based rules apply and cost-based rules stay silent", () => {
  const scan = analysisFor("table-full-scan.synthetic");
  assert.deepEqual(
    scan.findings.map((finding) => [finding.ruleId, finding.severity, finding.nodeRef]),
    [["large-sequential-scan", "high", "0"]],
  );
  assert.equal(scan.findings[0].facts.database, "oceanbase-oracle");
  assert.equal(scan.findings[0].facts.runtimeVerified, false, "an estimated plan is never runtime-verified");

  const nestedLoop = analysisFor("nested-loop-large-inner.synthetic");
  assert.deepEqual(
    nestedLoop.findings.map((finding) => [finding.ruleId, finding.nodeRef]).sort(),
    [
      ["large-sequential-scan", "0.1"],
      ["nested-loop-large-inner", "0"],
    ],
  );
  const amplification = nestedLoop.findings.find((finding) => finding.ruleId === "nested-loop-large-inner");
  assert.equal(amplification.evidence.estimateOnly, true, "the rule marks its row comparison as an estimate");
  assert.equal(amplification.evidence.actualLoops, null, "an estimated plan has no runtime loop count");
  assert.equal(amplification.evidence.estimatedRowComparisons, 50_000_000);
  assert.match(amplification.summary, /planner estimates/i);
  assert.doesNotMatch(amplification.summary, /must|should rewrite/i);

  for (const fixture of fixtures) {
    const analysis = analysisFor(fixture.name);
    for (const finding of analysis.findings) {
      assert.notEqual(finding.ruleId, "expensive-sort", `${fixture.name} must not fire a PostgreSQL cost rule`);
    }
  }
});

test("hotspots use the neutral row signals with OceanBase-native sources", () => {
  const scan = analysisFor("table-full-scan.synthetic").hotspots;
  assert.deepEqual(scan.cost, {
    engine: "oceanbase-oracle",
    status: "not-applicable",
    reason: "NOT_POSTGRES_COST_MODEL",
  });
  assert.deepEqual(
    scan.items.map((item) => [item.nodeId, item.level, item.reasons.map((reason) => reason.code)]),
    [["0", "high", ["large-sequential-scan"]]],
  );
  assert.equal(scan.items[0].reasons[0].source, "EST.ROWS", "the signal names the field the reader can find");
  assert.equal(scan.items[0].estimateOnly, true);

  const nestedLoop = analysisFor("nested-loop-large-inner.synthetic").hotspots;
  assert.deepEqual(
    nestedLoop.items.map((item) => item.nodeId),
    ["0", "0.1"],
    "attention order is level, reason count, then plan pre-order",
  );
  assert.deepEqual(nestedLoop.items[0].reasons.map((reason) => reason.code), ["nested-loop-amplification"]);
  assert.equal(nestedLoop.items[0].reasons[0].source, "EST.ROWS");

  const allowedReasons = new Set(["large-sequential-scan", "nested-loop-amplification"]);
  for (const fixture of fixtures) {
    const analysis = analysisFor(fixture.name);
    for (const item of analysis.hotspots.items) {
      assert.equal(item.estimateOnly, true, `${fixture.name} hotspot ${item.nodeId} is estimate-only`);
      for (const reason of item.reasons) {
        assert.ok(allowedReasons.has(reason.code), `${fixture.name} must not invent a cost signal (${reason.code})`);
      }
    }
  }
});

test("no OceanBase Oracle node claims runtime values or a PostgreSQL cost", () => {
  for (const fixture of fixtures) {
    const analysis = analysisFor(fixture.name);
    for (const node of flattenNodes(analysis.normalized.root)) {
      assert.equal(node.startupCost, null, `${fixture.name} ${node.id} startupCost`);
      assert.equal(node.totalCost, null, `${fixture.name} ${node.id} totalCost`);
      assert.equal(node.actualRows, null, `${fixture.name} ${node.id} actualRows`);
      assert.equal(node.actualStartupTime, null, `${fixture.name} ${node.id} actualStartupTime`);
      assert.equal(node.actualTotalTime, null, `${fixture.name} ${node.id} actualTotalTime`);
      assert.equal(node.loops, null, `${fixture.name} ${node.id} loops`);
      assert.equal(node.engineSpecific.database, "oceanbase-oracle");
      assert.equal(typeof node.engineSpecific.oceanBase, "object");
    }
  }
});
