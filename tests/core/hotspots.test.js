import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { computeHotspots } from "../../src/core/hotspots/compute-hotspots.js";
import { analyzePostgresCost, selfCostOf } from "../../src/core/cost/postgres-cost.js";
import { HOTSPOT } from "../../src/core/hotspots/thresholds.js";
import { computeMetrics } from "../../src/core/metrics/compute-metrics.js";
import { analyzeRawPlan } from "../../src/core/parsers/index.js";
import { runRules } from "../../src/core/rules/index.js";
import { normalizedNode, normalizedPlan } from "../helpers/plan-builders.js";

/**
 * Hotspot analysis is a deterministic, engine-aware layer over the normalized
 * plan. These tests pin the contract, the PostgreSQL attribution envelope and
 * the MySQL cost/row signals; fixture-level behavior lives in
 * tests/postgres/hotspot-fixtures.test.js and tests/mysql/hotspot-fixtures.test.js.
 */

/** A PostgreSQL child node with a cumulative child relationship. */
function pgChild(overrides = {}) {
  return normalizedNode({ engineSpecific: { database: "postgresql", parentRelationship: "Outer" }, ...overrides });
}

/** A MySQL node carrying engine-specific fields. */
function mysqlNode(mysql, overrides = {}) {
  return normalizedNode({ engineSpecific: { database: "mysql", mysql }, ...overrides });
}

/** @param {any} root */
function run(root, database = "postgresql") {
  const plan = normalizedPlan({ database, root });
  return computeHotspots(plan, computeMetrics(plan));
}

/* ----------------------------------------------------------------- contract -- */

test("HotspotAnalysis has a stable shape and every hotspot explains itself", () => {
  const analysis = run(
    pgChild({ kind: "seq_scan", nodeType: "Seq Scan", relation: null, totalCost: 5_000, estimatedRows: 200_000 }),
  );

  assert.deepEqual(Object.keys(analysis).sort(), ["cost", "items"]);
  assert.deepEqual(analysis.cost, { engine: "postgresql", status: "available", reason: null });

  assert.equal(analysis.items.length, 1);
  const [hotspot] = analysis.items;
  assert.deepEqual(Object.keys(hotspot).sort(), [
    "estimateOnly",
    "evidence",
    "id",
    "kind",
    "level",
    "nodeId",
    "nodeType",
    "reasons",
    "relation",
  ]);
  assert.equal(hotspot.id, "hotspot:0");
  assert.equal(hotspot.level, "high");
  assert.equal(hotspot.estimateOnly, true);
  assert.deepEqual(
    hotspot.reasons.map((reason) => reason.code),
    ["cost-concentration", "large-sequential-scan"],
  );
  for (const reason of hotspot.reasons) {
    assert.deepEqual(Object.keys(reason).sort(), ["code", "evidence", "level", "source", "statement"]);
    assert.equal(typeof reason.statement, "string");
    assert.ok(reason.statement.length > 0);
    assert.equal(reason.source.length > 0, true);
    assert.equal(typeof reason.evidence, "object");
  }
  // The reason list is strongest-first.
  assert.equal(hotspot.reasons[0].level, "high");
});

test("the analysis is JSON-serializable and does not mutate its inputs", () => {
  const root = pgChild({
    kind: "nested_loop",
    nodeType: "Nested Loop",
    totalCost: 1_000_000,
    estimatedRows: 10,
    children: [
      pgChild({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 4, estimatedRows: 100 }),
      pgChild({ id: "0.1", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 9_000, estimatedRows: 90_000 }),
    ],
  });
  const plan = normalizedPlan({ root });
  const metrics = computeMetrics(plan);
  const planSnapshot = structuredClone(plan);
  const metricsSnapshot = structuredClone(metrics);

  const first = computeHotspots(plan, metrics);
  const second = computeHotspots(plan, metrics);

  assert.deepEqual(first, second, "two runs over the same input must be identical");
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first, "hotspot output must survive a JSON round-trip");
  assert.deepEqual(plan, planSnapshot, "the normalized plan must stay untouched");
  assert.deepEqual(metrics, metricsSnapshot, "the metrics must stay untouched");
});

