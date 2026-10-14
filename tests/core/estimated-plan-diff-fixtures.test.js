import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { analyzeRawPlan, createRawPlanInput } from "../../src/core/index.js";
import { diffEstimatedPlans } from "../../src/core/diff/estimated-plan-diff.js";
import { normalizedNode } from "../helpers/plan-builders.js";
import { REPO_ROOT, validateFixtureMeta } from "../helpers/fixtures.js";

const DIFF_FIXTURES = path.join(REPO_ROOT, "fixtures", "diff");

async function loadPair(database) {
  const load = async (side) => {
    const base = path.join(DIFF_FIXTURES, database, `index-${side}.synthetic`);
    const [planText, metaText] = await Promise.all([
      readFile(`${base}.plan.json`, "utf8"),
      readFile(`${base}.meta.json`, "utf8"),
    ]);
    const plan = JSON.parse(planText);
    const meta = JSON.parse(metaText);
    assert.equal(meta.database, database);
    assert.equal(meta.mode, "estimated");
    assert.equal(meta.format, "json");
    assert.equal(meta.source.kind, "synthetic");
    assert.deepEqual(validateFixtureMeta(meta, { name: `index-${side}.synthetic` }), []);
    assert.equal(meta.databaseVersion, null);
    const rawInput = createRawPlanInput({
      database: meta.database,
      mode: meta.mode,
      format: meta.format,
      plan,
      sql: meta.expect.sql,
    });
    return { meta, analysis: analyzeRawPlan(rawInput) };
  };
  return { before: await load("before"), after: await load("after") };
}

test("synthetic PostgreSQL before/after fixture matches the relation across Seq Scan to Index Scan", async () => {
  const { before, after } = await loadPair("postgresql");
  assert.equal(before.meta.expect.rootNodeType, "Seq Scan");
  assert.equal(after.meta.expect.rootNodeType, "Index Scan");
  assert.equal(before.analysis.normalized.root.engineSpecific.extra.Schema, "public");
  assert.equal(after.analysis.normalized.root.engineSpecific.extra.Schema, "public");

  const result = diffEstimatedPlans(before.analysis, after.analysis);
  assert.equal(result.status, "comparable");
  assert.equal(result.database, "postgresql");
  assert.deepEqual(result.matches.map(({ beforeId, afterId }) => [beforeId, afterId]), [["0", "0"]]);
  assert.ok(result.matches[0].changes.some(({ field, before: oldValue, after: newValue }) =>
    field === "operator.nodeType" && oldValue === "Seq Scan" && newValue === "Index Scan"));
  assert.ok(result.matches[0].changes.some(({ field, after: value }) => field === "relation.indexName" && value === "orders_status_idx"));

  const otherSchema = structuredClone(after.analysis);
  otherSchema.normalized.root.engineSpecific.extra.Schema = "tenant_b";
  const crossSchema = diffEstimatedPlans(before.analysis, otherSchema);
  assert.equal(crossSchema.matches.length, 0, "schema evidence prevents matching a same-named table in another schema");
});

test("PostgreSQL Bitmap Index Scan without relation identity does not block an anchored ancestor", async () => {
  const fixturePath = path.join(REPO_ROOT, "fixtures", "postgres", "estimated", "bitmap-scan.plan.json");
  const plan = JSON.parse(await readFile(fixturePath, "utf8"));
  const analysis = analyzeRawPlan(createRawPlanInput({
    database: "postgresql",
    mode: "estimated",
    format: "json",
    plan,
    sql: "SELECT * FROM pd_fix_events WHERE customer_id BETWEEN 100 AND 115",
  }));
  const heapScan = analysis.normalized.root;
  const bitmapIndexScan = heapScan.children[0];
  assert.equal(heapScan.kind, "bitmap_heap_scan");
  assert.equal(bitmapIndexScan.kind, "bitmap_index_scan");
  assert.equal(bitmapIndexScan.relation?.name ?? null, null);

  const withSort = (sortKeys) => {
    const wrapped = structuredClone(analysis);
    wrapped.normalized.root = normalizedNode({
      id: "synthetic-sort",
      kind: "sort",
      nodeType: "Sort",
      sortKeys,
      children: [wrapped.normalized.root],
    });
    return wrapped;
  };
  const result = diffEstimatedPlans(withSort(["pd_fix_events.customer_id"]), withSort(["pd_fix_events.customer_id DESC"]));

  const sortMatch = result.matches.find(({ beforeId }) => beforeId === "synthetic-sort");
  assert.ok(sortMatch, "the matched heap relation anchors lineage through its Bitmap Index Scan child");
  assert.deepEqual(sortMatch.changes.find(({ field }) => field === "sortKeys"), {
    field: "sortKeys",
    before: ["pd_fix_events.customer_id"],
    after: ["pd_fix_events.customer_id DESC"],
  });
  assert.ok(result.matches.some(({ beforeId }) => beforeId === heapScan.id));
  assert.deepEqual(result.unmatched.baseline, [{ id: bitmapIndexScan.id, reasonCode: "NO_STABLE_RELATION" }]);
  assert.deepEqual(result.unmatched.current, [{ id: bitmapIndexScan.id, reasonCode: "NO_STABLE_RELATION" }]);
});

test("synthetic MySQL before/after fixture matches the table while keeping native cost unmapped", async () => {
  const { before, after } = await loadPair("mysql");
  assert.equal(before.meta.expect.rootNodeType, "Query Block");
  assert.equal(after.meta.expect.rootNodeType, "Query Block");

  const beforeScan = before.analysis.normalized.root.children[0];
  const afterScan = after.analysis.normalized.root.children[0];
  assert.equal(beforeScan.nodeType, "Table Scan");
  assert.equal(afterScan.nodeType, "Index Lookup");
  assert.equal(beforeScan.totalCost, null);
  assert.equal(afterScan.totalCost, null);

  const result = diffEstimatedPlans(before.analysis, after.analysis);
  assert.equal(result.status, "comparable");
  assert.equal(result.database, "mysql");
  const scanMatch = result.matches.find(({ beforeId }) => beforeId === beforeScan.id);
  assert.ok(scanMatch, "the table access remains matched across access-type change");
  assert.equal(scanMatch.afterId, afterScan.id);
  assert.ok(scanMatch.changes.some(({ field }) => field === "operator.nodeType"));
  assert.ok(scanMatch.changes.some(({ field }) => field === "estimatedRows"));
  assert.equal(scanMatch.changes.some(({ field }) => field === "totalCost"), false);
});
