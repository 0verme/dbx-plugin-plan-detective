import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { analyzeRawPlan } from "../../src/core/parsers/index.js";
import { flattenNodes } from "../../src/core/tree.js";
import { loadAllFixtures, loadFixture } from "../helpers/fixtures.js";

/**
 * End-to-end Core contract for MySQL:
 *
 *     RawPlanInput(mysql) -> analyzeRawPlan -> structured
 *       -> normalized -> metrics -> findings
 *
 * These tests pin the metrics the shared engine derives from a MySQL plan and
 * the exact applicability of the existing rules.
 */

const fixtures = await loadAllFixtures("mysql");

/** @param {string} name */
async function fixture(name) {
  return loadFixture({ database: "mysql", mode: "estimated", name });
}

test("analyzeRawPlan reports MySQL structured and fills every pipeline stage", async () => {
  const loaded = await fixture("nested-loop-large-inner.synthetic");
  const result = analyzeRawPlan(loaded.input);

  assert.equal(result.status, "structured");
  assert.equal(result.parser, "mysql");
  assert.equal(result.reasonCode, null);
  assert.equal(result.reason, null);
  assert.equal(result.parsed.database, "mysql");
  assert.equal(result.normalized.database, "mysql");
  assert.equal(result.metrics.nodeCount, 4);
  assert.equal(result.findings.length, 2);

  // The strict entry point is a view over the same result.
  const strict = analyzePlan(loaded.input);
  assert.deepStrictEqual(
    { parsed: strict.parsed, normalized: strict.normalized, metrics: strict.metrics, findings: strict.findings },
    { parsed: result.parsed, normalized: result.normalized, metrics: result.metrics, findings: result.findings },
  );
});

test("V2 RawPlanInput reaches normalize, metrics, rules and findings as structured", () => {
  const rawInput = {
    database: "mysql",
    mode: "estimated",
    format: "json",
    plan: {
      query_plan: {
        operation: "Inner hash join",
        access_type: "join",
        join_algorithm: "hash",
        estimated_rows: 10,
        inputs: [
          { operation: "Table scan on sample_table", table_name: "sample_table", access_type: "table", estimated_rows: 101885 },
          {
            operation: "Filter: (id > 0)",
            access_type: "filter",
            condition: "(id > 0)",
            estimated_rows: 20,
            inputs: [{ operation: "Table scan on sample_inner", table_name: "sample_inner", access_type: "table", estimated_rows: 200 }],
          },
        ],
      },
      json_schema_version: "2.0",
    },
  };

  const result = analyzeRawPlan(rawInput);
  assert.equal(result.status, "structured");
  assert.equal(result.parser, "mysql");
  assert.equal(result.normalized.root.kind, "hash_join");
  assert.equal(result.normalized.root.children[0].relation.name, "sample_table");
  assert.equal(result.metrics.joinCount, 1);
  assert.equal(result.metrics.sequentialScanCount, 2);
  assert.equal(result.findings.some((finding) => finding.ruleId === "large-sequential-scan"), true);
  assert.equal(result.hotspots.items.length > 0, true);
});

test("metrics count MySQL scans, joins, sorts and aggregates through the shared engine", async () => {
  const cases = [
    ["nested-loop-large-inner.synthetic", { scanCount: 2, sequentialScanCount: 2, indexScanCount: 0, joinCount: 1, sortCount: 0, aggregateCount: 0 }],
    ["nested-loop-join.synthetic", { scanCount: 3, sequentialScanCount: 1, indexScanCount: 2, joinCount: 2, sortCount: 0, aggregateCount: 0 }],
    ["ordering-filesort.synthetic", { scanCount: 1, sequentialScanCount: 1, joinCount: 0, sortCount: 1, aggregateCount: 0 }],
    ["grouping-temporary.synthetic", { scanCount: 1, indexScanCount: 1, joinCount: 0, sortCount: 0, aggregateCount: 1 }],
    ["union-result.synthetic", { scanCount: 3, indexScanCount: 1, joinCount: 1, sortCount: 0, aggregateCount: 0 }],
    ["const-lookup.synthetic", { scanCount: 0, sequentialScanCount: 0, indexScanCount: 0, joinCount: 0 }],
  ];

  for (const [name, expected] of cases) {
    const loaded = await fixture(name);
    const { metrics } = analyzePlan(loaded.input);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(metrics[key], value, `${name}: metrics.${key}`);
    }
  }
});

