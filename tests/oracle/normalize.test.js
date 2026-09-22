import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOraclePlan } from "../../src/core/normalize/normalize-oracle.js";

function node(overrides = {}) {
  return {
    nodeType: "SELECT STATEMENT",
    rawOperation: "SELECT STATEMENT",
    id: 0,
    name: null,
    estimatedRows: 1,
    bytes: 10,
    cost: 2,
    cpuPercent: 0,
    time: "00:00:01",
    predicateMarker: false,
    predicates: null,
    indentation: 0,
    children: [],
    extra: {},
    ...overrides,
  };
}

test("maps Oracle scans and index names without promoting Oracle cost", () => {
  const parsed = {
    database: "oracle",
    format: "text",
    mode: "estimated",
    planHashValue: 123,
    root: node({
      children: [
        node({
          nodeType: "TABLE ACCESS BY INDEX ROWID",
          rawOperation: "TABLE ACCESS BY INDEX ROWID",
          id: 4,
          name: "PD_USERS",
          children: [
            node({
              nodeType: "INDEX UNIQUE SCAN",
              rawOperation: "INDEX UNIQUE SCAN",
              id: 2,
              name: "PD_USERS_PK",
            }),
          ],
        }),
      ],
    }),
  };

  const normalized = normalizeOraclePlan(parsed);
  const table = normalized.root.children[0];
  const index = table.children[0];

  assert.equal(normalized.root.kind, "result");
  assert.equal(table.kind, "lookup");
  assert.deepEqual(table.relation, { name: "PD_USERS", alias: null, indexName: null });
  assert.equal(index.kind, "index_scan");
  assert.deepEqual(index.relation, { name: null, alias: null, indexName: "PD_USERS_PK" });
  assert.equal(table.startupCost, null);
  assert.equal(table.totalCost, null);
  assert.equal(table.engineSpecific.oracle.cost, 2);
  assert.equal(normalized.root.engineSpecific.oracle.planHashValue, 123);
  assert.equal(index.engineSpecific.oracle.planHashValue, null);
});

test("keeps unknown operation labels and their subtrees", () => {
  const parsed = {
    database: "oracle",
    format: "text",
    mode: "estimated",
    planHashValue: null,
    root: node({
      children: [
        node({
          nodeType: "FUTURE ORACLE OPERATION",
          rawOperation: "FUTURE ORACLE OPERATION",
          id: 8,
          children: [node({ nodeType: "TABLE ACCESS FULL", rawOperation: "TABLE ACCESS FULL", id: 3, name: "T1" })],
        }),
      ],
    }),
  };

  const normalized = normalizeOraclePlan(parsed);
  assert.equal(normalized.root.children[0].kind, "unknown");
  assert.equal(normalized.root.children[0].children[0].kind, "seq_scan");
  assert.deepEqual(normalized.unknownNodeTypes, ["FUTURE ORACLE OPERATION"]);
});
