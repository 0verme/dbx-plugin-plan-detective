import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOceanBasePlan } from "../../src/core/normalize/normalize-oceanbase.js";
import { flattenNodes } from "../../src/core/tree.js";
import { parsedOceanBaseNode, parsedOceanBasePlan } from "../helpers/plan-builders.js";

/**
 * NormalizedPlan contract for OceanBase Oracle.
 *
 * The normalizer maps OceanBase operator labels onto the shared `kind`
 * vocabulary, promotes the row / relation fields the shared metrics and rules
 * read, and keeps every OceanBase-specific value under `engineSpecific`.
 * `EST.TIME(us)` and `COST` belong to OceanBase's own estimate model: they must
 * never appear in `startupCost` / `totalCost`.
 */

/** @param {string} nodeType @param {Record<string, unknown>} [overrides] */
function nodeFor(nodeType, overrides = {}) {
  return parsedOceanBaseNode({ nodeType, operator: nodeType, ...overrides });
}

/** @param {Record<string, unknown>} [overrides] */
function normalize(overrides = {}) {
  return normalizeOceanBasePlan(parsedOceanBasePlan(overrides));
}

test("maps OceanBase operators onto the shared kind vocabulary", () => {
  const cases = [
    ["TABLE FULL SCAN", "seq_scan"],
    ["TABLE SCAN", "index_scan"],
    ["TABLE RANGE SCAN", "index_scan"],
    ["TABLE SKIP SCAN", "index_scan"],
    ["TABLE GET", "index_scan"],
    ["NESTED LOOP JOIN", "nested_loop"],
    ["HASH JOIN", "hash_join"],
    ["MERGE JOIN", "merge_join"],
    ["SORT", "sort"],
    ["SCALAR GROUP BY", "aggregate"],
    ["HASH GROUP BY", "aggregate"],
    ["MERGE GROUP BY", "aggregate"],
    ["COUNT", "aggregate"],
    ["WINDOW FUNCTION", "analytic"],
    ["LIMIT", "limit"],
    ["MATERIAL", "materialize"],
    ["SUBPLAN SCAN", "subquery_scan"],
    ["SUBPLAN FILTER", "subquery"],
    ["HASH DISTINCT", "unique"],
    ["MERGE DISTINCT", "unique"],
    ["UNION ALL", "append"],
    ["HASH UNION DISTINCT", "setop"],
    ["MERGE UNION DISTINCT", "setop"],
    ["INSERT", "modify_table"],
    ["DELETE", "modify_table"],
    ["UPDATE", "modify_table"],
    ["MERGE", "modify_table"],
  ];

  for (const [operator, kind] of cases) {
    const normalized = normalize({ root: nodeFor(operator) });
    assert.equal(normalized.root.kind, kind, `${operator} must map to ${kind}`);
    assert.equal(normalized.root.nodeType, operator, "the engine label is always preserved");
    assert.deepEqual(normalized.unknownNodeTypes, [], `${operator} must not be unknown`);
  }
});

test("classifies hyphenated and distributed operator labels without rewriting them", () => {
  const hyphenated = normalize({ root: nodeFor("NESTED-LOOP JOIN") });
  assert.equal(hyphenated.root.kind, "nested_loop");
  assert.equal(hyphenated.root.nodeType, "NESTED-LOOP JOIN");

  const spaced = normalize({ root: nodeFor("NESTED LOOP JOIN") });
  assert.equal(spaced.root.kind, "nested_loop");

  const distributedRange = normalize({ root: nodeFor("DISTRIBUTED TABLE RANGE SCAN") });
  assert.equal(distributedRange.root.kind, "index_scan");
  assert.equal(distributedRange.root.nodeType, "DISTRIBUTED TABLE RANGE SCAN");
  assert.deepEqual(distributedRange.unknownNodeTypes, []);

  const distributedFull = normalize({ root: nodeFor("DISTRIBUTED TABLE FULL SCAN") });
  assert.equal(distributedFull.root.kind, "seq_scan");
});

test("records unclassified operator labels once, sorted and deduplicated", () => {
  const normalized = normalize({
    root: parsedOceanBaseNode({
      nodeType: "PX FUTURE SHUFFLE",
      operator: "PX FUTURE SHUFFLE",
      children: [
        parsedOceanBaseNode({ nodeType: "EXCHANGE OUT DISTRIBUTED", operator: "EXCHANGE OUT DISTRIBUTED" }),
        parsedOceanBaseNode({ nodeType: "PX FUTURE SHUFFLE", operator: "PX FUTURE SHUFFLE" }),
      ],
    }),
  });

  assert.deepEqual(normalized.unknownNodeTypes, ["EXCHANGE OUT DISTRIBUTED", "PX FUTURE SHUFFLE"]);
  assert.deepEqual(
    flattenNodes(normalized.root).map((node) => node.kind),
    ["unknown", "unknown", "unknown"],
    "an unknown operator keeps its node and its subtree",
  );
});

