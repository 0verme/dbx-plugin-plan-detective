import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { buildAiAnalysisPrompt } from "../../src/lib/ai-analysis-prompt.js";
import { presentHotspotCostNote } from "../../src/lib/hotspot-presentation.js";
import { buildNodeInspector, buildPlanSummary, buildTreeRows } from "../../src/lib/view-model.js";
import { loadFixture } from "../helpers/fixtures.js";

const joinFixture = await loadFixture({ database: "sqlite", mode: "estimated", name: "join-temp-btree-order" });
const joinAnalysis = analyzePlan(joinFixture.input);

test("SQLite Plan Summary counts scans and sorts while leaving cost and row estimates empty", () => {
  const summary = buildPlanSummary(joinAnalysis.metrics, "en", "sqlite");
  const byKey = new Map(summary.rows.map((row) => [row.key, row.value]));

  assert.equal(byKey.get("totalEstimatedCost"), null);
  assert.equal(byKey.get("rootEstimatedRows"), null);
  assert.equal(byKey.get("nodeCount"), "3");
  assert.equal(byKey.get("scanCount"), "2");
  assert.equal(byKey.get("indexScanCount"), "2");
  assert.equal(byKey.get("sortCount"), "1");
});

test("SQLite Plan Tree rows and Node Inspector expose EQP id, parent, access strategy, index condition, and detail", () => {
  const rows = buildTreeRows(joinAnalysis.normalized.root);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].label, "Index Search · c via idx_pd_fix_customers_region");
  assert.equal(rows[3].label, "Temp B-Tree (ORDER BY)");

  const indexSearchNode = joinAnalysis.normalized.root.children[0];
  const inspectorEn = buildNodeInspector(indexSearchNode, "en");
  const fieldsEn = inspectorEn.groups.flatMap((group) => group.fields);
  assert.ok(fieldsEn.some((field) => field.label === "EQP Node ID (id)" && field.value === "6"));
  assert.ok(fieldsEn.some((field) => field.label === "Parent Node ID (parent)" && field.value === "0"));
  assert.ok(fieldsEn.some((field) => field.label === "Access Strategy" && field.value === "INDEX"));
  assert.ok(fieldsEn.some((field) => field.label === "Index Condition" && field.value === "region=?"));
  assert.ok(fieldsEn.some((field) => field.label === "Detail" && field.value.includes("SEARCH c USING INDEX")));

  const sortNode = joinAnalysis.normalized.root.children[2];
  const inspectorZh = buildNodeInspector(sortNode, "zh-CN");
  const fieldsZh = inspectorZh.groups.flatMap((group) => group.fields);
  assert.ok(fieldsZh.some((field) => field.label === "临时 B-Tree 用途" && field.value === "ORDER BY"));
});

test("SQLite cost note and AI prompt explain that EXPLAIN QUERY PLAN provides no cost or row estimates", () => {
  assert.match(
    presentHotspotCostNote(joinAnalysis.hotspots.cost, "zh-CN"),
    /SQLite EXPLAIN QUERY PLAN 仅报告访问路径、索引与临时 B-Tree 等结构信息/,
  );
  assert.match(
    presentHotspotCostNote(joinAnalysis.hotspots.cost, "en"),
    /SQLite EXPLAIN QUERY PLAN reports access paths, indexes, and temporary B-trees only/,
  );

  const prompt = buildAiAnalysisPrompt({
    rawInput: joinFixture.input,
    analysis: joinAnalysis,
    databaseType: "sqlite",
    locale: "zh-CN",
  });
  assert.match(prompt, /Database Type: sqlite/);
  assert.match(prompt, /SQLite EXPLAIN QUERY PLAN 仅报告访问路径/);
  assert.doesNotMatch(prompt, /Total Estimated Cost:/);
});
