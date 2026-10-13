import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { buildAiAnalysisPrompt } from "../../src/lib/ai-analysis-prompt.js";
import { describeAnalysisError, describeAnalysisNotice } from "../../src/lib/host-view-model.js";
import { buildFindingViews, buildHotspotViews, buildTreeRows, indexRowsById } from "../../src/lib/view-model.js";
import { loadFixture } from "../helpers/fixtures.js";

const fixture = await loadFixture({ database: "mysql", mode: "estimated", name: "large-table-scan.synthetic" });
const analysis = analyzePlan(fixture.input);
const rowsById = indexRowsById(buildTreeRows(analysis.normalized.root));

test("locale changes refresh findings, hotspots, status and AI prompt without changing plan data", () => {
  const beforeAnalysis = JSON.stringify(analysis);
  const beforeInput = JSON.stringify(fixture.input);
  const originalSql = fixture.input.sql;
  const originalPlan = JSON.stringify(fixture.input.plan);

  const zhFindings = buildFindingViews(analysis.findings, rowsById, "zh-CN");
  const enFindings = buildFindingViews(analysis.findings, rowsById, "en");
  const zhHotspots = buildHotspotViews(analysis.hotspots, rowsById, analysis.findings, "zh-CN");
  const enHotspots = buildHotspotViews(analysis.hotspots, rowsById, analysis.findings, "en");

  assert.equal(zhFindings[0].presentation.locale, "zh-CN");
  assert.equal(enFindings[0].presentation.locale, "en");
  assert.match(zhFindings[0].title, /全表扫描/);
  assert.match(enFindings[0].title, /full-table scan/);
  assert.match(zhHotspots.items[0].summary, /全表扫描/);
  assert.match(enHotspots.items[0].summary, /full table scan/);
  assert.deepEqual(
    enHotspots.items[0].reasons.map((reason) => reason.statement),
    analysis.hotspots.items[0].reasons.map((reason) => reason.statement),
    "technical Core statements are preserved verbatim in either locale",
  );

  const zhPrompt = buildAiAnalysisPrompt({ rawInput: fixture.input, analysis, databaseType: "mysql", locale: "zh-CN" });
  const enPrompt = buildAiAnalysisPrompt({ rawInput: fixture.input, analysis, databaseType: "mysql", locale: "en-US" });
  assert.match(zhPrompt, /当前数据来自 Estimated Plan/);
  assert.match(enPrompt, /This data comes from an Estimated Plan/);
  if (originalSql) {
    assert.ok(zhPrompt.includes(originalSql));
    assert.ok(enPrompt.includes(originalSql));
  }
  assert.doesNotMatch(enPrompt, /undefined|\bnull\b/);

  assert.match(describeAnalysisNotice({ status: "structured" }, "zh-CN").title, /已获取并解析/);
  assert.match(describeAnalysisNotice({ status: "structured" }, "en").title, /received and parsed/);
  assert.notEqual(describeAnalysisError("PLAN_PARSE_FAILED", "zh-CN").hint, describeAnalysisError("PLAN_PARSE_FAILED", "en").hint);

  assert.equal(JSON.stringify(analysis), beforeAnalysis, "switching presentation language does not rerun or mutate Core analysis");
  assert.equal(JSON.stringify(fixture.input), beforeInput, "raw plan input and SQL stay intact");
  assert.equal(fixture.input.sql, originalSql);
  assert.equal(JSON.stringify(fixture.input.plan), originalPlan);
});