test("does not record the operator placeholder as an engine label", () => {
  const normalized = normalize({
    root: parsedOceanBaseNode({
      nodeType: "Plan",
      operator: null,
      children: [parsedOceanBaseNode({ nodeType: "TABLE FULL SCAN", operator: "TABLE FULL SCAN" })],
    }),
  });

  assert.equal(normalized.root.kind, "unknown");
  assert.equal(normalized.root.nodeType, "Plan");
  assert.deepEqual(normalized.unknownNodeTypes, [], "the placeholder is not an operator the engine reported");
});

test("maps NAME onto the neutral relation and keeps TABLE(INDEX) verbatim", () => {
  const withIndex = normalize({ root: nodeFor("TABLE RANGE SCAN", { name: "T_ORDERS(IDX_T_ORDERS_STATUS)" }) });
  assert.deepEqual(withIndex.root.relation, { name: "T_ORDERS(IDX_T_ORDERS_STATUS)", alias: null, indexName: null });

  const trimmed = normalize({ root: nodeFor("TABLE FULL SCAN", { name: "  T_ORDERS  " }) });
  assert.equal(trimmed.root.relation?.name, "T_ORDERS");

  for (const name of ["", "   "]) {
    const empty = normalize({ root: nodeFor("SORT", { name }) });
    assert.equal(empty.root.relation, null, "an empty NAME is not a relation");
  }

  const missing = normalize({ root: nodeFor("SORT", { name: null }) });
  assert.equal(missing.root.relation, null);
});

test("assigns stable path ids in child order", () => {
  const normalized = normalize({
    root: parsedOceanBaseNode({
      children: [
        parsedOceanBaseNode({ children: [parsedOceanBaseNode({ children: [parsedOceanBaseNode()] })] }),
        parsedOceanBaseNode(),
      ],
    }),
  });

  assert.deepEqual(
    flattenNodes(normalized.root).map((node) => node.id),
    ["0", "0.0", "0.0.0", "0.0.0.0", "0.1"],
  );
});

test("keeps OceanBase estimates out of the PostgreSQL cost and actual fields", () => {
  const normalized = normalize({
    root: nodeFor("TABLE FULL SCAN", {
      nodeId: 0,
      name: "T_ORDERS",
      estimatedRows: 250_000,
      estimatedTimeUs: 41_200,
      cost: 1_234,
      output: "output([T_ORDERS.ID])",
      extra: { filter: "filter([T_ORDERS.STATUS = 'PAID'])" },
    }),
  });

  const node = normalized.root;
  assert.equal(node.estimatedRows, 250_000);
  assert.equal(node.startupCost, null, "OceanBase has no PostgreSQL startup cost");
  assert.equal(node.totalCost, null, "EST.TIME(us) / COST are not PostgreSQL total costs");
  assert.equal(node.width, null);
  assert.equal(node.filter, null, "an unverified extended key is not promoted to a neutral predicate");
  assert.equal(node.joinType, null);
  assert.equal(node.joinCondition, null);
  assert.equal(node.indexCondition, null);
  assert.equal(node.sortKeys, null);
  assert.equal(node.groupKeys, null);
  assert.equal(node.actualRows, null);
  assert.equal(node.actualStartupTime, null);
  assert.equal(node.actualTotalTime, null);
  assert.equal(node.loops, null);

  assert.deepEqual(node.engineSpecific, {
    database: "oceanbase-oracle",
    oceanBase: {
      id: 0,
      operator: "TABLE FULL SCAN",
      name: "T_ORDERS",
      estimatedRows: 250_000,
      estimatedTimeUs: 41_200,
      cost: 1_234,
      output: "output([T_ORDERS.ID])",
    },
    extra: { filter: "filter([T_ORDERS.STATUS = 'PAID'])" },
  });
});

test("is deterministic and JSON serializable", () => {
  const plan = parsedOceanBasePlan({
    root: nodeFor("HASH JOIN", {
      estimatedRows: 10,
      children: [nodeFor("TABLE FULL SCAN", { name: "T_A" }), nodeFor("TABLE FULL SCAN", { name: "T_B" })],
    }),
  });

  const first = normalizeOceanBasePlan(plan);
  const second = normalizeOceanBasePlan(plan);

  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), first);
});
