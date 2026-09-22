import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { PlanParseError } from "../../src/core/errors.js";
import { analyzeRawPlan } from "../../src/core/parsers/index.js";
import { flattenNodes } from "../../src/core/tree.js";
import { loadAllFixtures, loadFixture } from "../helpers/fixtures.js";

/**
 * End-to-end Core contract for SQL Server:
 *
 *     RawPlanInput(sqlserver, xml) -> analyzeRawPlan -> structured
 *       -> normalized -> metrics -> findings -> hotspots
 *
 * These tests pin the metrics the shared engine derives from ShowPlanXML and
 * the exact applicability of the existing rules. SQL Server costs are not a
 * PostgreSQL cost model, so no cost-based metric or rule may fire.
 */

const fixtures = await loadAllFixtures("sqlserver");
const analysisByFixture = new Map(fixtures.map((fixture) => [fixture.name, analyzePlan(fixture.input)]));

/** @param {string} name */
function fixture(name) {
  return loadFixture({ database: "sqlserver", mode: "estimated", name });
}

/** @param {string} name */
function analysisFor(name) {
  const analysis = analysisByFixture.get(name);
  assert.ok(analysis, `missing fixture ${name}`);
  return analysis;
}

test("analyzeRawPlan reports SQL Server as structured and fills every stage", async () => {
  const loaded = await fixture("table-scan.synthetic");
  const result = analyzeRawPlan(loaded.input);

  assert.equal(result.status, "structured");
  assert.equal(result.parser, "sqlserver");
  assert.equal(result.reasonCode, null);
  assert.equal(result.reason, null);
  assert.equal(result.parsed.database, "sqlserver");
  assert.equal(result.parsed.format, "xml");
  assert.equal(result.normalized.database, "sqlserver");
  assert.ok(result.metrics.nodeCount >= 1);
  assert.ok(result.findings.length > 0);
  assert.ok(result.hotspots.items.length > 0);

  const strict = analyzePlan(loaded.input);
  assert.deepStrictEqual(
    { parsed: strict.parsed, normalized: strict.normalized, metrics: strict.metrics, findings: strict.findings, hotspots: strict.hotspots },
    {
      parsed: result.parsed,
      normalized: result.normalized,
      metrics: result.metrics,
      findings: result.findings,
      hotspots: result.hotspots,
    },
  );
});

test("metrics count SQL Server scans, joins, sorts and aggregates through the shared engine", () => {
  const cases = [
    ["table-scan.synthetic", { nodeCount: 1, maxDepth: 1, scanCount: 1, sequentialScanCount: 1, indexScanCount: 0, joinCount: 0, sortCount: 0, aggregateCount: 0 }],
    ["index-seek.synthetic", { nodeCount: 1, scanCount: 1, sequentialScanCount: 0, indexScanCount: 1 }],
    ["index-scan.synthetic", { nodeCount: 1, scanCount: 1, indexScanCount: 1 }],
    ["key-lookup.synthetic", { nodeCount: 2, maxDepth: 2, scanCount: 2, indexScanCount: 2 }],
    ["nested-loops.synthetic", { nodeCount: 3, maxDepth: 2, scanCount: 2, indexScanCount: 2, joinCount: 1 }],
    ["sort.synthetic", { nodeCount: 3, maxDepth: 3, scanCount: 1, indexScanCount: 1, sortCount: 1 }],
    ["stream-aggregate.synthetic", { nodeCount: 2, aggregateCount: 1, indexScanCount: 1 }],
    ["compute-scalar-filter.synthetic", { nodeCount: 3, maxDepth: 3, scanCount: 1, indexScanCount: 1 }],
    ["top-concatenation.synthetic", { nodeCount: 4, maxDepth: 3, scanCount: 2, indexScanCount: 2 }],
    ["unknown-operator.synthetic", { nodeCount: 2, unknownNodeTypeCount: 1, sequentialScanCount: 1 }],
  ];

  for (const [name, expected] of cases) {
    const { metrics } = analysisFor(name);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(metrics[key], value, `${name}: metrics.${key}`);
    }
  }
});

test("metrics never invent a PostgreSQL cost for SQL Server", () => {
  for (const fixtureEntry of fixtures) {
    const { metrics } = analysisFor(fixtureEntry.name);
    assert.equal(metrics.totalEstimatedCost, null, `${fixtureEntry.name}: SQL Server has no PostgreSQL total cost`);
    assert.equal(metrics.highestIncrementalCost, null, `${fixtureEntry.name}: incremental cost needs PostgreSQL cost data`);
    assert.deepEqual(
      metrics.costAttribution,
      { engine: "sqlserver", status: "not-applicable", reason: "NOT_POSTGRES_COST_MODEL" },
      fixtureEntry.name,
    );
  }
});

test("missing estimates degrade to null instead of being guessed", () => {
  const { normalized, metrics } = analysisFor("minimal-fields.synthetic");

  assert.equal(normalized.root.estimatedRows, null);
  assert.equal(normalized.root.width, null);
  assert.equal(normalized.root.totalCost, null);
  assert.equal(metrics.rootEstimatedRows, null);
  assert.equal(metrics.largestEstimatedRows, null);
  assert.equal(metrics.nodeCount, 2);
});

