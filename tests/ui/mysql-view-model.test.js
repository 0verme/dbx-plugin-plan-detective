import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import {
  buildFindingViews,
  buildNodeInspector,
  buildPlanSummary,
  buildTreeRows,
  indexNodesById,
  indexRowsById,
} from "../../src/lib/view-model.js";
import { loadFixture } from "../helpers/fixtures.js";

/**
 * The UI consumes the same view-model for every database. These tests pin that
 * a MySQL NormalizedPlan renders through the existing Plan Tree / Plan Summary /
 * Node Inspector / Findings helpers without any MySQL-only UI path.
 */

const grouping = await loadFixture({ database: "mysql", mode: "estimated", name: "grouping-temporary.synthetic" });
const join = await loadFixture({ database: "mysql", mode: "estimated", name: "nested-loop-large-inner.synthetic" });

const groupingAnalysis = analyzePlan(grouping.input);
const joinAnalysis = analyzePlan(join.input);

function inspectorFields(inspector) {
  return new Map(inspector.groups.flatMap((group) => group.fields).map((field) => [field.label, field.value]));
}

test("buildTreeRows renders the MySQL tree with relation and index labels", () => {
  const rows = buildTreeRows(groupingAnalysis.normalized.root);

  assert.deepEqual(
    rows.map((row) => row.id),
    ["0", "0.0", "0.0.0"],
  );
  assert.equal(rows[0].label, "Query Block");
  assert.equal(rows[1].label, "Grouping Operation");
  assert.equal(rows[2].label, "Index Range Scan · payments via idx_payments_created_at");
  assert.equal(rows[2].relation, "payments");
  assert.equal(rows[2].indexName, "idx_payments_created_at");
  assert.equal(rows[2].estimatedRows, 4000);
});

test("buildNodeInspector renders MySQL engine-specific fields and no PostgreSQL vocabulary", () => {
  const nodes = indexNodesById(groupingAnalysis.normalized.root);
  const tableInspector = buildNodeInspector(nodes.get("0.0.0"));
  const fields = inspectorFields(tableInspector);

  assert.equal(tableInspector.title, "Index Range Scan · payments via idx_payments_created_at");
  assert.equal(tableInspector.subtitle, "index_scan");
  assert.equal(fields.get("Access Type"), "range");
  assert.equal(fields.get("Structure"), "table");
  assert.equal(fields.get("Possible Keys"), "idx_payments_created_at");
  assert.equal(fields.get("Used Key Parts"), "created_at");
  assert.equal(fields.get("Key Length"), "5");
  assert.equal(fields.get("Rows Examined Per Scan"), "4,000");
  assert.equal(fields.get("Rows Produced Per Join"), "4,000");
  assert.equal(fields.get("Filtered"), "100%");
  assert.equal(fields.get("Using Index For Group By"), "true");
  assert.equal(fields.get("Read Cost"), "480");
  assert.equal(fields.get("Eval Cost"), "180");
  assert.equal(fields.get("Prefix Cost"), "660");
  assert.equal(fields.get("Data Read Per Join"), "320,000");

  // PostgreSQL-only fields must not leak into a MySQL node.
  for (const label of ["Parallel Aware", "Async Capable", "Strategy", "Partial Mode", "Parent Relationship", "Presorted Keys"]) {
    assert.equal(fields.has(label), false, `${label} is not a MySQL field`);
  }

  const groupingInspector = buildNodeInspector(nodes.get("0.0"));
  const groupingFields = inspectorFields(groupingInspector);
  assert.equal(groupingFields.get("Structure"), "grouping_operation");
  assert.equal(groupingFields.get("Using Temporary Table"), "true");
  assert.equal(groupingFields.has("Using Filesort"), false, "false flags stay hidden");

  const blockFields = inspectorFields(buildNodeInspector(nodes.get("0")));
  assert.equal(blockFields.get("Select ID"), "1");
  assert.equal(blockFields.get("Query Cost"), "660");
});

test("buildPlanSummary keeps MySQL cost rows empty instead of showing a fabricated value", () => {
  const summary = buildPlanSummary(groupingAnalysis.metrics);
  const rows = new Map(summary.rows.map((row) => [row.key, row.value]));

  assert.equal(rows.get("totalEstimatedCost"), null);
  assert.equal(rows.get("rootEstimatedRows"), null);
  assert.equal(rows.get("nodeCount"), "3");
  assert.equal(rows.get("scanCount"), "1");
  assert.equal(rows.get("aggregateCount"), "1");
  assert.equal(summary.highlights.find((highlight) => highlight.key === "highestIncrementalCost").value, null);
});

test("findings keep their node labels and null evidence readable", () => {
  const rows = buildTreeRows(joinAnalysis.normalized.root);
  const rowsById = indexRowsById(rows);
  const views = buildFindingViews(joinAnalysis.findings, rowsById);

  assert.deepEqual(
    views.map((view) => view.ruleId),
    ["large-sequential-scan", "nested-loop-large-inner"],
  );

  const scan = views.find((view) => view.ruleId === "large-sequential-scan");
  assert.equal(scan.nodeLabel, "0.0.1 · Table Scan · events");
  const scanEvidence = new Map(scan.evidence.map((row) => [row.path, row.value]));
  assert.equal(scanEvidence.get("incrementalCost"), "—", "a missing MySQL cost is shown as missing, not as 0");
  assert.equal(scanEvidence.get("estimatedRows"), "50,000");

  const nested = views.find((view) => view.ruleId === "nested-loop-large-inner");
  assert.equal(nested.nodeLabel, "0.0 · Nested Loop");
  const nestedEvidence = new Map(nested.evidence.map((row) => [row.path, row.value]));
  assert.equal(nestedEvidence.get("estimatedRowComparisons"), "50,000,000");
  assert.equal(nestedEvidence.get("estimateOnly"), "true");
});

test("the view-model works on every committed MySQL fixture", async () => {
  const { loadAllFixtures } = await import("../helpers/fixtures.js");
  for (const fixture of await loadAllFixtures("mysql")) {
    const analysis = analyzePlan(fixture.input);
    const rows = buildTreeRows(analysis.normalized.root);
    const rowsById = indexRowsById(rows);
    const views = buildFindingViews(analysis.findings, rowsById);

    assert.equal(rows.length, analysis.metrics.nodeCount, `${fixture.name} tree row count`);
    assert.equal(views.length, analysis.findings.length, `${fixture.name} finding views`);
    for (const row of rows) {
      assert.ok(row.label.length > 0, `${fixture.name} row ${row.id} has a label`);
      assert.notEqual(buildNodeInspector(indexNodesById(analysis.normalized.root).get(row.id)), null);
    }
  }
});
