import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDamengPlan } from "../../src/core/normalize/normalize-dameng.js";

function node(overrides = {}) {
  return {
    nodeType: "NSET2",
    operator: "NSET2",
    id: 1,
    cost: 3,
    estimatedRows: 100,
    bytesPerRow: 56,
    detail: null,
    predicates: null,
    indentation: 0,
    children: [],
    extra: {},
    ...overrides,
  };
}

function parsed(root, overrides = {}) {
  return { database: "dameng", format: "text", mode: "estimated", root, ...overrides };
}

test("maps Dameng operators and keeps the native tuple outside PostgreSQL costs", () => {
  const normalized = normalizeDamengPlan(
    parsed(
      node({
        children: [
          node({
            nodeType: "CSCN2",
            operator: "CSCN2",
            id: 4,
            cost: 12,
            estimatedRows: 250000,
            bytesPerRow: 64,
            detail: "INDEX100(T_ORDERS as O); btr_scan(1)",
            predicates: ["filter(O.STATUS = 'OPEN')"],
          }),
          node({ nodeType: "SSEK2", operator: "SSEK2", id: 5, detail: "IDX_ORDERS(O as O)" }),
        ],
      }),
    ),
  );

  const root = normalizedRoot(normalized);
  const scan = root.children[0];
  const index = root.children[1];

  assert.equal(root.kind, "result");
  assert.equal(scan.kind, "seq_scan");
  assert.equal(index.kind, "index_scan");
  assert.deepEqual(scan.relation, { name: "T_ORDERS", alias: "O", indexName: "INDEX100" });
  assert.equal(scan.filter, "O.STATUS = 'OPEN'");
  assert.equal(scan.width, 64);
  assert.equal(scan.startupCost, null);
  assert.equal(scan.totalCost, null);
  assert.equal(scan.engineSpecific.dameng.cost, 12);
  assert.deepEqual(scan.engineSpecific.dameng.predicates, ["filter(O.STATUS = 'OPEN')"]);
  assert.deepEqual(normalized.unknownNodeTypes, []);
});

test("maps joins, aggregates and sort operators without dropping future labels", () => {
  const normalized = normalizeDamengPlan(
    parsed(
      node({
        nodeType: "HASH LEFT SEMI JOIN2",
        operator: "HASH LEFT SEMI JOIN2",
        children: [
          node({ nodeType: "HAGR2", operator: "HAGR2" }),
          node({ nodeType: "SORT3", operator: "SORT3" }),
        ],
      }),
    ),
  );

  assert.equal(normalized.root.kind, "hash_join");
  assert.equal(normalized.root.children[0].kind, "aggregate");
  assert.equal(normalized.root.children[1].kind, "sort");

  const unknown = normalizeDamengPlan(parsed(node({ nodeType: "FUTURE SHUFFLE", operator: "FUTURE SHUFFLE" })));
  assert.equal(unknown.root.kind, "unknown");
  assert.deepEqual(unknown.unknownNodeTypes, ["FUTURE SHUFFLE"]);
});

function normalizedRoot(plan) {
  return plan.root;
}