test("hotspot analysis does not change rule findings", () => {
  const root = pgChild({
    kind: "seq_scan",
    nodeType: "Seq Scan",
    totalCost: 3_497,
    estimatedRows: 200_000,
    relation: { name: "pd_fix_events", alias: null, indexName: null },
  });
  const plan = normalizedPlan({ root });
  const metrics = computeMetrics(plan);

  const findingsBefore = runRules(plan, metrics);
  computeHotspots(plan, metrics);
  const findingsAfter = runRules(plan, metrics);

  assert.deepEqual(findingsAfter, findingsBefore);

  const analysis = analyzePlan({
    database: "postgresql",
    mode: "estimated",
    format: "json",
    plan: [{ Plan: { "Node Type": "Seq Scan", "Total Cost": 3_497, "Plan Rows": 200_000 } }],
  });
  assert.deepEqual(analysis.findings, runRules(analysis.normalized, analysis.metrics));
});

/* ------------------------------------------------- PostgreSQL cost signals -- */

test("cost-concentration uses the own cost share of the root total", () => {
  const plan = normalizedPlan({
    root: pgChild({
      kind: "result",
      nodeType: "Result",
      totalCost: 400,
      children: [pgChild({ id: "0.0", kind: "index_scan", nodeType: "Index Scan", totalCost: 100 })],
    }),
  });

  const [hotspot] = computeHotspots(plan, computeMetrics(plan)).items;
  assert.equal(hotspot.nodeId, "0");
  assert.equal(hotspot.reasons[0].code, "cost-concentration");
  assert.equal(hotspot.reasons[0].level, "high");
  assert.equal(hotspot.reasons[0].evidence.selfCost, 300);
  assert.equal(hotspot.reasons[0].evidence.selfCostShare, 0.75);
  assert.equal(hotspot.evidence.selfCost, 300);
  assert.equal(hotspot.evidence.selfCostShare, 0.75);
});

test("cost-concentration respects the warning share and the minimum own cost", () => {
  const boundary = run(
    pgChild({
      kind: "result",
      nodeType: "Result",
      totalCost: 400,
      children: [pgChild({ id: "0.0", kind: "index_scan", nodeType: "Index Scan", totalCost: 300 })],
    }),
  );
  const byNode = new Map(boundary.items.map((hotspot) => [hotspot.nodeId, hotspot]));
  assert.equal(byNode.get("0").level, "warning", "exactly at the warning share");
  assert.equal(byNode.get("0").reasons[0].evidence.selfCostShare, 0.25);
  assert.equal(byNode.get("0.0").level, "high", "the child carries the remaining 75% of the plan");

  // Five children of 200 in a 1000 plan: every share is 20%, below the warning
  // share, and the root's own cost is 0.
  const belowShare = run(
    pgChild({
      kind: "result",
      nodeType: "Result",
      totalCost: 1_000,
      children: [0, 1, 2, 3, 4].map((index) =>
        pgChild({ id: `0.${index}`, kind: "index_scan", nodeType: "Index Scan", totalCost: 200 }),
      ),
    }),
  );
  assert.deepEqual(belowShare.items, [], "a 20% share stays below the warning share");

  // The root's own 50 cost is above 0 but below the absolute floor; only the
  // child reaches a share worth reporting.
  const belowFloor = run(
    pgChild({
      kind: "result",
      nodeType: "Result",
      totalCost: 200,
      children: [pgChild({ id: "0.0", kind: "index_scan", nodeType: "Index Scan", totalCost: 150 })],
    }),
  );
  assert.deepEqual(belowFloor.items.map((hotspot) => hotspot.nodeId), ["0.0"]);
  assert.equal(HOTSPOT.postgresCost.minSelfCost, 100);
});

