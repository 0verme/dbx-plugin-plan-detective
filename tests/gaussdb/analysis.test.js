import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { PlanParseError } from "../../src/core/errors.js";
import { analyzeRawPlan, describeParserSupport } from "../../src/core/parsers/index.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";
import { loadAllFixtures, loadFixture } from "../helpers/fixtures.js";

const fixtures = await loadAllFixtures("gaussdb");
const distributed = await loadFixture({ database: "gaussdb", mode: "estimated", name: "distributed-operators.synthetic" });

function findNode(root, nodeType) {
  if (root.nodeType === nodeType) return root;
  for (const child of root.children) {
    const match = findNode(child, nodeType);
    if (match) return match;
  }
  return null;
}

function inputFor(plan, mode = "estimated") {
  return createRawPlanInput({ database: "gaussdb", mode, format: "json", plan });
}

test("all GaussDB synthetic fixtures enter the structured JSON pipeline", () => {
  assert.equal(fixtures.length, 3);
  for (const fixture of fixtures) {
    const result = analyzeRawPlan(fixture.input);
    assert.equal(result.status, "structured", fixture.name);
    assert.equal(result.parser, "gaussdb-dws-json", fixture.name);
    assert.equal(result.parsed.database, "gaussdb", fixture.name);
    assert.equal(result.normalized.database, "gaussdb", fixture.name);
    assert.ok(result.metrics !== null, fixture.name);
    assert.ok(result.hotspots !== null, fixture.name);
  }
});

test("DWS distributed operators preserve tree edges, estimate fields and unknown subtrees", () => {
  const result = analyzeRawPlan(distributed.input);
  const root = result.normalized.root;
  const streaming = findNode(root, "Vector Streaming(type: GATHER)");
  const hashJoin = findNode(root, "Vector Sonic Hash Join");
  const aggregate = findNode(root, "Vector Sonic Hash Aggregate");
  const sort = findNode(root, "Sort");
  const window = findNode(root, "WindowAgg");
  const append = findNode(root, "Append");
  const values = findNode(root, "Values Scan");
  const seqScan = findNode(root, "Seq Scan");
  const gather = findNode(root, "Gather");
  const unknown = findNode(root, "Future DWS Operator");

  assert.ok(streaming && hashJoin && aggregate && sort && window && append && values && seqScan && gather && unknown);
  assert.equal(streaming.kind, "exchange");
  assert.equal(streaming.engineSpecific.gaussdb.streamType, "GATHER");
  assert.equal(hashJoin.kind, "hash_join");
  assert.equal(hashJoin.joinType, "Left");
  assert.equal(hashJoin.joinCondition, "(left_key = right_key)");
  assert.equal(aggregate.kind, "aggregate");
  assert.deepEqual(aggregate.groupKeys, ["synthetic_group_key"]);
  assert.equal(sort.kind, "sort");
  assert.deepEqual(sort.sortKeys, ["synthetic_order_key"]);
  assert.equal(window.kind, "analytic");
  assert.equal(append.kind, "append");
  assert.equal(values.kind, "values_scan");
  assert.equal(seqScan.kind, "seq_scan");
  assert.equal(gather.kind, "gather");
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.children[0].nodeType, "Values Scan");
  assert.ok(result.normalized.unknownNodeTypes.includes("Future DWS Operator"));

  assert.equal(root.estimatedRows, 8);
  assert.equal(root.width, 32);
  assert.equal(root.startupCost, null);
  assert.equal(root.totalCost, null);
  assert.equal(root.engineSpecific.gaussdb.startupCost, 0.2);
  assert.equal(root.engineSpecific.gaussdb.totalCost, 28.4);
  assert.equal(result.metrics.totalEstimatedCost, null);
  assert.equal(result.metrics.rootEstimatedRows, 8);
  assert.deepEqual(result.metrics.costAttribution, {
    engine: "gaussdb",
    status: "not-applicable",
    reason: "NOT_POSTGRES_COST_MODEL",
  });
  assert.equal(result.hotspots.cost.status, "not-applicable");
  assert.deepEqual(result.findings, []);
});

test("an untyped Streaming node and unknown child remain visible", () => {
  const fixture = fixtures.find((entry) => entry.name === "streaming-unknown-operator.synthetic");
  const result = analyzeRawPlan(fixture.input);
  assert.equal(result.normalized.root.kind, "exchange");
  assert.equal(result.normalized.root.engineSpecific.gaussdb.streamType, null);
  assert.equal(result.normalized.root.children[0].kind, "unknown");
  assert.equal(result.normalized.root.children[0].children[0].kind, "values_scan");
});

