import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { parseDuckDbTextPlan } from "../../src/core/duckdb/parse-text-plan.js";
import { PlanParseError } from "../../src/core/errors.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";
import { loadFixture } from "../helpers/fixtures.js";

function input(plan, overrides = {}) {
  return createRawPlanInput({
    database: "duckdb",
    mode: "estimated",
    format: "text",
    plan,
    ...overrides,
  });
}

test("DuckDB parser accepts mode estimated and format text only", () => {
  const validText = "┌──────────┐\n│ SEQ_SCAN │\n└──────────┘";
  assert.throws(
    () => parseDuckDbTextPlan(input(validText, { mode: "actual" })),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
  assert.throws(
    () => parseDuckDbTextPlan(input([], { format: "json" })),
    (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN",
  );
});

test("parses official DuckDB multi-branch box tree, wrapped Filters, and EC estimates", async () => {
  const official = await loadFixture({ database: "duckdb", mode: "estimated", name: "official-hash-join-filter" });
  const result = analyzePlan(official.input);

  assert.equal(result.parsed.planHeader, "Physical Plan");
  assert.equal(result.normalized.root.nodeType, "PROJECTION");
  assert.equal(result.normalized.root.kind, "project");
  const hashJoin = result.normalized.root.children[0];
  assert.equal(hashJoin.nodeType, "HASH_JOIN");
  assert.equal(hashJoin.kind, "hash_join");
  assert.equal(hashJoin.joinType, "INNER");
  assert.equal(hashJoin.joinCondition, "sid = sid");
  assert.equal(hashJoin.estimatedRows, 1);
  assert.equal(hashJoin.children.length, 2);

  const leftScan = hashJoin.children[0];
  assert.equal(leftScan.nodeType, "SEQ_SCAN");
  assert.equal(leftScan.kind, "seq_scan");
  assert.equal(leftScan.relation.name, "exams");
  assert.equal(leftScan.estimatedRows, 3);

  const rightFilter = hashJoin.children[1];
  assert.equal(rightFilter.nodeType, "FILTER");
  assert.equal(rightFilter.kind, "filter");
  assert.equal(rightFilter.filter, "prefix(name, 'Ma')");
  const studentsScan = rightFilter.children[0];
  assert.equal(studentsScan.relation.name, "students");
  assert.equal(studentsScan.filter, "name>=Ma AND name<Mb AND name IS NOT NULL");
  assert.equal(studentsScan.estimatedRows, 1);
});

test("parses modern rounded-corner boxes with horizontal routing bus and ~N rows cardinality", async () => {
  const rounded = await loadFixture({ database: "duckdb", mode: "estimated", name: "rounded-box-group-by.synthetic" });
  const result = analyzePlan(rounded.input);

  assert.equal(result.normalized.root.kind, "aggregate");
  assert.deepEqual(result.normalized.root.groupKeys, ["region"]);
  assert.equal(result.normalized.root.estimatedRows, 12);

  const join = result.normalized.root.children[0];
  assert.equal(join.kind, "hash_join");
  assert.equal(join.children.length, 2);
  assert.equal(join.children[0].kind, "seq_scan");
  assert.equal(join.children[0].relation.name, "customers");
  assert.equal(join.children[1].kind, "scan", "PARQUET_SCAN is classified as a neutral scan");
  assert.equal(join.children[1].relation.name, "orders.parquet");
});

test("rejects EXPLAIN ANALYZE output and malformed or disconnected box trees", () => {
  const analyzeBox = "┌──────────────────┐\n│ EXPLAIN_ANALYZE  │\n└──────────────────┘";
  assert.throws(
    () => parseDuckDbTextPlan(input(analyzeBox)),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );

  const timedBox = "╭─ Seq Scan ───────╮\n│ Table: orders    │\n│ 100 rows   0.02s │\n╰──────────────────╯";
  assert.throws(
    () => parseDuckDbTextPlan(input(timedBox)),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );

  for (const invalidText of [
    "   ",
    "not a duckdb box tree",
    "┌──────────┐\n│          │\n└──────────┘",
    "┌──────────┐ ┌──────────┐\n│ SEQ_SCAN │ │ SEQ_SCAN │\n└──────────┘ └──────────┘",
  ]) {
    assert.throws(
      () => parseDuckDbTextPlan(input(invalidText)),
      (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN",
    );
  }
});
