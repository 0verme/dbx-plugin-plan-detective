import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { PlanParseError } from "../../src/core/errors.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";
import { SQLITE_PLAN_LIMITS, parseSqliteDetail, parseSqliteJsonPlan } from "../../src/core/sqlite/parse-json-plan.js";
import { flattenNodes } from "../../src/core/tree.js";
import { loadFixture } from "../helpers/fixtures.js";

function input(plan, overrides = {}) {
  return createRawPlanInput({
    database: "sqlite",
    mode: "estimated",
    format: "json",
    plan,
    ...overrides,
  });
}

test("SQLite parser accepts mode estimated and format json only", () => {
  const validRows = [{ id: 2, parent: 0, notused: 0, detail: "SCAN orders" }];
  assert.throws(
    () => parseSqliteJsonPlan(input(validRows, { mode: "actual" })),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
  assert.throws(
    () => parseSqliteJsonPlan(input("SCAN orders", { format: "text" })),
    (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN",
  );
});

test("reconstructs multi-root and nested parent-child EQP trees while preserving raw detail and extra fields", async () => {
  const compound = await loadFixture({ database: "sqlite", mode: "estimated", name: "compound-cte-subquery" });
  const result = analyzePlan(compound.input);

  assert.equal(result.normalized.root.kind, "structural");
  assert.equal(result.normalized.root.children.length, 1);
  const compoundRoot = result.normalized.root.children[0];
  assert.equal(compoundRoot.nodeType, "Compound Query");
  assert.equal(compoundRoot.kind, "setop");
  assert.equal(compoundRoot.children.length, 2);
  assert.equal(compoundRoot.children[0].nodeType, "Left-Most Subquery");
  assert.equal(compoundRoot.children[1].nodeType, "Union All");
  assert.equal(result.metrics.nodeCount, 9);
  assert.equal(result.metrics.maxDepth, 4);
  assert.equal(result.metrics.scanCount, 4);
  assert.equal(result.metrics.sequentialScanCount, 1);
  assert.equal(result.metrics.indexScanCount, 3);
});

test("classifies common SQLite EQP detail descriptions and keeps unknown steps neutral", () => {
  assert.equal(parseSqliteDetail("SCAN orders").nodeType, "Table Scan");
  assert.equal(parseSqliteDetail("SCAN TABLE orders AS o").alias, "o");
  assert.equal(parseSqliteDetail("SCAN customers USING INDEX idx_customers_region").nodeType, "Index Scan");
  assert.equal(parseSqliteDetail("SCAN customers USING COVERING INDEX idx_customers_region").usingCoveringIndex, true);
  assert.equal(parseSqliteDetail("SEARCH orders USING INDEX idx_orders (customer_id=?)").indexCondition, "customer_id=?");
  assert.equal(parseSqliteDetail("SEARCH orders USING COVERING INDEX idx_orders (customer_id=?)").usingCoveringIndex, true);
  assert.equal(parseSqliteDetail("SEARCH orders USING INTEGER PRIMARY KEY (rowid=?)").accessStrategy, "INTEGER PRIMARY KEY");
  assert.equal(parseSqliteDetail("SEARCH SUBQUERY 1 AS s USING AUTOMATIC COVERING INDEX (id=?)").usingAutomaticIndex, true);
  assert.equal(parseSqliteDetail("USE TEMP B-TREE FOR ORDER BY").tempBTreePurpose, "ORDER BY");
  assert.equal(parseSqliteDetail("USE TEMP B-TREE FOR GROUP BY").tempBTreePurpose, "GROUP BY");
  assert.equal(parseSqliteDetail("USE TEMP B-TREE FOR DISTINCT").tempBTreePurpose, "DISTINCT");
  assert.equal(parseSqliteDetail("BLOOM FILTER ON orders (customer_id=?)").filter, "customer_id=?");

  const unknown = parseSqliteDetail("CUSTOM FUTURE STEP alpha");
  assert.equal(unknown.recognized, false);
  assert.equal(unknown.nodeType, "CUSTOM FUTURE STEP alpha");

  const analyzed = analyzePlan(
    input([
      { id: 3, parent: 0, notused: 0, detail: "CUSTOM FUTURE STEP alpha", vendorHint: "keep-me" },
      { id: 7, parent: 3, notused: 0, detail: "SCAN orders" },
    ]),
  );
  assert.deepEqual(analyzed.normalized.unknownNodeTypes, ["CUSTOM FUTURE STEP alpha"]);
  const nodes = flattenNodes(analyzed.normalized.root);
  const customNode = nodes.find((node) => node.id === "0.0");
  assert.equal(customNode.kind, "unknown");
  assert.equal(customNode.engineSpecific.extra.vendorHint, "keep-me");
  assert.equal(customNode.children[0].kind, "seq_scan");
});

test("fails closed on malformed rows, duplicate ids, missing parents, self-parents, cycles, and size limits", () => {
  for (const invalidPlan of [
    [],
    "not-an-array",
    [null],
    [{ id: 0, parent: 0, notused: 0, detail: "SCAN t" }],
    [{ id: -1, parent: 0, notused: 0, detail: "SCAN t" }],
    [{ id: 2, parent: -1, notused: 0, detail: "SCAN t" }],
    [{ id: 2, parent: 2, notused: 0, detail: "SCAN t" }],
    [{ id: 2, parent: 99, notused: 0, detail: "SCAN t" }],
    [{ id: 2, parent: 0, notused: "bad", detail: "SCAN t" }],
    [{ id: 2, parent: 0, notused: 0, detail: "   " }],
    [
      { id: 2, parent: 0, notused: 0, detail: "SCAN a" },
      { id: 2, parent: 0, notused: 0, detail: "SCAN b" },
    ],
    [
      { id: 2, parent: 3, notused: 0, detail: "SCAN a" },
      { id: 3, parent: 2, notused: 0, detail: "SCAN b" },
    ],
    [
      { id: 1, parent: 0, notused: 0, detail: "SCAN root" },
      { id: 2, parent: 3, notused: 0, detail: "SCAN cycle_a" },
      { id: 3, parent: 2, notused: 0, detail: "SCAN cycle_b" },
    ],
  ]) {
    assert.throws(
      () => parseSqliteJsonPlan(input(invalidPlan)),
      (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN",
    );
  }

  const tooManyRows = Array.from({ length: SQLITE_PLAN_LIMITS.rows + 1 }, (_, index) => ({
    id: index + 1,
    parent: 0,
    notused: 0,
    detail: "SCAN t",
  }));
  assert.throws(
    () => parseSqliteJsonPlan(input(tooManyRows)),
    (error) => error instanceof PlanParseError && error.code === "PLAN_TOO_LARGE",
  );

  const tooDeepRows = Array.from({ length: SQLITE_PLAN_LIMITS.depth + 1 }, (_, index) => ({
    id: index + 1,
    parent: index,
    notused: 0,
    detail: "SCAN t",
  }));
  assert.throws(
    () => parseSqliteJsonPlan(input(tooDeepRows)),
    (error) => error instanceof PlanParseError && error.code === "PLAN_TOO_DEEP",
  );
});