test("metrics never invent a cost for MySQL", async () => {
  for (const loaded of fixtures) {
    const { metrics } = analyzePlan(loaded.input);
    assert.equal(metrics.totalEstimatedCost, null, `${loaded.name}: MySQL cost is not a PostgreSQL total cost`);
    assert.equal(metrics.highestIncrementalCost, null, `${loaded.name}: incremental cost needs PostgreSQL cost data`);
  }
});

test("issue #38: a human-readable data_read_per_join survives the pipeline", async () => {
  const loaded = await fixture("data-read-per-join-unit.synthetic");
  const { parsed, normalized, findings } = analyzePlan(loaded.input);

  const [tableNode] = parsed.root.children;
  assert.equal(tableNode.mysql.dataReadPerJoin, 171008, '"167K" must decode with MySQL\'s 1024 base');
  assert.equal(
    normalized.root.children[0].engineSpecific.mysql.dataReadPerJoin,
    171008,
    "the decoded byte count must reach the normalized engineSpecific block",
  );
  assert.deepEqual(findings, [], "the regression fixture is about parsing, not about firing rules");
});

test("large-sequential-scan fires on the row branch with a null cost, without fabricating zero", async () => {
  const loaded = await fixture("nested-loop-large-inner.synthetic");
  const { findings } = analyzePlan(loaded.input);
  const scan = findings.find((finding) => finding.ruleId === "large-sequential-scan");

  assert.ok(scan, "the 50000-row table scan must be reported");
  assert.equal(scan.severity, "warning");
  assert.equal(scan.evidence.nodeType, "Table Scan");
  assert.equal(scan.evidence.estimatedRows, 50000);
  assert.equal(scan.evidence.incrementalCost, null, "a missing cost must stay null, not become 0");
  assert.equal(scan.evidence.estimatedTotalCost, null);
  assert.match(scan.summary, /Table Scan/);
  assert.match(scan.summary, /does not report a cost estimate/);
});

test("nested-loop-large-inner works on a folded MySQL nested loop", async () => {
  const loaded = await fixture("nested-loop-large-inner.synthetic");
  const { normalized, findings } = analyzePlan(loaded.input);
  const finding = findings.find((candidate) => candidate.ruleId === "nested-loop-large-inner");

  assert.ok(finding, "the join rule must see the folded left-deep nested loop");
  assert.equal(finding.nodeRef, "0.0");
  assert.equal(normalized.root.children[0].kind, "nested_loop");
  assert.equal(finding.evidence.outerEstimatedRows, 1000);
  assert.equal(finding.evidence.innerEstimatedRows, 50000);
  assert.equal(finding.evidence.estimatedRowComparisons, 50_000_000);
  assert.equal(finding.evidence.estimateOnly, true);
});

test("expensive-sort stays silent for MySQL: the rule depends on PostgreSQL cost data", async () => {
  for (const loaded of fixtures) {
    for (const finding of analyzePlan(loaded.input).findings) {
      assert.notEqual(finding.ruleId, "expensive-sort", `${loaded.name} must not trigger a cost-based sort rule`);
    }
  }
});

test("the MySQL tree exposes the expected structures with stable ids", async () => {
  const loaded = await fixture("complex-mixed.synthetic");
  const { normalized, metrics } = analyzePlan(loaded.input);
  const nodes = flattenNodes(normalized.root);

  assert.deepEqual(
    nodes.map((node) => node.kind),
    [
      "query_block",
      "sort",
      "aggregate",
      "nested_loop",
      "nested_loop",
      "seq_scan",
      "subquery",
      "query_block",
      "seq_scan",
      "index_scan",
      "seq_scan",
      "materialize",
      "query_block",
      "seq_scan",
    ],
  );
  assert.equal(metrics.maxDepth, 9);
  assert.deepEqual(normalized.unknownNodeTypes, []);
});

test("every MySQL fixture is structured and deterministic through the registry", async () => {
  for (const loaded of fixtures) {
    const first = analyzeRawPlan(loaded.input);
    const second = analyzeRawPlan(loaded.input);
    assert.equal(first.status, "structured", loaded.name);
    assert.equal(first.parser, "mysql", loaded.name);
    assert.deepStrictEqual(first, second, `${loaded.name} must be deterministic`);
  }
});
