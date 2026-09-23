import assert from "node:assert/strict";
import test from "node:test";
import { presentHotspot, presentHotspotCostNote, presentHotspotReason } from "../../src/lib/hotspot-presentation.js";

/**
 * Hotspot presentation is a pure facts -> wording layer. These tests pin the
 * engine-aware wording for every current reason code, the graceful fallback for
 * a reason code the presenter does not know yet, and the cost-note semantics
 * (PostgreSQL / MySQL cost signals, SQL Server `not-applicable`).
 */

/** MySQL unique index lookup with cost concentration (the #42 example). */
const MYSQL_COST_HOTSPOT = Object.freeze({
  id: "hotspot:0.0",
  nodeId: "0.0",
  nodeType: "Index Lookup",
  kind: "index_scan",
  relation: "g",
  level: "high",
  reasons: [
    {
      code: "mysql-cost-concentration",
      level: "high",
      statement:
        "Index Lookup on g accounts for 77.74% of its query block's estimated MySQL cost " +
        "(read_cost + eval_cost = 100 of 128.63).",
      source: "table.cost_info.read_cost + eval_cost / query_block.cost_info.query_cost",
      evidence: { readCost: 80, evalCost: 20, accessCost: 100, queryCost: 128.63, costShare: 0.7774, blockNodeRef: "0" },
    },
  ],
  evidence: { nodeId: "0.0", nodeType: "Index Lookup", kind: "index_scan", relation: "g", accessCost: 100, costShare: 0.7774 },
  estimateOnly: true,
});

/** MySQL index lookup that examines many rows without a full table scan. */
const MYSQL_ROWS_REASON = Object.freeze({
  code: "mysql-rows-examined",
  level: "warning",
  statement:
    "Index Lookup on b is estimated to examine 48891 rows per scan without a full table scan " + "(access_type = ref).",
  source: "table.rows_examined_per_scan",
  evidence: { rowsExaminedPerScan: 48891, accessType: "ref", thresholds: { warningRowsExamined: 10_000, highRowsExamined: 100_000 } },
});

test("MySQL unique index lookup + cost concentration becomes a human sentence", () => {
  const presentation = presentHotspot(MYSQL_COST_HOTSPOT, "zh-CN", {
    relation: "g",
    alias: "g",
    indexName: "PRIMARY",
    nodeType: "Index Lookup",
    kind: "index_scan",
  });

  assert.equal(presentation.structured, true);
  assert.equal(presentation.locale, "zh-CN");
  assert.match(presentation.reasons[0].summary, /主键/);
  assert.match(presentation.reasons[0].summary, /PRIMARY/);
  assert.match(presentation.reasons[0].summary, /77\.7%/);
  assert.match(presentation.reasons[0].summary, /当前查询块/);
  assert.equal(presentation.summary, presentation.reasons[0].summary);
  // The original Core statement is never rewritten or hidden by the presenter.
  assert.equal(MYSQL_COST_HOTSPOT.reasons[0].statement.includes("77.74%"), true);
});

test("MySQL index lookup + rows examined explains the access and adds a restrained caveat", () => {
  const presented = presentHotspotReason(MYSQL_ROWS_REASON, "zh-CN", { relation: "b", alias: "b", indexName: "idx_status" });

  assert.equal(presented.structured, true);
  assert.match(presented.summary, /idx_status/);
  assert.match(presented.summary, /48,891/);
  assert.match(presented.caveat, /不是全表扫描/);
  assert.match(presented.caveat, /过滤选择性/);
});

