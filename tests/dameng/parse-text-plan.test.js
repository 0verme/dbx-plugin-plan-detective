import assert from "node:assert/strict";
import test from "node:test";
import { PlanInputError, PlanParseError } from "../../src/core/errors.js";
import { parseDamengTextPlan } from "../../src/core/dameng/parse-text-plan.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";

function input(plan, overrides = {}) {
  return createRawPlanInput({ database: "dameng", mode: "estimated", format: "text", plan, ...overrides });
}

const PLAN = `1 #NSET2: [1, 100, 56]
2   #NEST LOOP INDEX JOIN2: [2, 100, 56]
4     #CSCN2: [1, 200, 52]; INDEX_T1(T1 as A); btr_scan(1)
9     #SSEK2: [1, 50000, 4]; scan_type(ASC), IDX_T2(T2 as B), scan_range[A.ID,B.ID]

Predicate Information ( identified by operation id):
---------------------------------------------------
2 - access(A.ID = B.ID)
4 - filter(A.STATUS = 'OPEN')
`;

test("parses Dameng operation rows, tuple fields, indentation and predicates by operation id", () => {
  const parsed = parseDamengTextPlan(input(PLAN.replaceAll("\n", "\r\n")));

  assert.equal(parsed.database, "dameng");
  assert.equal(parsed.format, "text");
  assert.equal(parsed.mode, "estimated");
  assert.equal(parsed.root.nodeType, "NSET2");
  assert.equal(parsed.root.id, 1);
  assert.equal(parsed.root.cost, 1);
  assert.equal(parsed.root.estimatedRows, 100);
  assert.equal(parsed.root.bytesPerRow, 56);
  assert.equal(parsed.root.children[0].nodeType, "NEST LOOP INDEX JOIN2");
  assert.equal(parsed.root.children[0].children[0].id, 4);
  assert.equal(parsed.root.children[0].children[1].id, 9);
  assert.deepEqual(parsed.root.children[0].predicates, ["access(A.ID = B.ID)"]);
  assert.deepEqual(parsed.root.children[0].children[0].predicates, ["filter(A.STATUS = 'OPEN')"]);
  assert.equal(parsed.root.children[0].children[1].indentation > parsed.root.children[0].indentation, true);
});

test("uses the display column of # so multi-digit operation ids remain siblings", () => {
  const parsed = parseDamengTextPlan(
    input(`1   #NSET2: [1, 1, 1]
2     #PRJT2: [1, 1, 1]
9       #NEST LOOP JOIN2: [1, 1, 1]
10      #CSCN2: [1, 1, 1]
11      #CSCN2: [1, 1, 1]
`),
  );

  assert.deepEqual(parsed.root.children.map((child) => child.nodeType), ["PRJT2"]);
  assert.deepEqual(parsed.root.children[0].children.map((child) => child.id), [9, 10, 11]);
});

test("keeps the operation detail verbatim and tolerates unknown operators", () => {
  const parsed = parseDamengTextPlan(
    input(`1 #NSET2: [1, 1, 64]
2   #FUTURE EXCHANGE: [7, 42, 64]; future_flag(TRUE)
3     #CSCN2: [1, 42, 64]; INDEX_T(T)
`),
  );

  assert.equal(parsed.root.children[0].nodeType, "FUTURE EXCHANGE");
  assert.equal(parsed.root.children[0].detail, "future_flag(TRUE)");
  assert.equal(parsed.root.children[0].children[0].nodeType, "CSCN2");
});

test("keeps malformed tuple values as missing fields and evidence", () => {
  const parsed = parseDamengTextPlan(
    input(`1 #NSET2: [1, -, -]
2   #CSCN2: [bad, 20000, 64]; INDEX_T(T)
`),
  );

  assert.equal(parsed.root.estimatedRows, null);
  assert.equal(parsed.root.bytesPerRow, null);
  assert.equal(parsed.root.children[0].cost, null);
  assert.equal(parsed.root.children[0].estimatedRows, 20000);
  assert.deepEqual(parsed.root.children[0].extra, { estimate: "[bad, 20000, 64]" });
});

test("rejects actual mode, runtime markers and malformed tree roots", () => {
  assert.throws(
    () => parseDamengTextPlan(input(PLAN, { mode: "actual" })),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
  assert.throws(
    () => parseDamengTextPlan(input("EXPLAIN ANALYZE\n1 #NSET2: [1, 1, 1]")),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
  assert.throws(
    () => parseDamengTextPlan(input("1 #NSET2: [1, 1, 1]\n2 #CSCN2: [1, 1, 1]")),
    (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN",
  );
  assert.throws(
    () => parseDamengTextPlan(input("not a plan")),
    (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN",
  );
  assert.throws(
    () => parseDamengTextPlan(input("1 #NSET2: [1, 1, 1]\nnot an operation row")),
    (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN",
  );
});

test("rejects a non-text payload before parsing", () => {
  assert.throws(
    () => parseDamengTextPlan({ database: "dameng", mode: "estimated", format: "text" }),
    (error) => error instanceof PlanInputError && error.code === "INVALID_RAW_PLAN_INPUT",
  );
  assert.throws(
    () => parseDamengTextPlan(input({})),
    (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN",
  );
});

test("is deterministic and JSON serializable", () => {
  const first = parseDamengTextPlan(input(PLAN));
  const second = parseDamengTextPlan(input(PLAN));
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});