test("PostgreSQL cost attribution is withheld when the plan cannot be verified", () => {
  const noPlanCost = run(pgChild({ kind: "result", nodeType: "Result", totalCost: null, estimatedRows: 1 }));
  assert.deepEqual(noPlanCost.cost, { engine: "postgresql", status: "withheld", reason: "NO_PLAN_COST" });

  const missingChildCost = run(
    pgChild({
      kind: "result",
      nodeType: "Result",
      totalCost: 400,
      children: [pgChild({ id: "0.0", kind: "index_scan", nodeType: "Index Scan", totalCost: null })],
    }),
  );
  assert.equal(missingChildCost.cost.reason, "MISSING_NODE_COST");
  assert.deepEqual(missingChildCost.items, []);

  const subplan = run(
    pgChild({
      kind: "result",
      nodeType: "Result",
      totalCost: 7_494.01,
      children: [
        normalizedNode({
          id: "0.0",
          kind: "aggregate",
          nodeType: "Aggregate",
          totalCost: 3_997.01,
          engineSpecific: { database: "postgresql", parentRelationship: "InitPlan" },
        }),
        pgChild({ id: "0.1", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 3_497, estimatedRows: 1 }),
      ],
    }),
  );
  assert.deepEqual(subplan.cost, { engine: "postgresql", status: "withheld", reason: "PLAN_CONTAINS_SUBPLAN" });
  assert.deepEqual(subplan.items, []);

  const unverified = run(
    pgChild({
      kind: "result",
      nodeType: "Result",
      totalCost: 400,
      children: [normalizedNode({ id: "0.0", kind: "index_scan", nodeType: "Index Scan", totalCost: 100 })],
    }),
  );
  assert.equal(unverified.cost.reason, "UNVERIFIED_COST_FLOW");
});

test("a truncating node (Limit) withholds its own cost and its descendants, not its ancestors", () => {
  const limit = pgChild({
    id: "0.1",
    kind: "limit",
    nodeType: "Limit",
    totalCost: 8.03,
    engineSpecific: { database: "postgresql", parentRelationship: "Inner" },
    children: [pgChild({ id: "0.1.0", kind: "index_scan", nodeType: "Index Scan", totalCost: 155.28 })],
  });
  const root = normalizedNode({
    kind: "nested_loop",
    nodeType: "Nested Loop",
    totalCost: 165.5,
    engineSpecific: { database: "postgresql" },
    children: [pgChild({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 4.5 }), limit],
  });
  const plan = normalizedPlan({ root });

  assert.equal(selfCostOf(limit), -147.25, "the documented PostgreSQL truncation counterexample");

  const attribution = analyzePostgresCost(root, 165.5);
  assert.equal(attribution.status, "available");
  assert.equal(attribution.byNodeId.has("0"), true, "the nested loop's own cost is still attributable");
  assert.equal(attribution.byNodeId.get("0").selfCost, 152.97);
  assert.equal(attribution.byNodeId.has("0.1"), false, "a negative own cost is not attributable");
  assert.equal(attribution.byNodeId.has("0.1.0"), false, "nodes below a truncating node are out of scope");

  const hotspots = computeHotspots(plan, computeMetrics(plan)).items;
  assert.deepEqual(hotspots.map((hotspot) => hotspot.nodeId), ["0"]);
});

test("PostgreSQL self cost refuses to guess a missing child cost", () => {
  assert.equal(
    selfCostOf({ totalCost: 100, children: [{ totalCost: 40 }, { totalCost: null }] }),
    null,
    "unlike incrementalCostOf, a missing child cost is not treated as 0",
  );
  assert.equal(selfCostOf({ totalCost: null, children: [] }), null);
});

/* ------------------------------------------------------- engine-neutral rows -- */

test("large sequential scans are flagged from estimated rows when no cost is reported", () => {
  const analysis = run(pgChild({ kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 200_000, totalCost: null }));

  assert.deepEqual(analysis.cost, { engine: "postgresql", status: "withheld", reason: "NO_PLAN_COST" });
  assert.equal(analysis.items.length, 1);
  const [hotspot] = analysis.items;
  assert.equal(hotspot.reasons.length, 1);
  assert.equal(hotspot.reasons[0].code, "large-sequential-scan");
  assert.equal(hotspot.reasons[0].level, "high");
  assert.equal(hotspot.reasons[0].source, "Plan Rows");
  assert.equal(hotspot.evidence.estimatedRows, 200_000);
  assert.equal("estimatedTotalCost" in hotspot.evidence, false, "an unavailable cost is omitted, not zero-filled");
});

