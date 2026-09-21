import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { presentFinding } from "../../src/lib/finding-presentation.js";
import { loadFixture } from "../helpers/fixtures.js";

const fixture = await loadFixture({ database: "mysql", mode: "estimated", name: "large-table-scan.synthetic" });
const analysis = analyzePlan(fixture.input);
const finding = analysis.findings.find((entry) => entry.ruleId === "large-sequential-scan");
const postgresFixture = await loadFixture({ mode: "estimated", name: "large-seq-scan" });
const postgresFinding = analyzePlan(postgresFixture.input).findings.find((entry) => entry.ruleId === "large-sequential-scan");

assert.ok(finding, "the Golden Sample must produce the large-sequential-scan finding");

test("structured Finding facts preserve detection output without localized sentences", () => {
  assert.deepEqual(finding.facts, {
    database: "mysql",
    mode: "estimated",
    runtimeVerified: false,
    nodeType: "Table Scan",
    relation: "events",
    estimatedRows: 240_000,
    estimatedTotalCost: null,
    incrementalCost: null,
    accessType: "ALL",
    hasFilter: false,
  });
  assert.equal(finding.severity, "high", "severity contract remains the rule result");
});

test("large-sequential-scan presents the same facts in zh-CN", () => {
  const presentation = presentFinding(finding, "zh-CN");

  assert.equal(presentation.structured, true);
  assert.equal(presentation.locale, "zh-CN");
  assert.equal(presentation.title, "可能存在较大的全表扫描");
  assert.equal(presentation.summary, "events 预计扫描约 240,000 行。");
  assert.deepEqual(presentation.reasons, [
    "MySQL 使用了全表访问（access_type = ALL）。",
    "当前计划没有报告过滤条件。",
    "预计读取约 240,000 行。",
  ]);
  assert.deepEqual(presentation.actions, [
    "检查 SQL 是否应该包含 WHERE 条件。",
    "检查过滤字段是否存在合适的索引。",
    "确认查询是否本来就需要读取整张表。",
  ]);
  assert.deepEqual(presentation.caveats, [
    "当前结果来自 Estimated Plan，不代表 SQL 实际执行一定很慢。",
    "high 表示规则关注级别，不代表已确认存在严重性能问题。",
  ]);
  assert.deepEqual(presentation.labels, {
    summary: "发生了什么",
    reasons: "为什么提示",
    actions: "建议检查",
    caveats: "注意事项",
    technicalDetails: "技术细节",
  });
});

test("PostgreSQL keeps sequential-scan wording instead of claiming MySQL full-table access", () => {
  const presentation = presentFinding(postgresFinding, "zh-CN");

  assert.equal(presentation.title, "可能存在较大的顺序扫描");
  assert.equal(presentation.reasons[0], "执行计划使用了顺序扫描（Seq Scan）。");
  assert.equal(presentation.reasons.some((reason) => reason.includes("access_type")), false);
});

test("the same Finding facts present in en without copying detection logic", () => {
  const english = presentFinding(finding, "en");
  const chinese = presentFinding(finding, "zh-CN");

  assert.deepEqual(finding.facts, analysis.findings.find((entry) => entry.id === finding.id).facts);
  assert.equal(english.structured, true);
  assert.equal(english.locale, "en");
  assert.equal(english.title, "A potentially large full-table scan");
  assert.equal(english.summary, "events is estimated to scan about 240,000 rows.");
  assert.deepEqual(english.reasons, [
    "MySQL used full-table access (access_type = ALL).",
    "The plan did not report a filter condition.",
    "The plan estimates that about 240,000 rows will be read.",
  ]);
  assert.deepEqual(english.actions, [
    "Check whether the SQL should include a WHERE condition.",
    "Check whether the filter columns have suitable indexes.",
    "Confirm whether the query is expected to read the whole table.",
  ]);
  assert.deepEqual(english.caveats, [
    "This result comes from an Estimated Plan; it does not mean the SQL is definitely slow at runtime.",
    "high is the rule's attention level; it does not confirm a severe SQL performance problem.",
  ]);
  assert.notEqual(english.summary, chinese.summary);
});

test("legacy findings fall back without requiring structured presentation", () => {
  const legacy = {
    id: "legacy:0",
    ruleId: "future-rule",
    severity: "warning",
    title: "Legacy title",
    summary: "Legacy description",
    nodeRef: "0",
    evidence: { nodeId: "0" },
  };

  assert.deepEqual(presentFinding(legacy, "en"), {
    structured: false,
    locale: "en",
    title: "Legacy title",
    summary: "Legacy description",
    reasons: [],
    actions: [],
    caveats: [],
    labels: {
      summary: "What happened",
      reasons: "Why this was flagged",
      actions: "What to check next",
      caveats: "Caveats",
      technicalDetails: "Technical details",
    },
  });
});
