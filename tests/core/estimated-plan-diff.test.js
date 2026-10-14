import assert from "node:assert/strict";
import test from "node:test";
import { diffEstimatedPlans } from "../../src/core/diff/estimated-plan-diff.js";
import { normalizedNode, normalizedPlan } from "../helpers/plan-builders.js";

function node(id, overrides = {}) {
  return normalizedNode({ id, ...overrides });
}

function analysis(root, { database = "postgresql", mode = "estimated", format = "json" } = {}) {
  return {
    status: "structured",
    normalized: normalizedPlan({ database, mode, format, root }),
  };
}

function relation(name, alias = null, indexName = null) {
  return { name, alias, indexName };
}

function change(match, field) {
  return match.changes.find((entry) => entry.field === field);
}

test("same estimated plan has deterministic JSON-serializable output and no false field changes", () => {
  const plan = analysis(node("0", {
    relation: relation("orders", "o", "orders_pkey"),
    estimatedRows: 12,
    startupCost: 0.1,
    totalCost: 2.4,
  }));
  const before = structuredClone(plan);

  const first = diffEstimatedPlans(plan, plan);
  const second = diffEstimatedPlans(plan, plan);

  assert.equal(first.status, "comparable");
  assert.deepEqual(first, second);
  assert.deepEqual(first.matches.map(({ beforeId, afterId, changes }) => ({ beforeId, afterId, changes })), [
    { beforeId: "0", afterId: "0", changes: [] },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.deepEqual(plan, before, "comparison must not mutate either analysis");
});

test("matches Seq Scan to Index Scan by unique relation identity and reports field values, not percentages", () => {
  const before = analysis(node("0", {
    kind: "seq_scan",
    nodeType: "Seq Scan",
    relation: relation("orders", "o"),
    estimatedRows: 1000,
    totalCost: 90,
  }));
  const after = analysis(node("0", {
    kind: "index_scan",
    nodeType: "Index Scan",
    relation: relation("orders", "o", "orders_status_idx"),
    estimatedRows: 40,
    totalCost: 8,
    indexCondition: "(status = 'open')",
  }));

  const result = diffEstimatedPlans(before, after);
  assert.equal(result.matches.length, 1);
  const [match] = result.matches;
  assert.equal(match.evidence.method, "qualified-relation-name-and-alias");
  assert.deepEqual(match.changes.map(({ field }) => field), [
    "operator.kind",
    "operator.nodeType",
    "relation.indexName",
    "estimatedRows",
    "indexCondition",
  ]);
  assert.deepEqual(change(match, "estimatedRows"), { field: "estimatedRows", before: 1000, after: 40 });
  assert.equal(Object.hasOwn(match, "percentChange"), false);
});

test("PostgreSQL scan schema participates in identity, preventing cross-schema false matches", () => {
  const pgScan = (schema, alias = "orders") => analysis(node("0", {
    relation: relation("orders", alias),
    engineSpecific: { database: "postgresql", extra: { Schema: schema } },
  }));

  const sameSchema = diffEstimatedPlans(pgScan("tenant_a", "old_alias"), pgScan("tenant_a", "new_alias"));
  assert.equal(sameSchema.matches.length, 1, "alias fallback remains scoped to the same schema");
  assert.equal(sameSchema.matches[0].evidence.method, "unique-qualified-relation-name");

  const differentSchemas = diffEstimatedPlans(pgScan("tenant_a"), pgScan("tenant_b"));
  assert.equal(differentSchemas.matches.length, 0);
  assert.deepEqual(differentSchemas.unmatched.baseline, [{ id: "0", reasonCode: "NO_UNIQUE_COUNTERPART" }]);
  assert.deepEqual(differentSchemas.unmatched.current, [{ id: "0", reasonCode: "NO_UNIQUE_COUNTERPART" }]);
});

test("rows and costs never define identity; missing rows remain distinct from zero", () => {
  const before = analysis(node("0", {
    kind: "result",
    nodeType: "Result",
    estimatedRows: null,
    totalCost: null,
  }));
  const after = analysis(node("7", {
    kind: "result",
    nodeType: "Result",
    estimatedRows: 0,
    totalCost: 0,
  }));

  const result = diffEstimatedPlans(before, after);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].evidence.method, "exact-semantic-subtree");
  assert.deepEqual(change(result.matches[0], "estimatedRows"), { field: "estimatedRows", before: null, after: 0 });
  assert.equal(change(result.matches[0], "totalCost"), undefined, "cost is omitted until comparability context is available");
  assert.doesNotMatch(JSON.stringify(result), /Infinity|NaN/);
});

