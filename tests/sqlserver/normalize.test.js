import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSqlServerPlan } from "../../src/core/normalize/normalize-sqlserver.js";
import { flattenNodes } from "../../src/core/tree.js";
import { parsedSqlServerNode, parsedSqlServerPlan } from "../helpers/plan-builders.js";

/**
 * NormalizedPlan contract for SQL Server.
 *
 * The normalizer maps SQL Server labels onto the shared `kind` vocabulary,
 * promotes the row / relation / predicate fields the shared metrics and rules
 * read, and keeps every SQL Server-specific value under `engineSpecific`.
 * SQL Server costs are subtree costs in SQL Server's own model: they must never
 * appear in `startupCost` / `totalCost`.
 */

/** @param {string} physicalOp @param {Record<string, unknown>} [overrides] */
function nodeFor(physicalOp, overrides = {}) {
  return parsedSqlServerNode({ nodeType: physicalOp, physicalOp, logicalOp: physicalOp, ...overrides });
}

/** @param {Record<string, unknown>} [overrides] */
function normalize(overrides = {}) {
  return normalizeSqlServerPlan(parsedSqlServerPlan(overrides));
}

test("maps SQL Server operators onto the shared kind vocabulary", () => {
  const cases = [
    ["Table Scan", "seq_scan"],
    ["Clustered Index Scan", "index_scan"],
    ["Index Scan", "index_scan"],
    ["Columnstore Index Scan", "index_scan"],
    ["Clustered Index Seek", "index_scan"],
    ["Index Seek", "index_scan"],
    ["Key Lookup", "lookup"],
    ["RID Lookup", "lookup"],
    ["Nested Loops", "nested_loop"],
    ["Merge Join", "merge_join"],
    ["Sort", "sort"],
    ["Top N Sort", "sort"],
    ["Stream Aggregate", "aggregate"],
    ["Compute Scalar", "compute_scalar"],
    ["Filter", "filter"],
    ["Concatenation", "append"],
    ["Parallelism", "parallelism"],
    ["Table Spool", "spool"],
    ["Index Spool", "spool"],
    ["Row Count Spool", "spool"],
    ["Top", "limit"],
    ["Constant Scan", "values_scan"],
  ];

  for (const [physicalOp, kind] of cases) {
    const normalized = normalize({ root: nodeFor(physicalOp) });
    assert.equal(normalized.root.kind, kind, `${physicalOp} must map to ${kind}`);
    assert.deepEqual(normalized.unknownNodeTypes, [], `${physicalOp} must not be unknown`);
  }
});

test("refines Hash Match through LogicalOp", () => {
  assert.equal(normalize({ root: nodeFor("Hash Match", { logicalOp: "Inner Join" }) }).root.kind, "hash_join");
  assert.equal(normalize({ root: nodeFor("Hash Match", { logicalOp: "Left Outer Join" }) }).root.kind, "hash_join");
  assert.equal(normalize({ root: nodeFor("Hash Match", { logicalOp: "Aggregate" }) }).root.kind, "aggregate");
  assert.equal(normalize({ root: nodeFor("Hash Match", { logicalOp: "Union" }) }).root.kind, "hash_match");
});

test("an unknown operator keeps its label, subtree and the unknownNodeTypes record", () => {
  const child = nodeFor("Table Scan");
  const normalized = normalize({
    root: nodeFor("Future Shuffle", { estimatedRows: 7, children: [child] }),
  });

  assert.equal(normalized.root.kind, "unknown");
  assert.equal(normalized.root.nodeType, "Future Shuffle");
  assert.equal(normalized.root.children.length, 1);
  assert.equal(normalized.root.children[0].kind, "seq_scan");
  assert.deepEqual(normalized.unknownNodeTypes, ["Future Shuffle"]);
});

test("unknownNodeTypes is sorted and de-duplicated", () => {
  const normalized = normalize({
    root: nodeFor("Zeta Op", {
      children: [nodeFor("Alpha Op"), nodeFor("Zeta Op"), nodeFor("Alpha Op")],
    }),
  });

  assert.deepEqual(normalized.unknownNodeTypes, ["Alpha Op", "Zeta Op"]);
});

