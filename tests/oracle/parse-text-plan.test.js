import assert from "node:assert/strict";
import test from "node:test";
import { parseOracleTextPlan } from "../../src/core/oracle/parse-text-plan.js";
import { PlanParseError } from "../../src/core/errors.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";

function oracleInput(plan, mode = "estimated") {
  return createRawPlanInput({ database: "oracle", mode, format: "text", plan });
}

const FULL_PLAN = `Plan hash value: 246813579

+----+----------------------+----------+-------+--------+-------------+----------+
| Id | Operation            | Name     | Rows  | Bytes  | Cost (%CPU) | Time     |
+----+----------------------+----------+-------+--------+-------------+----------+
| 7  | SELECT STATEMENT     |          | 100   | 5200   | 18   (5)    | 00:00:01 |
| * 1|   HASH JOIN          |          | 100   | 5200   | 18   (5)    | 00:00:01 |
| 9  |     TABLE ACCESS FULL| ORDERS   | 1000  | 26000  | 8   (0)     | 00:00:01 |
| 2  |     TABLE ACCESS FULL| CUSTOMERS| 100   | 2600   | 9   (0)     | 00:00:01 |
+----+----------------------+----------+-------+--------+-------------+----------+

Predicate Information (identified by operation id):
---------------------------------------------------
   9 - filter("ORDERS"."STATUS" = 'OPEN')
   2 - access("CUSTOMERS"."ID" = "ORDERS"."CUSTOMER_ID")

Note
-----
- ignored tail
`;

// The parser must consume host-style CRLF without exposing carriage returns in
// operation, name, or predicate values.
test("parses DBMS_XPLAN table columns, predicate markers, CRLF and indentation tree", () => {
  const parsed = parseOracleTextPlan(oracleInput(FULL_PLAN.replaceAll("\n", "\r\n")));

  assert.equal(parsed.planHashValue, 246813579);
  assert.equal(parsed.root.id, 7);
  assert.equal(parsed.root.nodeType, "SELECT STATEMENT");
  assert.equal(parsed.root.estimatedRows, 100);
  assert.equal(parsed.root.bytes, 5200);
  assert.equal(parsed.root.cost, 18);
  assert.equal(parsed.root.cpuPercent, 5);
  assert.equal(parsed.root.time, "00:00:01");
  assert.equal(parsed.root.children.length, 1);

  const join = parsed.root.children[0];
  assert.equal(join.id, 1);
  assert.equal(join.predicateMarker, true);
  assert.equal(join.children[0].id, 9);
  assert.equal(join.children[1].id, 2);
  assert.deepEqual(join.children[0].predicates, ['filter("ORDERS"."STATUS" = \'OPEN\')']);
  assert.deepEqual(join.children[1].predicates, ['access("CUSTOMERS"."ID" = "ORDERS"."CUSTOMER_ID")']);
  assert.equal(join.children[0].indentation < join.children[1].indentation, false, "siblings may have equal indentation");
  assert.equal(join.children[0].nodeType, "TABLE ACCESS FULL");
});

test("strips a predicate marker from the operation label without losing indentation", () => {
  const plan = `| Id | Operation              | Rows |\n| 0  | SELECT STATEMENT       | 1    |\n| 1  |   * TABLE ACCESS FULL   | 10   |\n`;
  const parsed = parseOracleTextPlan(oracleInput(plan));
  assert.equal(parsed.root.children[0].nodeType, "TABLE ACCESS FULL");
  assert.equal(parsed.root.children[0].predicateMarker, true);
  assert.equal(parsed.root.children[0].indentation, 3);
});

test("accepts omitted optional DBMS_XPLAN columns and missing numeric cells", () => {
  const plan = `+----+---------------------+----------+------+
| Id | Operation           | Name     | Rows |
+----+---------------------+----------+------+
| 0  | SELECT STATEMENT    |          | -    |
| 4  |   TABLE ACCESS FULL | T_EMPTY  | 42   |
+----+---------------------+----------+------+
`;
  const parsed = parseOracleTextPlan(oracleInput(plan));
  assert.equal(parsed.root.bytes, null);
  assert.equal(parsed.root.cost, null);
  assert.equal(parsed.root.cpuPercent, null);
  assert.equal(parsed.root.time, null);
  assert.equal(parsed.root.children[0].estimatedRows, 42);
});

test("maps a separately reported CPU column when the header exposes one", () => {
  const plan = `| Id | Operation        | Rows | Cost | %CPU | Time     |\n| 0  | SELECT STATEMENT | 10   | 4    | 12   | 00:00:01 |\n`;
  const parsed = parseOracleTextPlan(oracleInput(plan));
  assert.equal(parsed.root.cost, 4);
  assert.equal(parsed.root.cpuPercent, 12);
});

test("tree parentage does not depend on display ids", () => {
  const parsed = parseOracleTextPlan(oracleInput(FULL_PLAN));
  assert.deepEqual(parsed.root.children.map((node) => node.id), [1]);
  assert.deepEqual(parsed.root.children[0].children.map((node) => node.id), [9, 2]);
});

test("rejects actual/runtime DBMS_XPLAN output even when the raw mode says estimated", () => {
  const actualPlan = `SQL_ID abc123\nChild number 0\n| Id | Operation | A-Rows | A-Time |\n| 0  | SELECT STATEMENT | 10 | 00:00:01 |\n`;
  assert.throws(
    () => parseOracleTextPlan(oracleInput(actualPlan)),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
});

test("rejects actual mode and a non-table payload", () => {
  assert.throws(
    () => parseOracleTextPlan(oracleInput(FULL_PLAN, "actual")),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
  assert.throws(
    () => parseOracleTextPlan(oracleInput("Plan hash value: 1\nno table here")),
    (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN",
  );
});