test("an inserted or removed Sort is unmatched while the relation scan stays matched", () => {
  const scanBefore = node("0", { relation: relation("orders", "o") });
  const scanAfter = node("0.0", { relation: relation("orders", "o") });
  const before = analysis(scanBefore);
  const after = analysis(node("0", {
    kind: "sort",
    nodeType: "Sort",
    sortKeys: ["o.created_at DESC"],
    children: [scanAfter],
  }));

  const inserted = diffEstimatedPlans(before, after);
  assert.deepEqual(inserted.matches.map(({ beforeId, afterId }) => [beforeId, afterId]), [["0", "0.0"]]);
  assert.deepEqual(inserted.unmatched.baseline, []);
  assert.deepEqual(inserted.unmatched.current, [{ id: "0", reasonCode: "NO_UNIQUE_COUNTERPART" }]);

  const removed = diffEstimatedPlans(after, before);
  assert.deepEqual(removed.matches.map(({ beforeId, afterId }) => [beforeId, afterId]), [["0.0", "0"]]);
  assert.deepEqual(removed.unmatched.baseline, [{ id: "0", reasonCode: "NO_UNIQUE_COUNTERPART" }]);
  assert.deepEqual(removed.unmatched.current, []);
});

test("a retained Sort reports sort-key changes while matching its relation input", () => {
  const before = analysis(node("0", {
    kind: "sort",
    nodeType: "Sort",
    sortKeys: ["o.created_at"],
    children: [node("0.0", { relation: relation("orders", "o") })],
  }));
  const after = analysis(node("0", {
    kind: "sort",
    nodeType: "Sort",
    sortKeys: ["o.created_at DESC"],
    children: [node("0.0", { relation: relation("orders", "o") })],
  }));

  const result = diffEstimatedPlans(before, after);
  const sortMatch = result.matches.find(({ beforeId }) => beforeId === "0");
  assert.deepEqual(change(sortMatch, "sortKeys"), {
    field: "sortKeys",
    before: ["o.created_at"],
    after: ["o.created_at DESC"],
  });
});

test("Join algorithm changes and child reorder use matched descendant relations, not child positions", () => {
  const before = analysis(node("0", {
    kind: "nested_loop",
    nodeType: "Nested Loop",
    joinType: "Inner",
    joinCondition: "(o.customer_id = c.id)",
    children: [
      node("0.0", { relation: relation("orders", "o") }),
      node("0.1", { relation: relation("customers", "c") }),
    ],
  }));
  const after = analysis(node("0", {
    kind: "hash_join",
    nodeType: "Hash Join",
    joinType: "Inner",
    joinCondition: "(o.id = c.id)",
    children: [
      node("0.0", { relation: relation("customers", "c") }),
      node("0.1", { relation: relation("orders", "o") }),
    ],
  }));

  const result = diffEstimatedPlans(before, after);
  assert.deepEqual(result.matches.map(({ beforeId, afterId }) => [beforeId, afterId]), [
    ["0", "0"],
    ["0.0", "0.1"],
    ["0.1", "0.0"],
  ]);
  const join = result.matches.find(({ beforeId }) => beforeId === "0");
  assert.equal(join.evidence.method, "descendant-scan-set");
  assert.deepEqual(join.changes.map(({ field }) => field), ["operator.kind", "operator.nodeType", "joinCondition"]);
});