test("nested loop amplification uses estimated row multiplication", () => {
  const analysis = run(
    pgChild({
      kind: "nested_loop",
      nodeType: "Nested Loop",
      totalCost: null,
      children: [
        pgChild({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 1_000 }),
        pgChild({ id: "0.1", kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 100_000 }),
      ],
    }),
  );

  const [hotspot] = analysis.items;
  assert.equal(hotspot.nodeId, "0");
  const [reason] = hotspot.reasons;
  assert.equal(reason.code, "nested-loop-amplification");
  assert.equal(reason.level, "high");
  assert.equal(reason.evidence.outerEstimatedRows, 1_000);
  assert.equal(reason.evidence.innerEstimatedRows, 100_000);
  assert.equal(reason.evidence.estimatedRowComparisons, 100_000_000);
});

/* ------------------------------------------------------------- MySQL signals -- */

test("MySQL hotspots never use PostgreSQL cost semantics", () => {
  const root = mysqlNode(
    { queryCost: 1_000 },
    {
      kind: "query_block",
      nodeType: "Query Block",
      children: [
        mysqlNode({ accessType: "ALL", rowsExaminedPerScan: 240_000, rowsProducedPerJoin: 240_000 }, {
          id: "0.0",
          kind: "seq_scan",
          nodeType: "Table Scan",
          relation: { name: "events", alias: null, indexName: null },
          estimatedRows: 240_000,
        }),
      ],
    },
  );

  const analysis = run(root, "mysql");
  assert.deepEqual(analysis.cost, { engine: "mysql", status: "available", reason: null });
  const codes = analysis.items.flatMap((hotspot) => hotspot.reasons.map((reason) => reason.code));
  assert.deepEqual(codes, ["large-sequential-scan"]);
  assert.equal(codes.includes("cost-concentration"), false, "the PostgreSQL cost code must never appear for MySQL");
  assert.equal(codes.includes("mysql-cost-concentration"), false, "a single costed access has no discriminating share");
  assert.equal("estimatedTotalCost" in analysis.items[0].evidence, false);
});

test("MySQL cost concentration compares read_cost + eval_cost with the query block's query_cost", () => {
  const root = mysqlNode(
    { queryCost: 1_000 },
    {
      kind: "query_block",
      nodeType: "Query Block",
      children: [
        mysqlNode(
          { structure: "table", accessType: "ALL", readCost: 700, evalCost: 100, prefixCost: 800, rowsExaminedPerScan: 10_000, rowsProducedPerJoin: 10_000 },
          { id: "0.0", kind: "seq_scan", nodeType: "Table Scan", relation: { name: "orders", alias: null, indexName: null }, estimatedRows: 10_000 },
        ),
        mysqlNode(
          { structure: "table", accessType: "ref", readCost: 150, evalCost: 50, prefixCost: 1_000, rowsExaminedPerScan: 10, rowsProducedPerJoin: 10 },
          { id: "0.1", kind: "index_scan", nodeType: "Index Lookup", relation: { name: "customers", alias: null, indexName: null }, estimatedRows: 10 },
        ),
      ],
    },
  );

  const analysis = run(root, "mysql");
  const orders = analysis.items.find((hotspot) => hotspot.nodeId === "0.0");
  assert.equal(orders.level, "high");
  const [reason] = orders.reasons;
  assert.equal(reason.code, "mysql-cost-concentration");
  assert.equal(reason.evidence.accessCost, 800);
  assert.equal(reason.evidence.queryCost, 1_000);
  assert.equal(reason.evidence.costShare, 0.8);
  assert.equal(reason.evidence.blockNodeRef, "0");
  assert.equal(orders.evidence.costShare, 0.8);
});