test("unsupported GaussDB format degrades to raw-only instead of guessing a parser", () => {
  assert.deepEqual(describeParserSupport("gaussdb", "text"), {
    structured: false,
    parser: "gaussdb-dws-json",
    reasonCode: "UNSUPPORTED_FORMAT",
  });
  const result = analyzeRawPlan(createRawPlanInput({ database: "gaussdb", mode: "estimated", format: "text", plan: "unrecognized plan format" }));
  assert.equal(result.status, "raw-only");
  assert.equal(result.reasonCode, "UNSUPPORTED_FORMAT");
  assert.equal(result.parsed, null);
});

test("malformed, empty, error, object-only and multi-entry envelopes fail with stable parse errors", () => {
  const badPlans = [
    [],
    [{ Error: "synthetic error" }],
    { Plan: { "Node Type": "Result" } },
    [{ Plan: { "Node Type": "Result" } }, { Plan: { "Node Type": "Result" } }],
    [{ Plan: { "Node Type": "Result", Plans: {} } }],
    [{ Plan: { "Node Type": "Result", "Total Cost": "not-a-number" } }],
    [{ Plan: { Plans: [] } }],
  ];
  for (const plan of badPlans) {
    assert.throws(() => analyzeRawPlan(inputFor(plan)), (error) => error instanceof PlanParseError);
  }
  assert.throws(() => analyzeRawPlan(inputFor("not JSON object")), (error) => error instanceof PlanParseError);
});

test("DWS parser rejects actual-plan fields and actual mode", () => {
  const actualFields = [{ Plan: { "Node Type": "Result", "Actual Total Time": 0.1 } }];
  assert.throws(
    () => analyzeRawPlan(inputFor(actualFields)),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
  assert.throws(
    () => analyzeRawPlan(inputFor([{ Plan: { "Node Type": "Result" } }], "actual")),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
});

test("large DWS plans are bounded before recursive parsing", () => {
  const tooManyChildren = Array.from({ length: 20_000 }, () => ({ "Node Type": "Values Scan" }));
  assert.throws(
    () => analyzeRawPlan(inputFor([{ Plan: { "Node Type": "Append", Plans: tooManyChildren } }])),
    (error) => error instanceof PlanParseError && error.code === "PLAN_TOO_LARGE",
  );

  let deep = { "Node Type": "Values Scan" };
  for (let depth = 0; depth < 512; depth += 1) deep = { "Node Type": "Append", Plans: [deep] };
  assert.throws(
    () => analyzeRawPlan(inputFor([{ Plan: deep }])),
    (error) => error instanceof PlanParseError && error.code === "PLAN_TOO_DEEP",
  );
});

test("DWS row-only sequential-scan findings do not claim native cost is absent", () => {
  const result = analyzeRawPlan(inputFor([{ Plan: {
    "Node Type": "Seq Scan",
    "Relation Name": "synthetic_rows",
    "Startup Cost": 1,
    "Total Cost": 9_000_000,
    "Plan Rows": 10_000,
    "Plan Width": 8,
  } }]));
  const finding = result.findings.find((entry) => entry.ruleId === "large-sequential-scan");
  assert.ok(finding);
  assert.match(finding.summary, /DWS native cost is kept separately/);
  assert.equal(finding.evidence.incrementalCost, null);
  assert.equal(finding.evidence.estimatedTotalCost, null);
  assert.equal(finding.facts.estimatedTotalCost, null);
});

test("GaussDB native cost values cannot trigger PostgreSQL cost findings", () => {
  const plan = structuredClone(distributed.plan);
  const root = plan[0].Plan;
  root["Total Cost"] = 9_000_000_000;
  const sort = findRawNode(root, "Sort");
  sort["Startup Cost"] = 8_000_000_000;
  sort["Total Cost"] = 9_000_000_000;
  const seqScan = findRawNode(root, "Seq Scan");
  seqScan["Startup Cost"] = 8_000_000_000;
  seqScan["Total Cost"] = 9_000_000_000;
  seqScan["Plan Rows"] = 1;

  const result = analyzePlan(inputFor(plan));
  assert.equal(result.metrics.totalEstimatedCost, null);
  assert.equal(result.metrics.highestIncrementalCost, null);
  assert.equal(result.findings.some((finding) => finding.ruleId === "expensive-sort"), false);
  assert.equal(result.findings.some((finding) => finding.ruleId === "large-sequential-scan"), false);
  assert.equal(result.hotspots.items.some((hotspot) => hotspot.reasons.some((reason) => reason.code === "cost-concentration")), false);
});

function findRawNode(node, nodeType) {
  if (node["Node Type"] === nodeType) return node;
  for (const child of node.Plans ?? []) {
    const match = findRawNode(child, nodeType);
    if (match) return match;
  }
  return null;
}