test("PostgreSQL reasons use PostgreSQL wording, never MySQL access wording", () => {
  const cost = presentHotspotReason(
    { code: "cost-concentration", level: "high", source: "Total Cost", evidence: { selfCost: 2633.4, selfCostShare: 0.753 } },
    "zh-CN",
    { relation: "pd_fix_events", nodeType: "Seq Scan" },
  );
  const scan = presentHotspotReason(
    { code: "large-sequential-scan", level: "warning", source: "Plan Rows", evidence: { estimatedRows: 200_000 } },
    "zh-CN",
    { relation: "pd_fix_events", nodeType: "Seq Scan" },
  );

  assert.match(cost.summary, /自代价/);
  assert.match(cost.summary, /75\.3%/);
  assert.match(scan.summary, /顺序扫描/);
  assert.match(scan.summary, /200,000/);
  assert.equal(scan.summary.includes("全表扫描"), false);
  assert.equal(cost.summary.includes("MySQL"), false);
});

test("SQL Server keeps its own operator wording and never borrows another engine's cost semantics", () => {
  const indexScan = presentHotspotReason(
    {
      code: "sqlserver-large-index-scan",
      level: "high",
      source: "RelOp@EstimateRows",
      evidence: { physicalOp: "Index Scan", estimatedRows: 150_000 },
    },
    "zh-CN",
    { relation: "[Orders]", nodeType: "Index Scan" },
  );
  const sort = presentHotspotReason(
    { code: "sqlserver-sort", level: "high", source: "RelOp@EstimateRows", evidence: { estimatedRows: 120_000 } },
    "zh-CN",
    { relation: "[Orders]", nodeType: "Sort" },
  );

  assert.match(indexScan.summary, /完整索引扫描/);
  assert.match(indexScan.summary, /Index Scan/);
  assert.match(indexScan.summary, /150,000/);
  assert.match(sort.summary, /排序/);
  assert.match(sort.summary, /120,000/);
  assert.equal(indexScan.summary.includes("PostgreSQL"), false);
  assert.equal(indexScan.summary.includes("MySQL"), false);
});

test("nested-loop amplification and MySQL filtered signals explain the numbers", () => {
  const amplification = presentHotspotReason(
    {
      code: "nested-loop-amplification",
      level: "warning",
      source: "Plan Rows",
      evidence: { outerEstimatedRows: 1_000, innerEstimatedRows: 50_000, estimatedRowComparisons: 50_000_000 },
    },
    "zh-CN",
  );
  const filtered = presentHotspotReason(
    {
      code: "mysql-filtered-out",
      level: "warning",
      source: "table.filtered",
      evidence: { filteredPercent: 1.5, rowsExaminedPerScan: 240_000, accessType: "ALL" },
    },
    "zh-CN",
  );

  assert.match(amplification.summary, /1,000/);
  assert.match(amplification.summary, /50,000/);
  assert.match(amplification.summary, /50,000,000/);
  assert.match(filtered.summary, /240,000/);
  assert.match(filtered.summary, /1\.5%/);
});

test("a MySQL full table scan is never described as index access", () => {
  const reason = {
    code: "mysql-cost-concentration",
    level: "high",
    source: "table.cost_info.read_cost + eval_cost / query_block.cost_info.query_cost",
    evidence: { accessCost: 10_000, queryCost: 10_500, costShare: 0.9524 },
  };
  const presented = presentHotspotReason(reason, "zh-CN", { relation: "events", accessType: "ALL" });

  assert.match(presented.summary, /全表扫描/);
  assert.equal(presented.summary.includes("索引"), false);

  const en = presentHotspotReason(reason, "en", { relation: "events", accessType: "ALL" });
  assert.match(en.summary, /full table scan/);
});

test("MySQL reasons use the plan-reported access type when no index is named", () => {
  const rowsReason = {
    code: "mysql-rows-examined",
    level: "warning",
    source: "table.rows_examined_per_scan",
    evidence: { rowsExaminedPerScan: 12_000, accessType: "range" },
  };
  const presented = presentHotspotReason(rowsReason, "zh-CN", { relation: "orders" });

  assert.match(presented.summary, /access_type = `range`/);
  assert.match(presented.summary, /12,000/);
});

