import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { buildAiAnalysisPrompt, DEFAULT_EVIDENCE_BUDGET_CHARS } from "../../src/lib/ai-analysis-prompt.js";
import { loadFixture } from "../helpers/fixtures.js";

/**
 * The prompt builder is a pure local string generator. These tests pin the
 * #42 Prompt Context Contract: section coverage, engine-aware cost semantics,
 * empty-Finding semantics, missing-field omission, the evidence budget with an
 * explicit truncation marker, and the complete absence of `undefined` / `null`
 * noise.
 */

const pg = await loadFixture({ mode: "estimated", name: "large-seq-scan" });
const pgAnalysis = analyzePlan(pg.input);

const pgNoFindings = await loadFixture({ mode: "estimated", name: "nested-loop" });
const pgNoFindingsAnalysis = analyzePlan(pgNoFindings.input);

const pgEmpty = await loadFixture({ mode: "estimated", name: "seq-scan" });
const pgEmptyAnalysis = analyzePlan(pgEmpty.input);

const pgWithheld = await loadFixture({ mode: "estimated", name: "subplan-initplan" });
const pgWithheldAnalysis = analyzePlan(pgWithheld.input);

const mysql = await loadFixture({ database: "mysql", mode: "estimated", name: "nested-loop-large-inner.synthetic" });
const mysqlAnalysis = analyzePlan(mysql.input);

const sqlserver = await loadFixture({ database: "sqlserver", mode: "estimated", name: "table-scan.synthetic" });
const sqlserverAnalysis = analyzePlan(sqlserver.input);

const sqlserverSort = await loadFixture({ database: "sqlserver", mode: "estimated", name: "sort.synthetic" });
const sqlserverSortAnalysis = analyzePlan(sqlserverSort.input);

/** @param {object} context */
function zh(context) {
  return buildAiAnalysisPrompt({ locale: "zh-CN", ...context });
}

