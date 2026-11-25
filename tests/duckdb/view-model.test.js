import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { buildAiAnalysisPrompt } from "../../src/lib/ai-analysis-prompt.js";
import { presentHotspotCostNote } from "../../src/lib/hotspot-presentation.js";
import { buildNodeInspector, buildPlanSummary, buildTreeRows } from "../../src/lib/view-model.js";
import { loadFixture } from "../helpers/fixtures.js";

const officialFixture = await loadFixture({ database: "duckdb", mode: "estimated", name: "official-hash-join-filter" });
const officialAnalysis = analyzePlan(officialFixture.input);

test("DuckDB Plan Summary reports operator counts and largest EC without fabricating total cost", () => {
  const summary = buildPlanSummary(officialAnalysis.metrics, "en", "duckdb");
  const byKey = new Map(summary.rows.map((row) => [row.key, row.value]));

  assert.equal(byKey.get("totalEstimatedCost"), null);
  assert.equal(byKey.get("nodeCount"), "5");
  assert.equal(byKey.get("scanCount"), "2");
  assert.equal(byKey.get("sequentialScanCount"), "2");
  assert.equal(byKey.get("joinCount"), "1");
  const largestRows = summary.highlights.find((item) => item.key === "largestEstimatedRows");
  assert.equal(largestRows?.value, "3");
});

test("DuckDB Plan Tree and Node Inspector display table, EC, join condition, and projections", () => {
  const rows = buildTreeRows(officialAnalysis.normalized.root);
  assert.equal(rows.length, 5);
  assert.equal(rows[2].label, "SEQ_SCAN · exams");
  assert.equal(rows[2].estimatedRows, 3);

  const hashJoin = officialAnalysis.normalized.root.children[0];
  const inspectorEn = buildNodeInspector(hashJoin, "en");
  const fieldsEn = inspectorEn.groups.flatMap((group) => group.fields);
  assert.ok(fieldsEn.some((field) => field.label === "Estimated Cardinality (EC)" && field.value === "1"));
  assert.ok(fieldsEn.some((field) => field.label === "Join Type" && field.value === "INNER"));
  assert.ok(fieldsEn.some((field) => field.label === "Join Condition" && field.value === "sid = sid"));

  const rootInspectorZh = buildNodeInspector(officialAnalysis.normalized.root, "zh-CN");
  const fieldsZh = rootInspectorZh.groups.flatMap((group) => group.fields);
  assert.ok(fieldsZh.some((field) => field.label === "投影列 / 表达式" && field.value === "name"));
  assert.ok(fieldsZh.some((field) => field.label === "计划阶段标题" && field.value === "Physical Plan"));
});

test("DuckDB cost note and AI prompt explain that DuckDB EXPLAIN reports EC without PostgreSQL cost units", () => {
  assert.match(
    presentHotspotCostNote(officialAnalysis.hotspots.cost, "zh-CN"),
    /DuckDB EXPLAIN 报告算子估算基数（EC），不提供 PostgreSQL 风格累计成本数值/,
  );
  assert.match(
    presentHotspotCostNote(officialAnalysis.hotspots.cost, "en"),
    /DuckDB EXPLAIN reports estimated cardinality \(EC\) without PostgreSQL-style cumulative cost units/,
  );

  const prompt = buildAiAnalysisPrompt({
    rawInput: officialFixture.input,
    analysis: officialAnalysis,
    databaseType: "duckdb",
    locale: "zh-CN",
  });
  assert.match(prompt, /Database Type: duckdb/);
  assert.match(prompt, /DuckDB EXPLAIN 报告算子估算基数（EC）/);
  assert.doesNotMatch(prompt, /Total Estimated Cost:/);
});