test("maps neutral fields and keeps SQL Server-only values under engineSpecific", () => {
  const normalized = normalize({
    root: nodeFor("Clustered Index Seek", {
      nodeId: 3,
      estimatedRows: 12,
      estimatedTotalSubtreeCost: 0.5,
      estimateCpu: 0.01,
      estimateIo: 0.02,
      avgRowSize: 24,
      parallel: false,
      database: "[Sales]",
      schema: "[dbo]",
      table: "[Orders]",
      index: "[PK_Orders]",
      alias: "[o]",
      indexKind: "Clustered",
      storage: "RowStore",
      predicate: "[o].[Status]='OPEN'",
      indexCondition: "Prefix(EQ) [o].[OrderID] = (42)",
      sortKeys: ["[o].[OrderDate] ASC"],
      groupKeys: ["[o].[CustomerID]"],
      operator: { ordered: true },
    }),
    statement: { type: "SELECT", id: 1, subtreeCost: 0.5, estimatedRows: 12, optimizationLevel: "FULL" },
    queryPlan: { degreeOfParallelism: 1, memoryGrant: 1024, cachedPlanSize: 32 },
  });

  const root = normalized.root;
  assert.equal(root.id, "0");
  assert.equal(root.estimatedRows, 12);
  assert.equal(root.width, 24);
  assert.equal(root.filter, "[o].[Status]='OPEN'");
  assert.equal(root.indexCondition, "Prefix(EQ) [o].[OrderID] = (42)");
  assert.deepEqual(root.sortKeys, ["[o].[OrderDate] ASC"]);
  assert.deepEqual(root.groupKeys, ["[o].[CustomerID]"]);
  assert.deepEqual(root.relation, { name: "Orders", alias: "o", indexName: "PK_Orders" });
  assert.equal(root.joinType, null, "a seek is not a join");

  // SQL Server costs are a different cost model and stay out of the shared fields.
  assert.equal(root.startupCost, null);
  assert.equal(root.totalCost, null);
  assert.equal(root.actualRows, null);
  assert.equal(root.loops, null);

  const sqlServer = root.engineSpecific.sqlServer;
  assert.equal(sqlServer.physicalOp, "Clustered Index Seek");
  assert.equal(sqlServer.logicalOp, "Clustered Index Seek");
  assert.equal(sqlServer.nodeId, 3);
  assert.equal(sqlServer.estimatedTotalSubtreeCost, 0.5);
  assert.equal(sqlServer.estimateCpu, 0.01);
  assert.equal(sqlServer.estimateIo, 0.02);
  assert.equal(sqlServer.table, "[Orders]", "the raw bracketed value stays under engineSpecific");
  assert.deepEqual(sqlServer.operator, { ordered: true });
  assert.deepEqual(sqlServer.statement, { type: "SELECT", id: 1, subtreeCost: 0.5, estimatedRows: 12, optimizationLevel: "FULL" });
  assert.deepEqual(sqlServer.queryPlan, { degreeOfParallelism: 1, memoryGrant: 1024, cachedPlanSize: 32 });
});

test("statement and queryPlan metadata only live on the root node", () => {
  const normalized = normalize({
    root: nodeFor("Nested Loops", {
      children: [nodeFor("Index Seek"), nodeFor("Clustered Index Seek")],
    }),
    statement: { type: "SELECT", id: 1, subtreeCost: 1, estimatedRows: 1, optimizationLevel: "FULL" },
    queryPlan: { degreeOfParallelism: 1, memoryGrant: 0, cachedPlanSize: 16 },
  });

  assert.ok(normalized.root.engineSpecific.sqlServer.statement);
  assert.ok(normalized.root.engineSpecific.sqlServer.queryPlan);
  for (const child of normalized.root.children) {
    assert.equal(Object.hasOwn(child.engineSpecific.sqlServer, "statement"), false);
    assert.equal(Object.hasOwn(child.engineSpecific.sqlServer, "queryPlan"), false);
  }
});

test("joinType carries the SQL Server LogicalOp only for join nodes", () => {
  const join = normalize({ root: nodeFor("Nested Loops", { logicalOp: "Left Outer Join" }) });
  assert.equal(join.root.joinType, "Left Outer Join");

  const aggregate = normalize({ root: nodeFor("Stream Aggregate", { logicalOp: "Aggregate" }) });
  assert.equal(aggregate.root.joinType, null);

  const scan = normalize({ root: nodeFor("Table Scan") });
  assert.equal(scan.root.joinType, null);
});

test("assigns stable path ids in pre-order", () => {
  const normalized = normalize({
    root: nodeFor("Nested Loops", {
      children: [
        nodeFor("Index Seek", { children: [nodeFor("Compute Scalar")] }),
        nodeFor("Clustered Index Seek"),
      ],
    }),
  });

  assert.deepEqual(
    flattenNodes(normalized.root).map((node) => node.id),
    ["0", "0.0", "0.0.0", "0.1"],
  );
});

test("normalization is deterministic and JSON-serializable", () => {
  const parsed = parsedSqlServerPlan({
    root: nodeFor("Sort", { sortKeys: ["[o].[OrderDate] ASC"], estimatedRows: 10 }),
    statement: { type: "SELECT", id: 1, subtreeCost: 1, estimatedRows: 10, optimizationLevel: "FULL" },
    queryPlan: { degreeOfParallelism: 1, memoryGrant: 0, cachedPlanSize: 16 },
  });

  const first = normalizeSqlServerPlan(parsed);
  const second = normalizeSqlServerPlan(parsed);
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});
