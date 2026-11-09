import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { describeEstimatedPlanDiffSupport, diffEstimatedPlans } from "../../src/core/diff/estimated-plan-diff.js";
import { flattenNodes } from "../../src/core/tree.js";
import { buildNodeInspector, buildPlanSummary, buildTreeRows } from "../../src/lib/view-model.js";
import { createPlanSnapshot, deserializePlanSnapshot, serializePlanSnapshot } from "../../src/lib/plan-snapshot.js";
import { loadFixture } from "../helpers/fixtures.js";

const fixture = await loadFixture({ database: "db2", mode: "estimated", name: "index-join-sort-aggregate.synthetic" });
const analysis = analyzePlan(fixture.input);

test("DB2 Plan Summary labels output cardinality and omits an unclassified sequential-scan count", () => {
  const summary = buildPlanSummary(analysis.metrics, "en", "db2");
  assert.equal(summary.rows.some((row) => row.key === "sequentialScanCount"), false);
  assert.equal(summary.rows.find((row) => row.key === "rootEstimatedRows").value, null);
  const cardinality = summary.highlights.find((highlight) => highlight.key === "largestEstimatedRows");
  assert.equal(cardinality.label, "Largest Stream Output Cardinality");
  assert.equal(cardinality.note, "DB2 estimated output cardinality; not scan rows or actual rows.");
});

test("DB2 tree rows show exact timerons and stream cardinality with explicit units / meaning", () => {
  const rows = buildTreeRows(analysis.normalized.root);
  const scan = rows.find((row) => row.kind === "index_scan");
  assert.ok(scan);
  assert.equal(scan.db2TotalCost, "0.0500000000000000000000001");
  assert.equal(scan.db2RowCount, "0.03999999910593033");
  assert.equal(scan.totalCost, null, "timerons never enter the generic cost column");
  assert.equal(rows[0].db2TotalCost, null, "the structural root does not turn a missing cost into zero");
});

test("DB2 Node Inspector shows relation/index names, predicates and native metric units", () => {
  const node = flattenNodes(analysis.normalized.root).find((entry) => entry.engineSpecific?.db2?.operatorId === "4");
  const inspector = buildNodeInspector(node, "en");
  assert.equal(inspector.title, "NLJOIN");
  const fields = inspector.groups.flatMap((group) => group.fields);
  assert.ok(fields.some((field) => field.label === "Total Cost (timerons)" && field.value === "0.1000000000000000000000001"));
  assert.ok(fields.some((field) => field.label === "Predicates" && field.value.includes("JOIN: (O.CUSTOMER_ID = C.ID)")));
  assert.ok(fields.some((field) => field.label === "Stream Cardinality (estimated output rows)" && field.value === "2.25000000000000000001"));
  assert.ok(fields.some((field) => field.label === "Output Streams" && field.value.includes("rowCount=2.25000000000000000001")));

  const rootFields = buildNodeInspector(analysis.normalized.root, "en").groups.flatMap((group) => group.fields);
  assert.ok(rootFields.some((field) => field.label === "Statement Metadata" && field.value.includes("EXPLAIN_LEVEL")));

  const withArgument = analyzePlan({
    ...fixture.input,
    plan: { ...fixture.plan, arguments: [{ operatorId: "5", type: "PREDICATE", value: "STATUS = ?" }] },
  });
  const argumentNode = flattenNodes(withArgument.normalized.root).find((entry) => entry.engineSpecific?.db2?.operatorId === "5");
  const argumentFields = buildNodeInspector(argumentNode, "en").groups.flatMap((group) => group.fields);
  assert.ok(argumentFields.some((field) => field.label === "DB2 Arguments" && field.value === "PREDICATE: STATUS = ?"));

  const indexScan = flattenNodes(analysis.normalized.root).find((entry) => entry.engineSpecific?.db2?.operatorId === "5");
  const indexFields = buildNodeInspector(indexScan, "en").groups.flatMap((group) => group.fields);
  assert.ok(indexFields.some((field) => field.label === "Index Name" && field.value === "APP.IDX_CUSTOMER_STATUS"));
});

test("DB2 snapshot raw JSON round-trips and remains analyzable without losing exact decimals", () => {
  const snapshot = createPlanSnapshot({
    session: {
      status: "structured",
      capturedAt: "2026-10-20T00:00:00.000Z",
      source: { databaseName: "SAMPLE", schema: "APP" },
      rawInput: fixture.input,
      analysis: { status: "structured" },
      hostResult: { truncated: false, rawPlan: fixture.plan },
    },
    title: "DB2 estimate",
    note: "fixture round-trip",
    producerVersion: "0.7.1",
    snapshotId: "db2-snapshot-test",
    now: new Date("2026-10-20T00:01:00.000Z"),
  });
  const restored = deserializePlanSnapshot(serializePlanSnapshot(snapshot));
  assert.equal(restored.rawInput.database, "db2");
  assert.deepEqual(restored.rawInput.plan, fixture.plan);
  const replayed = analyzePlan(restored.rawInput);
  const indexScan = flattenNodes(replayed.normalized.root).find((node) => node.engineSpecific?.db2?.operatorId === "5");
  assert.equal(indexScan.engineSpecific.db2.totalCost, "0.0500000000000000000000001");
});

test("DB2 plans do not expand the existing Estimated Plan Diff support scope", () => {
  assert.equal(describeEstimatedPlanDiffSupport(analysis).supported, false);
  const comparison = diffEstimatedPlans(analysis, analysis);
  assert.equal(comparison.status, "incompatible");
  assert.equal(comparison.reasonCode, "UNSUPPORTED_DATABASE");
});