test("self-join aliases distinguish repeated relations, but identical or renamed repeated aliases stay ambiguous", () => {
  const selfJoin = (leftAlias, rightAlias, reverse = false) => analysis(node("0", {
    kind: "nested_loop",
    nodeType: "Nested Loop",
    children: (reverse ? [rightAlias, leftAlias] : [leftAlias, rightAlias]).map((alias, index) =>
      node(`0.${index}`, { relation: relation("employees", alias) })),
  }));

  const stableAliases = diffEstimatedPlans(
    selfJoin("manager", "report"),
    selfJoin("manager", "report", true),
  );
  assert.equal(stableAliases.ambiguous.length, 0);
  assert.deepEqual(stableAliases.matches.map(({ beforeId, afterId }) => [beforeId, afterId]), [
    ["0", "0"],
    ["0.0", "0.1"],
    ["0.1", "0.0"],
  ]);

  const repeatedWithoutAliases = diffEstimatedPlans(
    selfJoin(null, null),
    selfJoin(null, null),
  );
  assert.equal(repeatedWithoutAliases.matches.length, 0);
  assert.equal(repeatedWithoutAliases.ambiguous.length, 1);
  assert.deepEqual(repeatedWithoutAliases.ambiguous[0].beforeIds, ["0.0", "0.1"]);
  assert.deepEqual(repeatedWithoutAliases.ambiguous[0].afterIds, ["0.0", "0.1"]);
  assert.equal(repeatedWithoutAliases.unmatched.baseline[0].reasonCode, "DESCENDANT_IDENTITY_AMBIGUOUS");

  const changedAliases = diffEstimatedPlans(
    selfJoin("manager", "report"),
    selfJoin("lead", "staff"),
  );
  assert.equal(changedAliases.matches.length, 0);
  assert.equal(changedAliases.ambiguous.length, 1);
});

test("duplicate operators over the same sources are reported as ambiguous, never paired by order", () => {
  const before = analysis(node("0", {
    kind: "sort",
    nodeType: "Sort",
    children: [node("0.0", {
      kind: "sort",
      nodeType: "Sort",
      children: [node("0.0.0", { relation: relation("orders", "o") })],
    })],
  }));
  const after = analysis(node("0", {
    kind: "sort",
    nodeType: "Sort",
    children: [node("0.0", { relation: relation("orders", "o") })],
  }));

  const result = diffEstimatedPlans(before, after);
  assert.equal(result.matches.length, 1, "the relation scan is independently matchable");
  assert.equal(result.ambiguous.length, 1);
  assert.deepEqual(result.ambiguous[0].beforeIds, ["0", "0.0"]);
  assert.deepEqual(result.ambiguous[0].afterIds, ["0"]);
});

test("accepts only complete structured same-family Estimated plans", () => {
  const postgres = analysis(node("0", { relation: relation("orders", "o") }));
  const mysql = analysis(node("0", { relation: relation("orders", "o") }), { database: "mysql" });
  const actual = analysis(node("0", { relation: relation("orders", "o") }), { mode: "actual" });
  const sqlServer = analysis(node("0", { relation: relation("orders", "o") }), { database: "sqlserver" });

  assert.equal(diffEstimatedPlans(postgres, mysql).reasonCode, "DATABASE_MISMATCH");
  assert.equal(diffEstimatedPlans(actual, actual).reasonCode, "MODE_NOT_ESTIMATED");
  assert.equal(diffEstimatedPlans(sqlServer, sqlServer).reasonCode, "UNSUPPORTED_DATABASE");
  assert.equal(diffEstimatedPlans({ status: "truncated" }, postgres).reasonCode, "PLAN_TRUNCATED");
  assert.equal(diffEstimatedPlans({ status: "raw-only" }, postgres).reasonCode, "RAW_ONLY");
  assert.equal(diffEstimatedPlans({ status: "error" }, postgres).reasonCode, "ANALYSIS_FAILED");
  assert.equal(diffEstimatedPlans({ status: "loading" }, postgres).reasonCode, "ANALYSIS_NOT_READY");
  assert.equal(diffEstimatedPlans(null, postgres).reasonCode, "INVALID_ANALYSIS");
});

test("accepts a snapshot-view session wrapper and reports unsupported formats", () => {
  const session = analysis(node("0", { relation: relation("orders", "o") }));
  const wrapped = { snapshot: {}, session: { status: "structured", analysis: session } };
  assert.equal(diffEstimatedPlans(wrapped, wrapped).status, "comparable");

  const textPlan = analysis(node("0", { relation: relation("orders", "o") }), { format: "text" });
  assert.equal(diffEstimatedPlans(textPlan, textPlan).reasonCode, "UNSUPPORTED_FORMAT");
});