test("a plan with Findings and Hotspots gets every section", () => {
  const prompt = zh({ rawInput: pg.input, analysis: pgAnalysis, databaseType: "postgres" });

  assert.match(prompt, /^# DBX Plan Detective · AI analysis context/m);
  assert.match(prompt, /## Analysis constraints/);
  assert.match(prompt, /当前数据来自 Estimated Plan，不是实际运行结果。/);
  assert.match(prompt, /## Database Context/);
  assert.match(prompt, /Database Type: postgres/);
  assert.match(prompt, /Database Version: 15\.19/);
  assert.match(prompt, /Plan Mode: Estimated Plan/);
  assert.match(prompt, /## SQL/);
  assert.match(prompt, /SELECT \* FROM pd_fix_events;/);
  assert.match(prompt, /## Plan Summary/);
  assert.match(prompt, /Total Estimated Cost: 3,497/);
  assert.match(prompt, /Largest Estimated Rows: 200,000 \(node 0 · Seq Scan · pd_fix_events\)/);
  assert.match(prompt, /## Findings/);
  assert.match(prompt, /### \[high\] large-sequential-scan · node 0/);
  assert.match(prompt, /## Hotspots/);
  assert.match(prompt, /Estimated Self Cost: 3,497 PostgreSQL cost units/);
  assert.match(prompt, /Self Cost Share: 100\.0%/);
  assert.match(prompt, /- Human: .*自代价/);
  assert.match(prompt, /- Statement: /);
  assert.match(prompt, /## Evidence/);
  assert.match(prompt, /## 回答结构/);
  assert.match(prompt, /1\. 用通俗语言解释当前执行计划/);
});

test("Findings=0 is explained without claiming the SQL is fine", () => {
  assert.equal(pgNoFindingsAnalysis.findings.length, 0);
  assert.ok(pgNoFindingsAnalysis.hotspots.items.length > 0, "the fixture must still have a hotspot");

  const prompt = zh({ rawInput: pgNoFindings.input, analysis: pgNoFindingsAnalysis });

  assert.match(prompt, /当前没有规则触发。/);
  assert.match(prompt, /这并不代表 SQL 或执行计划一定没有问题。/);
  assert.equal(prompt.includes("SQL 没有性能问题"), false);
  assert.match(prompt, /### #1 \[high\]/);
});

test("Hotspots=0 keeps the empty-result caveat and adds no empty hotspot noise", () => {
  assert.equal(pgEmptyAnalysis.hotspots.items.length, 0);

  const prompt = zh({ rawInput: pgEmpty.input, analysis: pgEmptyAnalysis });

  assert.match(prompt, /当前没有达到阈值的 hotspot 节点。/);
  assert.match(prompt, /空结果不代表计划没有问题。/);
  assert.doesNotMatch(prompt, /### #1 \[/);
  assert.doesNotMatch(prompt, /- Reason \[/);
});

test("PostgreSQL cost withheld keeps the Core reason and publishes no cost share", () => {
  assert.equal(pgWithheldAnalysis.hotspots.cost.status, "withheld");

  const prompt = zh({ rawInput: pgWithheld.input, analysis: pgWithheldAnalysis });

  assert.match(prompt, /Cost attribution: .*InitPlan/);
  assert.doesNotMatch(prompt, /Self Cost Share:/);
  assert.doesNotMatch(prompt, /Estimated Self Cost:/);
});

test("MySQL cost uses MySQL labels inside its own query block", () => {
  const prompt = zh({ rawInput: mysql.input, analysis: mysqlAnalysis });

  assert.match(prompt, /Database Type: mysql/);
  assert.match(prompt, /Estimated Access Cost: .*read_cost \+ eval_cost/);
  assert.match(prompt, /Query Block Cost Share: /);
  assert.match(prompt, /- Human: .*全表扫描/);
  assert.doesNotMatch(prompt, /Estimated Self Cost/);
  assert.doesNotMatch(prompt, /Self Cost Share:/);
});

test("SQL Server never borrows PostgreSQL / MySQL cost attribution wording", () => {
  const prompt = zh({ rawInput: sqlserver.input, analysis: sqlserverAnalysis });
  const sortPrompt = zh({ rawInput: sqlserverSort.input, analysis: sqlserverSortAnalysis });

  assert.match(prompt, /Database Type: sqlserver/);
  assert.match(prompt, /Cost attribution: .*EstimatedTotalSubtreeCost/);
  assert.doesNotMatch(prompt, /Estimated Self Cost/);
  assert.doesNotMatch(prompt, /Estimated Access Cost/);
  assert.doesNotMatch(prompt, /Self Cost Share:/);
  assert.doesNotMatch(prompt, /Query Block Cost Share:/);
  assert.match(prompt, /正在进行全表扫描/);
  assert.match(sortPrompt, /SQL Server 预计对约 120,000 行执行排序。/);
});

test("missing metrics are omitted as whole lines, never printed as noise", () => {
  const metrics = {
    ...mysqlAnalysis.metrics,
    totalEstimatedCost: null,
    rootEstimatedRows: undefined,
    largestEstimatedRows: null,
  };
  const prompt = zh({ rawInput: mysql.input, analysis: { ...mysqlAnalysis, metrics } });

  assert.doesNotMatch(prompt, /Total Estimated Cost:/);
  assert.doesNotMatch(prompt, /Root Estimated Rows:/);
  assert.doesNotMatch(prompt, /Largest Estimated Rows:/);
  assert.match(prompt, /Node Count: /);
});

test("missing SQL and databaseVersion collapse to explicit absence, not null fields", () => {
  const prompt = zh({ rawInput: mysql.input, analysis: mysqlAnalysis });

  assert.match(prompt, /（未提供 SQL 原文）/);
  assert.doesNotMatch(prompt, /Database Version:/);
});

test("the prompt never leaks undefined / null / [object Object]", () => {
  const cases = [
    [pg.input, pgAnalysis],
    [mysql.input, mysqlAnalysis],
    [sqlserver.input, sqlserverAnalysis],
    [pgEmpty.input, pgEmptyAnalysis],
  ];

  for (const [rawInput, analysis] of cases) {
    const prompt = buildAiAnalysisPrompt({ rawInput, analysis, locale: "zh-CN" });
    assert.doesNotMatch(prompt, /\bundefined\b/);
    assert.doesNotMatch(prompt, /\bnull\b/);
    assert.doesNotMatch(prompt, /\[object Object\]/);
  }
});

test("evidence is bounded, ordered by attention and truncation is explicit", () => {
  const small = buildAiAnalysisPrompt({ rawInput: pg.input, analysis: pgAnalysis, locale: "zh-CN", maxEvidenceChars: 60 });
  assert.match(small, /部分 Evidence 因长度限制已截断。/);

  const full = buildAiAnalysisPrompt({
    rawInput: pg.input,
    analysis: pgAnalysis,
    locale: "zh-CN",
    maxEvidenceChars: DEFAULT_EVIDENCE_BUDGET_CHARS,
  });
  assert.doesNotMatch(full, /部分 Evidence 因长度限制已截断。/);

  const evidenceSection = small.split("## Evidence")[1];
  assert.ok(evidenceSection.includes("### Hotspot 0 [high]"), "high hotspot evidence has the highest priority");
  assert.equal(evidenceSection.includes("### Finding"), false, "findings come after hotspot evidence and are cut first");

  const medium = buildAiAnalysisPrompt({ rawInput: pg.input, analysis: pgAnalysis, locale: "zh-CN", maxEvidenceChars: 700 });
  const mediumEvidence = medium.split("## Evidence")[1];
  assert.ok(mediumEvidence.indexOf("### Hotspot") !== -1);
  assert.ok(mediumEvidence.indexOf("### Finding") !== -1);
  assert.ok(
    mediumEvidence.indexOf("### Hotspot") < mediumEvidence.indexOf("### Finding"),
    "hotspot evidence must be ordered before finding evidence",
  );

  const again = buildAiAnalysisPrompt({ rawInput: pg.input, analysis: pgAnalysis, locale: "zh-CN", maxEvidenceChars: 60 });
  assert.equal(small, again, "truncation is deterministic");
  assert.equal(full, buildAiAnalysisPrompt({ rawInput: pg.input, analysis: pgAnalysis, locale: "zh-CN" }), "default budget is stable");
});

test("English locale localizes the constraints and the answer structure", () => {
  const prompt = buildAiAnalysisPrompt({ rawInput: pg.input, analysis: pgAnalysis, locale: "en" });

  assert.match(prompt, /This data comes from an Estimated Plan, not from an actual execution\./);
  assert.match(prompt, /## Answer structure/);
  assert.match(prompt, /1\. Explain the current execution plan in plain language/);
  assert.match(prompt, /The sequential scan on `pd_fix_events` is estimated to return about 200,000 rows\./);
  assert.match(prompt, /### \[high\] large-sequential-scan · node 0/);
});

test("an analysis-free context still emits the constraints and empty-state semantics", () => {
  const prompt = buildAiAnalysisPrompt({
    rawInput: { database: "postgresql", mode: "estimated", format: "json" },
    analysis: null,
    locale: "zh-CN",
  });

  assert.match(prompt, /当前数据来自 Estimated Plan，不是实际运行结果。/);
  assert.match(prompt, /当前没有规则触发。/);
  assert.match(prompt, /当前没有达到阈值的 hotspot 节点。/);
  assert.doesNotMatch(prompt, /undefined/);
});

test("the prompt never includes the raw plan payload", () => {
  const prompt = zh({ rawInput: pg.input, analysis: pgAnalysis });

  // The fixture plan is an EXPLAIN JSON envelope; the full payload must stay out.
  assert.equal(prompt.includes('"Plan":'), false);
  assert.equal(prompt.includes('"Node Type"'), false);
  assert.match(prompt, /完整 Raw Plan 未包含在 Prompt 中/);
});
