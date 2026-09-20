import assert from "node:assert/strict";
import test from "node:test";
import { computeMetrics } from "../../src/core/metrics/compute-metrics.js";
import { depthOf, flattenNodes, incrementalCostOf, walkNodes } from "../../src/core/tree.js";
import { normalizedNode, normalizedPlan } from "../helpers/plan-builders.js";

test("depthOf: single node has depth 1", () => {
  assert.equal(depthOf(normalizedNode()), 1);
});

test("walkNodes and flattenNodes visit pre-order and include the root", () => {
  const root = normalizedNode({
    children: [
      normalizedNode({ id: "0.0" }),
      normalizedNode({ id: "0.1", children: [normalizedNode({ id: "0.1.0" })] }),
    ],
  });

  assert.deepEqual(
    [...walkNodes(root)].map((node) => node.id),
    ["0", "0.0", "0.1", "0.1.0"],
  );
  assert.equal(flattenNodes(root).length, 4);
});

test("incrementalCostOf subtracts child costs and returns null without a total cost", () => {
  assert.equal(incrementalCostOf(normalizedNode({ totalCost: 100 })), 100);
  assert.equal(
    incrementalCostOf(
      normalizedNode({
        totalCost: 100,
        children: [normalizedNode({ totalCost: 40 }), normalizedNode({ totalCost: 35 })],
      }),
    ),
    25,
  );
  assert.equal(
    incrementalCostOf(normalizedNode({ totalCost: 100, children: [normalizedNode({ totalCost: null })] })),
    100,
    "children without a cost count as 0",
  );
  assert.equal(incrementalCostOf(normalizedNode({ totalCost: null })), null);
});

test("computeMetrics counts nodes, scans, joins, sorts and aggregates", () => {
  const plan = normalizedPlan({
    root: normalizedNode({
      kind: "nested_loop",
      nodeType: "Nested Loop",
      totalCost: 500,
      estimatedRows: 1000,
      children: [
        normalizedNode({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", relation: { name: "orders", alias: "o", indexName: null }, totalCost: 100, estimatedRows: 5000 }),
        normalizedNode({
          id: "0.1",
          kind: "hash_join",
          nodeType: "Hash Join",
          totalCost: 300,
          estimatedRows: 1000,
          children: [
            normalizedNode({ id: "0.1.0", kind: "index_scan", nodeType: "Index Scan", relation: { name: "customers", alias: "c", indexName: "customers_pkey" }, totalCost: 10, estimatedRows: 10 }),
            normalizedNode({ id: "0.1.1", kind: "bitmap_heap_scan", nodeType: "Bitmap Heap Scan", relation: { name: "events", alias: "e", indexName: null }, totalCost: 50, estimatedRows: 600 }),
          ],
        }),
      ],
    }),
  });

  const metrics = computeMetrics(plan);
  assert.equal(metrics.nodeCount, 5);
  assert.equal(metrics.maxDepth, 3);
  assert.equal(metrics.totalEstimatedCost, 500);
  assert.equal(metrics.rootEstimatedRows, 1000);
  assert.equal(metrics.scanCount, 3);
  assert.equal(metrics.sequentialScanCount, 1);
  assert.equal(metrics.indexScanCount, 1);
  assert.equal(metrics.bitmapScanCount, 1);
  assert.equal(metrics.joinCount, 2);
  assert.equal(metrics.sortCount, 0);
  assert.equal(metrics.aggregateCount, 0);
  assert.deepEqual(metrics.largestEstimatedRows, {
    nodeId: "0.0",
    kind: "seq_scan",
    nodeType: "Seq Scan",
    relation: "orders",
    estimatedRows: 5000,
  });
  assert.deepEqual(metrics.highestIncrementalCost, {
    nodeId: "0.1",
    kind: "hash_join",
    nodeType: "Hash Join",
    relation: null,
    incrementalCost: 240,
    totalCost: 300,
  });
});

test("computeMetrics counts sorts and aggregate-family nodes", () => {
  const plan = normalizedPlan({
    root: normalizedNode({
      kind: "sort",
      nodeType: "Sort",
      totalCost: 200,
      children: [
        normalizedNode({ id: "0.0", kind: "aggregate", nodeType: "HashAggregate", totalCost: 150 }),
        normalizedNode({ id: "0.1", kind: "incremental_sort", nodeType: "Incremental Sort", totalCost: 10 }),
      ],
    }),
  });

  const metrics = computeMetrics(plan);
  assert.equal(metrics.sortCount, 2);
  assert.equal(metrics.aggregateCount, 1);
});

test("computeMetrics stays null instead of inventing values when data is missing", () => {
  const metrics = computeMetrics(normalizedPlan({ root: normalizedNode({ kind: "result", nodeType: "Result" }) }));

  assert.equal(metrics.nodeCount, 1);
  assert.equal(metrics.maxDepth, 1);
  assert.equal(metrics.totalEstimatedCost, null);
  assert.equal(metrics.rootEstimatedRows, null);
  assert.equal(metrics.largestEstimatedRows, null);
  assert.equal(metrics.highestIncrementalCost, null);
});

test("largestEstimatedRows and highestIncrementalCost break ties by pre-order", () => {
  const plan = normalizedPlan({
    root: normalizedNode({
      kind: "hash_join",
      nodeType: "Hash Join",
      totalCost: 100,
      estimatedRows: 10,
      children: [
        normalizedNode({ id: "0.0", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 40, estimatedRows: 700 }),
        normalizedNode({ id: "0.1", kind: "seq_scan", nodeType: "Seq Scan", totalCost: 40, estimatedRows: 700 }),
      ],
    }),
  });

  const metrics = computeMetrics(plan);
  assert.equal(metrics.largestEstimatedRows.nodeId, "0.0");
  assert.equal(metrics.highestIncrementalCost.nodeId, "0.0");
  assert.equal(metrics.highestIncrementalCost.incrementalCost, 40);
});

test("computeMetrics reports unknown node types from the normalized plan", () => {
  const plan = normalizedPlan({ unknownNodeTypes: ["Future Shuffle Node", "Another Future Node"] });
  assert.equal(computeMetrics(plan).unknownNodeTypeCount, 2);
});