test("an unknown reason code degrades to the Core statement instead of hiding the hotspot", () => {
  const hotspot = {
    id: "hotspot:0",
    nodeId: "0",
    nodeType: "Seq Scan",
    kind: "seq_scan",
    relation: "t",
    level: "warning",
    reasons: [{ code: "future-signal", level: "warning", statement: "A future signal fired.", source: "Future Field", evidence: {} }],
    evidence: { nodeId: "0" },
    estimateOnly: true,
  };

  const presentation = presentHotspot(hotspot, "zh-CN");
  assert.equal(presentation.structured, false);
  assert.equal(presentation.summary, null);
  assert.equal(presentation.reasons[0].structured, false);
  assert.equal(presentation.reasons[0].summary, null);

  const presented = presentHotspotReason(hotspot.reasons[0], "zh-CN");
  assert.equal(presented.summary, null);
  assert.equal(presented.caveat, null);

  assert.equal(presentHotspot(null, "zh-CN").structured, false);
  assert.deepEqual(presentHotspot(null, "zh-CN").reasons, []);
});

test("English presentation mirrors the Chinese facts with English wording", () => {
  const zh = presentHotspot(MYSQL_COST_HOTSPOT, "zh-CN", { relation: "g", indexName: "PRIMARY" });
  const en = presentHotspot(MYSQL_COST_HOTSPOT, "en", { relation: "g", indexName: "PRIMARY" });

  assert.equal(en.locale, "en");
  assert.match(en.reasons[0].summary, /primary key/);
  assert.match(en.reasons[0].summary, /77\.7%/);
  assert.match(en.reasons[0].summary, /query block/);
  assert.notEqual(en.reasons[0].summary, zh.reasons[0].summary);
});

test("cost notes keep the Core status and never invent a cost attribution", () => {
  assert.equal(presentHotspotCostNote({ status: "available", reason: null }, "zh-CN"), null);

  assert.match(presentHotspotCostNote({ status: "withheld", reason: "PLAN_CONTAINS_SUBPLAN" }, "zh-CN"), /InitPlan/);
  assert.match(presentHotspotCostNote({ status: "withheld", reason: "NO_QUERY_COST" }, "zh-CN"), /query_cost/);
  assert.match(presentHotspotCostNote({ status: "withheld", reason: "MISSING_NODE_COST" }, "zh-CN"), /Total Cost/);
  assert.match(
    presentHotspotCostNote({ status: "not-applicable", reason: "NOT_POSTGRES_COST_MODEL" }, "zh-CN"),
    /EstimatedTotalSubtreeCost/,
  );
  assert.match(presentHotspotCostNote({ status: "withheld", reason: "FUTURE_REASON" }, "zh-CN"), /行数信号/);
  assert.match(presentHotspotCostNote({ status: "not-applicable", reason: "FUTURE_REASON" }, "zh-CN"), /行数信号/);

  const en = presentHotspotCostNote({ status: "not-applicable", reason: "NOT_POSTGRES_COST_MODEL" }, "en");
  assert.match(en, /SQL Server/);
  assert.match(en, /EstimatedTotalSubtreeCost/);

  const oceanBaseMysql = presentHotspotCostNote(
    { engine: "oceanbase-mysql", status: "not-applicable", reason: "NOT_POSTGRES_COST_MODEL" },
    "zh-CN",
  );
  assert.match(oceanBaseMysql, /OceanBase MySQL/);
  assert.match(oceanBaseMysql, /EST\.ROWS/);
  assert.doesNotMatch(oceanBaseMysql, /SQL Server/);

  const oceanBaseMysqlEnglish = presentHotspotCostNote(
    { engine: "oceanbase-mysql", status: "not-applicable", reason: "NOT_POSTGRES_COST_MODEL" },
    "en",
  );
  assert.match(oceanBaseMysqlEnglish, /OceanBase MySQL compatibility mode/);
  assert.match(oceanBaseMysqlEnglish, /EST\.ROWS/);
  assert.doesNotMatch(oceanBaseMysqlEnglish, /SQL Server/);
});
