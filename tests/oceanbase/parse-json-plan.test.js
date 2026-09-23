import assert from "node:assert/strict";
import test from "node:test";
import { PlanInputError, PlanParseError } from "../../src/core/errors.js";
import { parseOceanBaseJsonPlan } from "../../src/core/oceanbase/parse-json-plan.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";

/**
 * Parser contract for the shared OceanBase Oracle / MySQL compatibility-mode
 * `EXPLAIN FORMAT=JSON` parser.
 *
 * The parser owns the engine-native shape: `ID` / `OPERATOR` / `NAME` /
 * `EST.ROWS` / `EST.TIME(us)` / `COST` / `output` / `CHILD_<n>`. Everything else
 * is preserved verbatim, and nothing about a node may be invented.
 */

/** @param {unknown} plan @param {{ mode?: string, format?: string, database?: string }} [overrides] */
function input(plan, overrides = {}) {
  return createRawPlanInput({
    database: "oceanbase-oracle",
    mode: "estimated",
    format: "json",
    plan,
    ...overrides,
  });
}

const ROOT = {
  ID: 0,
  OPERATOR: "HASH JOIN ",
  NAME: "",
  "EST.ROWS": 1,
  "EST.TIME(us)": 8,
  output: "output([T101.C1], [T102.C1])",
  CHILD_1: {
    ID: 1,
    OPERATOR: "TABLE FULL SCAN",
    NAME: "T102",
    "EST.ROWS": 1,
    "EST.TIME(us)": 4,
    output: "output([T102.C1])",
  },
  CHILD_2: {
    ID: 2,
    OPERATOR: "TABLE FULL SCAN",
    NAME: "T101",
    "EST.ROWS": 1,
    "EST.TIME(us)": 4,
    output: "output([T101.C1])",
  },
};

test("parses a root node with its children and engine fields", () => {
  const parsed = parseOceanBaseJsonPlan(input(ROOT));

  assert.equal(parsed.database, "oceanbase-oracle");
  assert.equal(parsed.format, "json");
  assert.equal(parsed.mode, "estimated");

  // The engine pads OPERATOR; the label is the operator name, not the padding.
  assert.equal(parsed.root.nodeType, "HASH JOIN");
  assert.equal(parsed.root.operator, "HASH JOIN");
  assert.equal(parsed.root.nodeId, 0);
  assert.equal(parsed.root.name, "");
  assert.equal(parsed.root.estimatedRows, 1);
  assert.equal(parsed.root.estimatedTimeUs, 8);
  assert.equal(parsed.root.cost, null, "COST is absent here and must not be invented");
  assert.equal(parsed.root.output, "output([T101.C1], [T102.C1])");
  assert.deepEqual(parsed.root.extra, {});

  assert.deepEqual(
    parsed.root.children.map((child) => [child.nodeId, child.nodeType, child.name, child.estimatedRows]),
    [
      [1, "TABLE FULL SCAN", "T102", 1],
      [2, "TABLE FULL SCAN", "T101", 1],
    ],
  );
});

test("orders children by the numeric CHILD_<n> suffix, not by payload or lexical order", () => {
  const parsed = parseOceanBaseJsonPlan(
    input({
      ID: 0,
      OPERATOR: "UNION ALL",
      CHILD_1: { ID: 1, OPERATOR: "TABLE FULL SCAN", NAME: "T_A" },
      CHILD_10: { ID: 10, OPERATOR: "TABLE FULL SCAN", NAME: "T_B" },
      CHILD_2: { ID: 2, OPERATOR: "TABLE FULL SCAN", NAME: "T_C" },
    }),
  );

  assert.deepEqual(
    parsed.root.children.map((child) => child.name),
    ["T_A", "T_C", "T_B"],
    "CHILD_10 belongs after CHILD_2",
  );
  assert.deepEqual(
    parsed.root.children.map((child) => child.nodeId),
    [1, 2, 10],
  );
});

test("accepts any number of children", () => {
  const parsed = parseOceanBaseJsonPlan(
    input({
      ID: 0,
      OPERATOR: "UNION ALL",
      CHILD_1: { OPERATOR: "TABLE FULL SCAN", NAME: "T_A" },
      CHILD_2: { OPERATOR: "TABLE FULL SCAN", NAME: "T_B" },
      CHILD_3: { OPERATOR: "TABLE FULL SCAN", NAME: "T_C" },
      CHILD_4: { OPERATOR: "TABLE FULL SCAN", NAME: "T_D" },
    }),
  );

  assert.equal(parsed.root.children.length, 4);
  assert.deepEqual(
    parsed.root.children.map((child) => child.name),
    ["T_A", "T_B", "T_C", "T_D"],
  );
});

test("keeps an unknown operator, its subtree and its unknown members", () => {
  const parsed = parseOceanBaseJsonPlan(
    input({
      ID: 0,
      OPERATOR: "PX FUTURE SHUFFLE",
      "EST.ROWS": 42,
      "EST.TIME(us)": 7,
      worker_count: 4,
      CHILD_1: { ID: 1, OPERATOR: "TABLE RANGE SCAN", NAME: "T_ORDERS(IDX)", "EST.ROWS": 42 },
    }),
  );

  assert.equal(parsed.root.nodeType, "PX FUTURE SHUFFLE");
  assert.equal(parsed.root.children.length, 1);
  assert.equal(parsed.root.children[0].nodeType, "TABLE RANGE SCAN");
  assert.deepEqual(parsed.root.extra, { worker_count: 4 });
});

