import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { PlanInputError, PlanParseError } from "../../src/core/errors.js";

/** A small but complete EXPLAIN (FORMAT JSON) output. */
function rawPlan(plan, overrides = {}) {
  return { database: "postgresql", mode: "estimated", format: "json", plan, ...overrides };
}

test("analyzePlan runs the whole offline pipeline without any database", () => {
  const analysis = analyzePlan(
    rawPlan([
      {
        Plan: {
          "Node Type": "Sort",
          "Startup Cost": 10,
          "Total Cost": 100,
          "Plan Rows": 50,
          "Sort Key": ["total"],
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "pd_fix_orders",
              "Alias": "o",
              "Startup Cost": 0,
              "Total Cost": 90,
              "Plan Rows": 50,
              "Plan Width": 27,
              Filter: "(total > 2500)",
            },
          ],
        },
      },
    ]),
  );

  assert.equal(analysis.parsed.root.nodeType, "Sort");
  assert.equal(analysis.normalized.root.kind, "sort");
  assert.equal(analysis.normalized.root.children[0].kind, "seq_scan");
  assert.deepEqual(analysis.normalized.root.sortKeys, ["total"]);
  assert.equal(analysis.metrics.nodeCount, 2);
  assert.equal(analysis.metrics.maxDepth, 2);
  assert.equal(analysis.metrics.scanCount, 1);
  assert.equal(analysis.metrics.sequentialScanCount, 1);
  assert.equal(analysis.metrics.sortCount, 1);
  assert.equal(analysis.metrics.totalEstimatedCost, 100);
  assert.deepEqual(analysis.findings, []);
});

test("analyzePlan does not mutate its input", () => {
  const input = rawPlan([
    {
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "t",
        "Plan Rows": 20_000,
        "Total Cost": 500,
        "Future Property": { nested: true },
      },
    },
  ]);
  const snapshot = structuredClone(input);

  analyzePlan(input);

  assert.deepEqual(input, snapshot, "the raw input must stay untouched");
});

test("analyzePlan keeps unknown node types and unknown properties in the output", () => {
  const analysis = analyzePlan(
    rawPlan([
      {
        Plan: {
          "Node Type": "Future Shuffle Node",
          "Plan Rows": 10,
          "Total Cost": 5,
          "Future Metric": 42,
          Plans: [{ "Node Type": "Seq Scan", "Relation Name": "t", "Plan Rows": 10, "Total Cost": 4 }],
        },
      },
    ]),
  );

  assert.equal(analysis.normalized.root.kind, "unknown");
  assert.deepEqual(analysis.normalized.unknownNodeTypes, ["Future Shuffle Node"]);
  assert.deepEqual(analysis.normalized.root.engineSpecific.extra, { "Future Metric": 42 });
  assert.equal(analysis.normalized.root.children[0].kind, "seq_scan");
});

test("analyzePlan surfaces rule findings with evidence", () => {
  const analysis = analyzePlan(
    rawPlan([
      {
        Plan: {
          "Node Type": "Seq Scan",
          "Relation Name": "pd_fix_events",
          "Plan Rows": 200_000,
          "Total Cost": 3_497,
        },
      },
    ]),
  );

  assert.equal(analysis.findings.length, 1);
  const [finding] = analysis.findings;
  assert.equal(finding.ruleId, "large-sequential-scan");
  assert.equal(finding.severity, "high");
  assert.equal(finding.nodeRef, "0");
  assert.equal(finding.evidence.estimatedRows, 200_000);
  assert.equal(finding.evidence.estimatedTotalCost, 3_497);
});

test("analyzePlan propagates contract and parse errors unchanged", () => {
  assert.throws(
    () => analyzePlan(rawPlan([{ Plan: { "Node Type": "Seq Scan", "Actual Rows": 1 } }])),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
  assert.throws(
    () => analyzePlan({ database: "mysql", mode: "estimated", format: "json", plan: [] }),
    (error) => error instanceof PlanInputError && error.code === "INVALID_RAW_PLAN_INPUT",
  );
});
