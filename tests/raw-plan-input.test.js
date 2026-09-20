import assert from "node:assert/strict";
import test from "node:test";
import { PlanInputError } from "../src/core/errors.js";
import { createRawPlanInput, validateRawPlanInput } from "../src/core/raw-plan-input.js";

const MINIMAL = { database: "postgresql", mode: "estimated", format: "json", plan: [] };

test("accepts the minimal contract", () => {
  assert.deepEqual(createRawPlanInput(MINIMAL), {
    database: "postgresql",
    mode: "estimated",
    format: "json",
    plan: [],
  });
});

test("keeps optional sql and databaseVersion", () => {
  const input = createRawPlanInput({ ...MINIMAL, sql: "select 1", databaseVersion: "15.19" });
  assert.equal(input.sql, "select 1");
  assert.equal(input.databaseVersion, "15.19");
});

test("drops unknown top-level properties instead of failing", () => {
  const input = createRawPlanInput({ ...MINIMAL, dbxTransport: { requestId: "abc" } });
  assert.deepEqual(Object.keys(input).sort(), ["database", "format", "mode", "plan"]);
});

test("reports every contract violation in a single error", () => {
  assert.throws(
    () => createRawPlanInput({ database: "mysql", mode: "profiled", format: "text" }),
    (error) => {
      assert.ok(error instanceof PlanInputError);
      assert.equal(error.code, "INVALID_RAW_PLAN_INPUT");
      assert.match(error.message, /database must be one of postgresql/);
      assert.match(error.message, /mode must be one of estimated, actual/);
      assert.match(error.message, /format must be one of json/);
      assert.match(error.message, /plan is required/);
      return true;
    },
  );
});

test("rejects non-object inputs", () => {
  for (const value of [null, undefined, "plan", 42, [MINIMAL]]) {
    assert.throws(() => createRawPlanInput(value), PlanInputError);
    assert.equal(validateRawPlanInput(value).length, 1);
  }
});

test("rejects wrong optional field types", () => {
  const problems = validateRawPlanInput({ ...MINIMAL, sql: 42, databaseVersion: { major: 15 } });
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /sql must be a string/);
  assert.match(problems.join("\n"), /databaseVersion must be a string/);
});

test("validateRawPlanInput reports without throwing", () => {
  assert.deepEqual(validateRawPlanInput(MINIMAL), []);
  assert.ok(validateRawPlanInput({ ...MINIMAL, mode: "actual" }).length === 0);
  assert.equal(validateRawPlanInput({ ...MINIMAL, plan: null }).length, 1);
});
