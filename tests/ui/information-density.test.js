import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createTranslator } from "../../src/lib/i18n/index.js";

const componentUrl = (name) => new URL(`../../src/components/${name}.svelte`, import.meta.url);
const [summaryMarkup, connectionMarkup, findingsMarkup, hotspotsMarkup, sqlInputMarkup] = await Promise.all(
  ["PlanSummary", "ConnectionContext", "FindingsList", "HotspotsList", "SqlInput"].map((name) => readFile(componentUrl(name), "utf8")),
);

test("summary foregrounds the core metrics and Findings count while preserving secondary details", async () => {
  const layoutMarkup = await readFile(componentUrl("PlanAnalysisLayout"), "utf8");

  assert.match(summaryMarkup, /primaryMetricKeys = \["totalEstimatedCost", "rootEstimatedRows", "nodeCount"\]/);
  assert.match(summaryMarkup, /<dl class="key-metrics" aria-label=\{t\("summary\.keyMetrics\.ariaLabel"\)\}>/);
  assert.match(summaryMarkup, /row\.key === "totalEstimatedCost"[\s\S]*?\{row\.hint\}/);
  assert.match(summaryMarkup, /class="key-metric findings-count"[\s\S]*?<dd>\{findingCount \?\? 0\}<\/dd>/);
  assert.match(summaryMarkup, /<details class="secondary-details">[\s\S]*?summary\.secondary[\s\S]*?summary\.highlights/);
  assert.doesNotMatch(summaryMarkup, /<details class="secondary-details" open>/);
  assert.match(layoutMarkup, /findingCount=\{findingCounts\.total\}/);
});

test("connection keeps Estimated Plan support and refresh visible, with technical fields on demand", () => {
  const status = connectionMarkup.match(/<dl class="facts capability-summary">([\s\S]*?)<\/dl>/)?.[1];
  const details = connectionMarkup.match(/<details class="capability-details">([\s\S]*?)<\/details>/)?.[1];

  assert.ok(status, "capability status remains visible");
  assert.match(status, /connection\.capabilities\.estimatedPlan/);
  assert.match(status, /capabilities\.estimatedPlan/);
  assert.ok(details, "technical fields are disclosed on demand");
  assert.match(details, /connection\.capabilities\.dbType/);
  assert.match(details, /connection\.capabilities\.limits/);
  assert.match(connectionMarkup, /aria-label=\{t\("connection\.refresh"\)\}[\s\S]*?onclick=\{onRefresh\}/);
  assert.match(sqlInputMarkup, /rows="7"/);
  assert.match(sqlInputMarkup, /min-height: 120px/);
  assert.match(sqlInputMarkup, /resize: vertical/);
});

test("empty diagnostics are compact but keep caveats, cost notes, and hit evidence", () => {
  assert.match(findingsMarkup, /class="empty compact"/);
  assert.match(findingsMarkup, /<details class="evidence">/);
  assert.match(hotspotsMarkup, /class="empty compact"/);
  assert.match(hotspotsMarkup, /class="cost-note">\{view\.costNote\}/);
  assert.match(hotspotsMarkup, /<details class="evidence">/);
  assert.match(summaryMarkup, /class="key-hint">\{row\.hint\}/);

  const zh = createTranslator("zh-CN").t;
  const en = createTranslator("en").t;
  assert.equal(zh("summary.keyMetrics.ariaLabel"), "计划关键指标");
  assert.equal(en("summary.keyMetrics.ariaLabel"), "Key plan metrics");
  assert.equal(zh("summary.secondary"), "更多指标与重点");
  assert.equal(en("summary.secondary"), "More metrics and highlights");
  assert.equal(zh("connection.capabilities.technicalDetails"), "技术细节");
  assert.equal(en("connection.capabilities.technicalDetails"), "Technical details");
  for (const t of [zh, en]) {
    assert.match(t("findings.hint"), /Estimated Plan/);
    assert.match(t("summary.rows.totalEstimatedCost.hint"), /不是运行时耗时|not runtime duration/);
    assert.match(t("findings.empty"), /空结果不代表计划没有问题|empty result does not mean the plan has no issues/);
    assert.match(t("hotspots.empty"), /空结果不代表计划没有问题|empty result does not mean the plan has no issues/);
  }
});