test("large-sequential-scan fires on the row branch with a null cost, without fabricating zero", () => {
  const { findings, normalized } = analysisFor("table-scan.synthetic");
  const scan = findings.find((finding) => finding.ruleId === "large-sequential-scan");

  assert.ok(scan, "the 250000-row Table Scan must be reported");
  assert.equal(scan.severity, "high");
  assert.equal(scan.nodeRef, "0");
  assert.equal(scan.evidence.nodeType, "Table Scan");
  assert.equal(scan.evidence.estimatedRows, 250_000);
  assert.equal(scan.evidence.incrementalCost, null, "a missing cost must stay null, not become 0");
  assert.equal(scan.evidence.estimatedTotalCost, null);
  assert.equal(scan.facts.database, "sqlserver");
  assert.equal(scan.facts.accessType, null, "accessType is a MySQL vocabulary and must not be invented");
  assert.equal(scan.facts.hasFilter, true);
  assert.match(scan.summary, /Table Scan on Customers/);
  assert.match(scan.summary, /does not report a cost estimate/);

  // The subtree estimate is still visible, but only under engineSpecific.
  const node = flattenNodes(normalized.root)[0];
  assert.equal(node.engineSpecific.sqlServer.estimatedTotalSubtreeCost, 12.5);
  assert.equal(node.totalCost, null);
});

test("nested-loop-large-inner works on ShowPlanXML child estimates", () => {
  const { normalized, findings } = analysisFor("nested-loops-large-inner.synthetic");
  const finding = findings.find((candidate) => candidate.ruleId === "nested-loop-large-inner");

  assert.ok(finding, "the join rule must see the two SQL Server inputs");
  assert.equal(finding.nodeRef, "0");
  assert.equal(finding.severity, "warning");
  assert.equal(normalized.root.kind, "nested_loop");
  assert.equal(normalized.root.joinType, "Inner Join");
  assert.equal(finding.evidence.outerEstimatedRows, 1_000);
  assert.equal(finding.evidence.innerEstimatedRows, 50_000);
  assert.equal(finding.evidence.estimatedRowComparisons, 50_000_000);
  assert.equal(finding.evidence.estimateOnly, true);
});

test("expensive-sort stays silent for SQL Server: the rule depends on PostgreSQL cost data", () => {
  for (const fixtureEntry of fixtures) {
    for (const finding of analysisFor(fixtureEntry.name).findings) {
      assert.notEqual(finding.ruleId, "expensive-sort", `${fixtureEntry.name} must not trigger a cost-based sort rule`);
    }
  }
});

test("an unknown operator stays structured and never drops its subtree", () => {
  const { normalized, metrics } = analysisFor("unknown-operator.synthetic");

  assert.equal(normalized.root.kind, "unknown");
  assert.equal(normalized.root.nodeType, "Future Shuffle");
  assert.equal(normalized.root.children.length, 1);
  assert.equal(normalized.root.children[0].kind, "seq_scan");
  assert.deepEqual(normalized.unknownNodeTypes, ["Future Shuffle"]);
  assert.equal(metrics.unknownNodeTypeCount, 1);
  assert.equal(metrics.nodeCount, 2);
});

test("a malformed or multi-statement ShowPlanXML fails loudly through the strict entry point", async () => {
  const multiStatement = `<ShowPlanXML><BatchSequence><Batch><Statements>
    <StmtSimple StatementType="SELECT"><QueryPlan><RelOp NodeId="0" PhysicalOp="Table Scan" LogicalOp="Table Scan"><TableScan/></RelOp></QueryPlan></StmtSimple>
    <StmtSimple StatementType="SELECT"><QueryPlan><RelOp NodeId="1" PhysicalOp="Table Scan" LogicalOp="Table Scan"><TableScan/></RelOp></QueryPlan></StmtSimple>
  </Statements></Batch></BatchSequence></ShowPlanXML>`;

  assert.throws(
    () => analyzePlan({ database: "sqlserver", mode: "estimated", format: "xml", plan: multiStatement }),
    (error) => {
      assert.ok(error instanceof PlanParseError);
      assert.equal(error.code, "MULTIPLE_STATEMENTS");
      return true;
    },
  );

  assert.throws(
    () => analyzePlan({ database: "sqlserver", mode: "estimated", format: "xml", plan: "<ShowPlanXML><broken>" }),
    (error) => {
      assert.ok(error instanceof PlanParseError);
      assert.equal(error.code, "MALFORMED_XML");
      return true;
    },
  );
});

test("every SQL Server fixture is structured and deterministic through the registry", () => {
  for (const fixtureEntry of fixtures) {
    const first = analyzeRawPlan(fixtureEntry.input);
    const second = analyzeRawPlan(fixtureEntry.input);
    assert.equal(first.status, "structured", fixtureEntry.name);
    assert.equal(first.parser, "sqlserver", fixtureEntry.name);
    assert.deepStrictEqual(first, second, `${fixtureEntry.name} must be deterministic`);
  }
});