test("MySQL operation costs are not treated as table accesses", () => {
  const root = mysqlNode(
    { queryCost: 1_000 },
    {
      kind: "query_block",
      nodeType: "Query Block",
      children: [
        mysqlNode(
          { structure: "ordering_operation", usingFilesort: true, readCost: 500 },
          {
            id: "0.0",
            kind: "sort",
            nodeType: "Ordering Operation",
            children: [
              mysqlNode(
                { structure: "table", accessType: "ALL", readCost: 400, evalCost: 100, rowsExaminedPerScan: 500 },
                { id: "0.0.0", kind: "seq_scan", nodeType: "Table Scan", estimatedRows: 500 },
              ),
            ],
          },
        ),
      ],
    },
  );

  // MySQL attributes a filesort cost to `ordering_operation.read_cost`. Counting
  // it as a second costed access would give the table a 50% share out of a
  // single-table block, which is not an access concentration.
  assert.deepEqual(run(root, "mysql").items, []);
});

test("MySQL rows-examined flags large index accesses but not full table scans", () => {
  const indexScan = mysqlNode(
    { accessType: "range", rowsExaminedPerScan: 500_000, filteredPercent: 100 },
    { kind: "index_scan", nodeType: "Index Range Scan", estimatedRows: 500_000 },
  );
  const [reason] = run(indexScan, "mysql").items[0].reasons;
  assert.equal(reason.code, "mysql-rows-examined");
  assert.equal(reason.level, "high");
  assert.equal(reason.source, "table.rows_examined_per_scan");
  assert.match(reason.statement, /access_type = range/);

  const tableScan = mysqlNode(
    { accessType: "ALL", rowsExaminedPerScan: 500_000 },
    { kind: "seq_scan", nodeType: "Table Scan", estimatedRows: 500_000 },
  );
  const codes = run(tableScan, "mysql").items[0].reasons.map((entry) => entry.code);
  assert.deepEqual(codes, ["large-sequential-scan"], "a full table scan is reported once, not twice");
});

test("MySQL filtered-out flags rows discarded by the access condition", () => {
  const node = mysqlNode(
    { accessType: "ALL", rowsExaminedPerScan: 200_000, filteredPercent: 0.5 },
    { kind: "seq_scan", nodeType: "Table Scan", estimatedRows: 200_000 },
  );
  const [reason] = run(node, "mysql").items[0].reasons.filter((entry) => entry.code === "mysql-filtered-out");
  assert.equal(reason.level, "high");
  assert.equal(reason.source, "table.filtered");
  assert.equal(reason.evidence.filteredPercent, 0.5);

  const small = mysqlNode(
    { accessType: "ALL", rowsExaminedPerScan: 500, filteredPercent: 1 },
    { kind: "seq_scan", nodeType: "Table Scan", estimatedRows: 500 },
  );
  assert.equal(run(small, "mysql").items.length, 0, "a small access is not a hotspot");
});

test("MySQL operation flags need a large subtree and carry the flag value", () => {
  const filesort = mysqlNode(
    { usingFilesort: true },
    {
      kind: "sort",
      nodeType: "Ordering Operation",
      children: [mysqlNode({ rowsExaminedPerScan: 50_000 }, { id: "0.0", kind: "seq_scan", nodeType: "Table Scan", estimatedRows: 50_000 })],
    },
  );
  const [sortReason] = run(filesort, "mysql").items[0].reasons;
  assert.equal(sortReason.code, "mysql-filesort");
  assert.equal(sortReason.level, "warning");
  assert.equal(sortReason.source, "ordering_operation.using_filesort");
  assert.equal(sortReason.evidence.subtreeMaxEstimatedRows, 50_000);

  const smallSort = mysqlNode(
    { usingFilesort: true },
    { kind: "sort", nodeType: "Ordering Operation", children: [mysqlNode({}, { id: "0.0", kind: "seq_scan", nodeType: "Table Scan", estimatedRows: 800 })] },
  );
  assert.deepEqual(run(smallSort, "mysql").items, [], "a filesort over 800 rows is not a hotspot");

  const temporary = mysqlNode(
    { usingTemporaryTable: true },
    { kind: "aggregate", nodeType: "Grouping Operation", children: [mysqlNode({}, { id: "0.0", kind: "index_scan", nodeType: "Index Range Scan", estimatedRows: 200_000 })] },
  );
  const [tempReason] = run(temporary, "mysql").items[0].reasons;
  assert.equal(tempReason.code, "mysql-temporary-table");
  assert.equal(tempReason.level, "high");

  const joinBuffer = mysqlNode(
    { usingJoinBuffer: "flat, hash join" },
    { kind: "nested_loop", nodeType: "Nested Loop", children: [mysqlNode({}, { id: "0.0", kind: "seq_scan", nodeType: "Table Scan", estimatedRows: 50_000 })] },
  );
  const [bufferReason] = run(joinBuffer, "mysql").items[0].reasons;
  assert.equal(bufferReason.code, "mysql-join-buffer");
  assert.equal(bufferReason.evidence.usingJoinBuffer, "flat, hash join");
  assert.match(bufferReason.statement, /using_join_buffer = flat, hash join/);
});