test("preserves unknown fields of every JSON type without interpreting them", () => {
  const parsed = parseOceanBaseJsonPlan(
    input({
      ID: 0,
      OPERATOR: "EXCHANGE OUT DISTRIBUTED",
      NAME: "",
      "EST.ROWS": 64,
      "EST.TIME(us)": 21,
      output: "output([T_ORDERS.ID])",
      use_hash: true,
      px_expected_worker_count: 4,
      px_worker_count: null,
      gi_partition_id: [0, 1, 2, 3],
      plan_notes: { outline: "USE_HASH(T_ORDERS)", plan_type: 1 },
      filter: "filter([T_ORDERS.STATUS = 'PAID'])",
    }),
  );

  assert.deepEqual(parsed.root.extra, {
    use_hash: true,
    px_expected_worker_count: 4,
    px_worker_count: null,
    gi_partition_id: [0, 1, 2, 3],
    plan_notes: { outline: "USE_HASH(T_ORDERS)", plan_type: 1 },
    filter: "filter([T_ORDERS.STATUS = 'PAID'])",
  });
  // The extended `filter` member is evidence, not a promoted neutral predicate.
  assert.equal(parsed.root.nodeType, "EXCHANGE OUT DISTRIBUTED");
});

test("degrades gracefully when optional fields are missing", () => {
  const parsed = parseOceanBaseJsonPlan(
    input({
      OPERATOR: "MATERIAL",
      CHILD_1: { OPERATOR: "TABLE FULL SCAN" },
      CHILD_2: { "EST.ROWS": 5 },
      CHILD_9: null,
    }),
  );

  assert.equal(parsed.root.nodeType, "MATERIAL");
  assert.equal(parsed.root.nodeId, null);
  assert.equal(parsed.root.name, null);
  assert.equal(parsed.root.estimatedRows, null);
  assert.equal(parsed.root.estimatedTimeUs, null);
  assert.equal(parsed.root.cost, null);
  assert.equal(parsed.root.output, null);

  // A node the engine did not label keeps its subtree and gets a placeholder.
  assert.equal(parsed.root.children.length, 2);
  assert.deepEqual(
    parsed.root.children.map((child) => [child.nodeType, child.operator, child.estimatedRows]),
    [
      ["TABLE FULL SCAN", "TABLE FULL SCAN", null],
      ["Plan", null, 5],
    ],
  );

  // A non-object CHILD_<n> is not a tree edge; it is preserved as evidence.
  assert.deepEqual(parsed.root.extra, { CHILD_9: null });
});

test("keeps a non-numeric estimate out of the numeric field instead of coercing it", () => {
  const parsed = parseOceanBaseJsonPlan(
    input({
      ID: "0",
      OPERATOR: "TABLE FULL SCAN",
      NAME: "T_ORDERS",
      "EST.ROWS": "250000",
      "EST.TIME(us)": null,
      COST: 1234,
    }),
  );

  assert.equal(parsed.root.nodeId, null, "a string ID is not a number");
  assert.equal(parsed.root.estimatedRows, null, "a numeric string is not a JSON number");
  assert.equal(parsed.root.estimatedTimeUs, null);
  assert.equal(parsed.root.cost, 1234);
  assert.deepEqual(parsed.root.extra, { ID: "0", "EST.ROWS": "250000" }, "unusable values are preserved, explicit nulls are not");
});

test("rejects payloads that are not a plan node", () => {
  const cases = [
    ["string", "unexpected format"],
    ["number", 42],
    ["array", [ROOT]],
    ["empty object", {}],
    ["unrelated object", { status: "ok", rows: [] }],
  ];

  for (const [label, plan] of cases) {
    assert.throws(
      () => parseOceanBaseJsonPlan(input(plan)),
      (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN",
      `${label} must be rejected as MALFORMED_PLAN`,
    );
  }
});

test("rejects a missing plan payload before it reaches the parser", () => {
  for (const plan of [null, undefined]) {
    assert.throws(
      () => input(plan),
      (error) => error instanceof PlanInputError && error.code === "INVALID_RAW_PLAN_INPUT",
      `${String(plan)} must be rejected by the RawPlanInput contract`,
    );
  }
});

test("rejects an actual-mode OceanBase plan", () => {
  assert.throws(
    () => parseOceanBaseJsonPlan(input(ROOT, { mode: "actual" })),
    (error) =>
      error instanceof PlanParseError &&
      error.code === "MODE_MISMATCH" &&
      error.message === 'OceanBase Oracle plans are parsed in mode "estimated" only; the host never returns runtime counters for them.',
  );
});

test("rejects a RawPlanInput that violates the shared contract", () => {
  assert.throws(
    () => parseOceanBaseJsonPlan({ database: "oceanbase-oracle", mode: "estimated", format: "json" }),
    (error) => error instanceof PlanInputError && error.code === "INVALID_RAW_PLAN_INPUT",
  );
});

test("is deterministic and JSON serializable", () => {
  const first = parseOceanBaseJsonPlan(input(ROOT));
  const second = parseOceanBaseJsonPlan(input(ROOT));

  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), first);
});
