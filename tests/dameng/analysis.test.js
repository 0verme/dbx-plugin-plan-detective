import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { analyzeRawPlan } from "../../src/core/parsers/index.js";
import { flattenNodes } from "../../src/core/tree.js";
import { loadFixture } from "../helpers/fixtures.js";

const nestedLoop = await loadFixture({ database: "dameng", mode: "estimated", name: "nested-loop-large-inner.synthetic" });
const scan = await loadFixture({ database: "dameng", mode: "estimated", name: "large-sequential-scan.synthetic" });
const unknown = await loadFixture({ database: "dameng", mode: "estimated", name: "unknown-subtree.synthetic" });

test("Dameng runs RawPlanInput through the structured pipeline", () => {
  const result = analyzeRawPlan(nestedLoop.input);
  const strict = analyzePlan(nestedLoop.input);

  assert.equal(result.status, "structured");
  assert.equal(result.parser, "dameng");
  assert.equal(result.reasonCode, null);
  assert.equal(result.normalized.database, "dameng");
  assert.equal(result.metrics.joinCount, 1);
  assert.deepEqual(result.parsed, strict.parsed);
  assert.deepEqual(result.normalized, strict.normalized);
  assert.deepEqual(result.metrics, strict.metrics);
  assert.deepEqual(result.findings, strict.findings);
  assert.deepEqual(result.hotspots, strict.hotspots);
});

test("Dameng row signals work without treating native cost as PostgreSQL cost", () => {
  const analysis = analyzePlan(scan.input);
  assert.deepEqual(
    analysis.findings.map((finding) => [finding.ruleId, finding.severity, finding.nodeRef]),
    [["large-sequential-scan", "high", "0.0"]],
  );
  assert.equal(analysis.findings[0].evidence.incrementalCost, null);
  assert.equal(analysis.metrics.totalEstimatedCost, null);
  assert.deepEqual(analysis.hotspots.cost, {
    engine: "dameng",
    status: "not-applicable",
    reason: "NOT_POSTGRES_COST_MODEL",
  });
  assert.equal(analysis.hotspots.items[0].reasons[0].source, "[cost, rows, bytes-per-row]");
});

test("Dameng unknown operators keep their child tree and are counted explicitly", () => {
  const analysis = analyzePlan(unknown.input);
  assert.equal(analysis.normalized.root.children[0].kind, "unknown");
  assert.equal(analysis.normalized.root.children[0].children[0].kind, "seq_scan");
  assert.deepEqual(analysis.normalized.unknownNodeTypes, ["PX FUTURE SHUFFLE"]);
  assert.equal(analysis.metrics.unknownNodeTypeCount, 1);
  assert.equal(flattenNodes(analysis.normalized.root).every((node) => node.actualRows === null), true);
});
