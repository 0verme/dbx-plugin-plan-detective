import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { describeParserSupport } from "../../src/core/parsers/index.js";
import { flattenNodes } from "../../src/core/tree.js";
import { loadFixture } from "../helpers/fixtures.js";

const asof = await loadFixture({ database: "questdb", mode: "estimated", name: "asof-two-scans.synthetic" });
const asyncFilter = await loadFixture({ database: "questdb", mode: "estimated", name: "async-jit-filter" });

test("QuestDB text is structured while other formats remain unsupported", () => {
  assert.deepEqual(describeParserSupport("questdb", "text"), { structured: true, parser: "questdb", reasonCode: null });
  assert.deepEqual(describeParserSupport("questdb", "json"), { structured: false, parser: "questdb", reasonCode: "UNSUPPORTED_FORMAT" });
});

test("two PageFrame pipelines count one relation access each, not three scans each", () => {
  const analysis = analyzePlan(asof.input);
  const nodes = flattenNodes(analysis.normalized.root);

  assert.equal(analysis.metrics.nodeCount, 9);
  assert.equal(analysis.metrics.joinCount, 1);
  assert.equal(analysis.metrics.scanCount, 2);
  assert.equal(analysis.metrics.sequentialScanCount, 0);
  assert.deepEqual(
    nodes.filter((node) => node.kind === "scan").map((node) => node.relation.name),
    ["core_price", "market_data"],
  );
  assert.equal(analysis.metrics.costAttribution.status, "not-applicable");
  assert.equal(analysis.metrics.totalEstimatedCost, null);
  assert.equal(analysis.metrics.rootEstimatedRows, null);
  assert.deepEqual(analysis.findings, []);
  assert.deepEqual(analysis.hotspots.items, []);
});

test("QuestDB worker, JIT and filter facts are evidence only", () => {
  const analysis = analyzePlan(asyncFilter.input);
  assert.equal(analysis.normalized.root.engineSpecific.questdb.workers, 47);
  assert.equal(analysis.normalized.root.engineSpecific.questdb.filter, "100.0<amount [pre-touch]");
  assert.equal(analysis.normalized.root.filter, "100.0<amount [pre-touch]");
  assert.deepEqual(analysis.findings, []);
  assert.deepEqual(analysis.hotspots.items, []);
});