/** A SQL Server node carrying engine-specific fields. */
function sqlServerNode(sqlServer, overrides = {}) {
  return normalizedNode({ engineSpecific: { database: "sqlserver", sqlServer }, ...overrides });
}

/* --------------------------------------------------------- SQL Server signals -- */

test("SQL Server hotspots use rows only and never PostgreSQL cost semantics", () => {
  const root = sqlServerNode(
    { physicalOp: "Table Scan", logicalOp: "Table Scan", estimatedTotalSubtreeCost: 12.5 },
    {
      kind: "seq_scan",
      nodeType: "Table Scan",
      relation: { name: "Customers", alias: null, indexName: null },
      estimatedRows: 250_000,
    },
  );

  const analysis = run(root, "sqlserver");
  assert.deepEqual(analysis.cost, { engine: "sqlserver", status: "not-applicable", reason: "NOT_POSTGRES_COST_MODEL" });
  assert.equal(analysis.items.length, 1);
  assert.deepEqual(analysis.items[0].reasons.map((reason) => reason.code), ["large-sequential-scan"]);
  assert.equal(analysis.items[0].reasons[0].source, "RelOp@EstimateRows");

  const evidence = analysis.items[0].evidence;
  assert.equal(evidence.estimatedTotalSubtreeCost, 12.5, "the SQL Server subtree cost stays engine-specific evidence");
  assert.equal("estimatedTotalCost" in evidence, false, "PostgreSQL-only evidence must not appear");
  assert.equal("selfCost" in evidence, false);
  assert.equal("selfCostShare" in evidence, false);
});

test("a SQL Server large index scan is a physical-op signal, not a generic index_scan", () => {
  const scan = (physicalOp, estimatedRows) =>
    run(
      sqlServerNode({ physicalOp, logicalOp: physicalOp }, { kind: "index_scan", nodeType: physicalOp, estimatedRows }),
      "sqlserver",
    ).items.flatMap((hotspot) => hotspot.reasons.map((reason) => reason.code));

  assert.deepEqual(scan("Index Scan", 150_000), ["sqlserver-large-index-scan"]);
  assert.deepEqual(scan("Clustered Index Scan", 150_000), ["sqlserver-large-index-scan"]);
  assert.deepEqual(scan("Index Scan", 5_000), [], "below the row threshold nothing is signalled");
  assert.deepEqual(scan("Index Seek", 150_000), [], "a seek is not evidence of a problem");
  assert.deepEqual(scan("Clustered Index Seek", 150_000), [], "a clustered seek is not signalled either");
});

test("the SQL Server sort signal requires a row magnitude", () => {
  const sort = (estimatedRows) =>
    run(
      sqlServerNode({ physicalOp: "Sort", logicalOp: "Sort" }, { kind: "sort", nodeType: "Sort", estimatedRows, sortKeys: ["[o].OrderDate ASC"] }),
      "sqlserver",
    ).items.flatMap((hotspot) => hotspot.reasons.map((reason) => reason.code));

  assert.deepEqual(sort(120_000), ["sqlserver-sort"]);
  assert.deepEqual(sort(5_000), [], "a small sort is not automatically worth attention");
});

