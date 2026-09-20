import assert from "node:assert/strict";
import test from "node:test";
import { normalizePostgresPlan } from "../../src/core/normalize/normalize-postgres.js";
import { parsedNode, parsedPlan } from "../helpers/plan-builders.js";

test("assigns stable path ids in pre-order", () => {
  const parsed = parsedPlan({
    root: parsedNode({
      nodeType: "Nested Loop",
      children: [
        parsedNode({ nodeType: "Seq Scan" }),
        parsedNode({
          nodeType: "Hash",
          children: [parsedNode({ nodeType: "Seq Scan" })],
        }),
      ],
    }),
  });

  const normalized = normalizePostgresPlan(parsed);
  assert.equal(normalized.root.id, "0");
  assert.deepEqual(
    normalized.root.children.map((child) => child.id),
    ["0.0", "0.1"],
  );
  assert.equal(normalized.root.children[1].children[0].id, "0.1.0");
});

test("maps PostgreSQL node types onto stable semantic kinds", () => {
  const cases = [
    ["Seq Scan", "seq_scan"],
    ["Index Scan", "index_scan"],
    ["Index Only Scan", "index_only_scan"],
    ["Bitmap Heap Scan", "bitmap_heap_scan"],
    ["Bitmap Index Scan", "bitmap_index_scan"],
    ["Nested Loop", "nested_loop"],
    ["Hash Join", "hash_join"],
    ["Merge Join", "merge_join"],
    ["Hash", "hash"],
    ["Sort", "sort"],
    ["Incremental Sort", "incremental_sort"],
    ["Aggregate", "aggregate"],
    ["HashAggregate", "aggregate"],
    ["GroupAggregate", "aggregate"],
    ["Group", "group"],
    ["Limit", "limit"],
    ["Gather Merge", "gather_merge"],
    ["Memoize", "memoize"],
  ];

  for (const [nodeType, kind] of cases) {
    const normalized = normalizePostgresPlan(parsedPlan({ root: parsedNode({ nodeType }) }));
    assert.equal(normalized.root.kind, kind, `${nodeType} must map to ${kind}`);
    assert.equal(normalized.root.nodeType, nodeType, "raw node type must stay available");
  }
});

test("keeps unknown node types instead of failing, and records them once", () => {
  const parsed = parsedPlan({
    root: parsedNode({
      nodeType: "Future Shuffle Node",
      children: [
        parsedNode({ nodeType: "Future Shuffle Node" }),
        parsedNode({ nodeType: "Another Future Node" }),
      ],
    }),
  });

  const normalized = normalizePostgresPlan(parsed);
  assert.equal(normalized.root.kind, "unknown");
  assert.equal(normalized.root.nodeType, "Future Shuffle Node");
  assert.deepEqual(normalized.unknownNodeTypes, ["Another Future Node", "Future Shuffle Node"]);
  assert.equal(normalized.root.children[0].kind, "unknown");
  assert.equal(normalized.root.children.length, 2, "unknown node types must keep their children");
});

test("promotes common fields and keeps PostgreSQL-only data under engineSpecific", () => {
  const normalized = normalizePostgresPlan(
    parsedPlan({
      root: parsedNode({
        nodeType: "Index Scan",
        relationName: "pd_fix_orders",
        alias: "o",
        indexName: "pd_fix_orders_customer_idx",
        startupCost: 0.29,
        totalCost: 8.31,
        planRows: 1,
        planWidth: 27,
        filter: "(status = 'paid'::text)",
        indexCondition: "(customer_id = 42)",
        recheckCondition: null,
        parentRelationship: "Outer",
        parallelAware: false,
        strategy: null,
        extra: { "Heap Fetches": 0 },
      }),
    }),
  );

  const node = normalized.root;
  assert.deepEqual(node.relation, { name: "pd_fix_orders", alias: "o", indexName: "pd_fix_orders_customer_idx" });
  assert.equal(node.estimatedRows, 1);
  assert.equal(node.startupCost, 0.29);
  assert.equal(node.totalCost, 8.31);
  assert.equal(node.width, 27);
  assert.equal(node.filter, "(status = 'paid'::text)");
  assert.equal(node.indexCondition, "(customer_id = 42)");
  assert.equal(node.engineSpecific.parentRelationship, "Outer");
  assert.equal(node.engineSpecific.parallelAware, false);
  assert.deepEqual(node.engineSpecific.extra, { "Heap Fetches": 0 });
  assert.equal(node.engineSpecific.database, "postgresql");
});

test("relation is null when the node carries no relation information", () => {
  const normalized = normalizePostgresPlan(parsedPlan({ root: parsedNode({ nodeType: "Result" }) }));
  assert.equal(normalized.root.relation, null);
});

test("joinCondition prefers the equality condition and keeps every variant in engineSpecific", () => {
  const hash = normalizePostgresPlan(
    parsedPlan({ root: parsedNode({ nodeType: "Hash Join", hashCondition: "(a.id = b.id)", joinFilter: "(a.x > 0)" }) }),
  );
  assert.equal(hash.root.joinCondition, "(a.id = b.id)");
  assert.equal(hash.root.engineSpecific.hashCondition, "(a.id = b.id)");
  assert.equal(hash.root.engineSpecific.joinFilter, "(a.x > 0)");

  const merge = normalizePostgresPlan(
    parsedPlan({ root: parsedNode({ nodeType: "Merge Join", mergeCondition: "(a.id = b.id)" }) }),
  );
  assert.equal(merge.root.joinCondition, "(a.id = b.id)");

  const nestedLoop = normalizePostgresPlan(
    parsedPlan({ root: parsedNode({ nodeType: "Nested Loop", joinFilter: "(a.total > b.total)" }) }),
  );
  assert.equal(nestedLoop.root.joinCondition, "(a.total > b.total)");
  assert.equal(nestedLoop.root.engineSpecific.mergeCondition, null);
});

test("propagates database, mode and format without reinterpreting them", () => {
  const normalized = normalizePostgresPlan(parsedPlan({ mode: "actual", format: "json" }));
  assert.equal(normalized.database, "postgresql");
  assert.equal(normalized.mode, "actual");
  assert.equal(normalized.format, "json");
});