test("SQL Server nested loop amplification reads the two input estimates", () => {
  const root = sqlServerNode(
    { physicalOp: "Nested Loops", logicalOp: "Inner Join" },
    {
      kind: "nested_loop",
      nodeType: "Nested Loops",
      children: [
        sqlServerNode({ physicalOp: "Index Seek" }, { id: "0.0", kind: "index_scan", nodeType: "Index Seek", estimatedRows: 1_000 }),
        sqlServerNode({ physicalOp: "Clustered Index Seek" }, { id: "0.1", kind: "index_scan", nodeType: "Clustered Index Seek", estimatedRows: 50_000 }),
      ],
    },
  );

  const analysis = run(root, "sqlserver");
  assert.equal(analysis.items.length, 1);
  assert.deepEqual(analysis.items[0].reasons.map((reason) => reason.code), ["nested-loop-amplification"]);
  assert.equal(analysis.items[0].reasons[0].source, "RelOp@EstimateRows");
  assert.equal(analysis.items[0].reasons[0].evidence.estimatedRowComparisons, 50_000_000);
});

/* --------------------------------------------------- OceanBase Oracle signals -- */

/** An OceanBase Oracle node carrying engine-specific fields. */
function oceanBaseNode(oceanBase, overrides = {}) {
  return normalizedNode({ engineSpecific: { database: "oceanbase-oracle", oceanBase }, ...overrides });
}

test("OceanBase Oracle hotspots use rows only and name the native EST.ROWS field", () => {
  const root = oceanBaseNode(
    { id: 0, operator: "TABLE FULL SCAN", name: "T_ORDERS", estimatedTimeUs: 41_200, cost: 1_234 },
    {
      kind: "seq_scan",
      nodeType: "TABLE FULL SCAN",
      relation: { name: "T_ORDERS", alias: null, indexName: null },
      estimatedRows: 250_000,
    },
  );

  const analysis = run(root, "oceanbase-oracle");
  assert.deepEqual(analysis.cost, {
    engine: "oceanbase-oracle",
    status: "not-applicable",
    reason: "NOT_POSTGRES_COST_MODEL",
  });
  assert.deepEqual(analysis.items.map((hotspot) => hotspot.reasons.map((reason) => reason.code)), [["large-sequential-scan"]]);
  assert.equal(analysis.items[0].reasons[0].source, "EST.ROWS");
  assert.equal(analysis.items[0].estimateOnly, true);

  const evidence = analysis.items[0].evidence;
  assert.equal("estimatedTotalCost" in evidence, false, "PostgreSQL-only evidence must not appear");
  assert.equal("selfCost" in evidence, false);
  assert.equal("selfCostShare" in evidence, false);
  assert.equal("estimatedTimeUs" in evidence, false, "OceanBase estimate time is not a hotspot signal this round");
});

test("OceanBase Oracle nested loop amplification reads the two input estimates", () => {
  const root = oceanBaseNode(
    { id: 0, operator: "NESTED-LOOP JOIN", name: "", estimatedTimeUs: 62_000_000 },
    {
      kind: "nested_loop",
      nodeType: "NESTED-LOOP JOIN",
      estimatedRows: 5_000_000,
      children: [
        oceanBaseNode({ id: 1, operator: "TABLE RANGE SCAN", name: "T_CUSTOMERS(IDX)" }, { id: "0.0", kind: "index_scan", nodeType: "TABLE RANGE SCAN", estimatedRows: 1_000 }),
        oceanBaseNode({ id: 2, operator: "TABLE FULL SCAN", name: "T_ORDERS" }, { id: "0.1", kind: "seq_scan", nodeType: "TABLE FULL SCAN", estimatedRows: 50_000 }),
      ],
    },
  );

  const analysis = run(root, "oceanbase-oracle");
  assert.deepEqual(
    analysis.items.map((hotspot) => [hotspot.nodeId, hotspot.reasons.map((reason) => reason.code)]),
    [
      ["0", ["nested-loop-amplification"]],
      ["0.1", ["large-sequential-scan"]],
    ],
  );
  const amplification = analysis.items[0].reasons[0];
  assert.equal(amplification.source, "EST.ROWS");
  assert.equal(amplification.evidence.estimatedRowComparisons, 50_000_000);
});

test("OceanBase Oracle generates no cost or sort signal from its own estimates", () => {
  const sort = run(
    oceanBaseNode(
      { id: 0, operator: "SORT", name: "", estimatedTimeUs: 15_600, cost: 9_999 },
      { kind: "sort", nodeType: "SORT", estimatedRows: 120_000 },
    ),
    "oceanbase-oracle",
  );

  assert.deepEqual(sort.items, [], "EST.TIME(us) / COST are not comparable with any cost threshold");
});

/* --------------------------------------------------------------- ordering -- */
test("hotspots are ordered by level, then by reason count, then by plan pre-order", () => {
  const root = pgChild({
    kind: "result",
    nodeType: "Result",
    totalCost: 100_000,
    children: [
      // warning, two reasons: 25% share + 50k rows
      pgChild({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 25_000, estimatedRows: 50_000 }),
      // high, one reason: 55% share
      pgChild({ id: "0.1", kind: "hash", nodeType: "Hash", totalCost: 55_000 }),
      // warning, one reason: 10k rows, cost share far below the threshold
      pgChild({ id: "0.2", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 3_000, estimatedRows: 10_000 }),
      // high, one reason: 100k rows, cost share far below the threshold
      pgChild({ id: "0.3", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 1_000, estimatedRows: 100_000 }),
    ],
  });
  const plan = normalizedPlan({ root });

  const first = computeHotspots(plan, computeMetrics(plan));
  const second = computeHotspots(plan, computeMetrics(plan));

  assert.deepEqual(first.items.map((hotspot) => hotspot.nodeId), ["0.1", "0.3", "0.0", "0.2"]);
  assert.deepEqual(
    first.items.map((hotspot) => [hotspot.level, hotspot.reasons.length]),
    [
      ["high", 1],
      ["high", 1],
      ["warning", 2],
      ["warning", 1],
    ],
  );
  assert.deepEqual(second.items, first.items, "ordering must be stable across runs");
});

test("two nodes with the same level and reason count keep plan pre-order", () => {
  const root = pgChild({
    kind: "result",
    nodeType: "Result",
    totalCost: 90,
    children: [
      pgChild({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 40, estimatedRows: 100_000 }),
      pgChild({ id: "0.1", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 40, estimatedRows: 100_000 }),
    ],
  });

  const items = run(root).items;
  assert.deepEqual(items.map((hotspot) => hotspot.nodeId), ["0.0", "0.1"]);
});

/* ------------------------------------------------------------- fail-safety -- */

test("partial and malformed plans degrade without throwing", () => {
  const emptyRoot = normalizedPlan({ root: normalizedNode({}) });
  assert.deepEqual(computeHotspots(emptyRoot, computeMetrics(emptyRoot)).items, []);

  const notANumber = normalizedPlan({ root: normalizedNode({ totalCost: Number.NaN }) });
  assert.equal(computeHotspots(notANumber, computeMetrics(notANumber)).cost.status, "withheld");

  const unknownKind = normalizedPlan({
    root: normalizedNode({ kind: "unknown", nodeType: "Future Shuffle Node", totalCost: 10, estimatedRows: 10 }),
  });
  assert.deepEqual(computeHotspots(unknownKind, computeMetrics(unknownKind)).items, []);
});

test("raw-only databases do not enter structured hotspot analysis", () => {
  const analysis = analyzeRawPlan({ database: "doris", mode: "estimated", format: "text", plan: "| 0 | SELECT STATEMENT |" });

  assert.equal(analysis.status, "raw-only");
  assert.equal(analysis.hotspots, null);
  assert.equal(analysis.findings.length, 0);
  assert.equal(analysis.metrics, null);
});

test("structured analysis exposes hotspots as an engine-scoped result", () => {
  const analysis = analyzePlan({
    database: "postgresql",
    mode: "estimated",
    format: "json",
    plan: [{ Plan: { "Node Type": "Seq Scan", "Total Cost": 3_497, "Plan Rows": 200_000 } }],
  });

  assert.equal(analysis.hotspots.cost.engine, "postgresql");
  assert.equal(analysis.hotspots.items.length, 1);
  assert.equal(analysis.hotspots.items[0].nodeId, "0");
});
