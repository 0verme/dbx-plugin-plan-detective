import assert from "node:assert/strict";
import test from "node:test";
import { PlanInputError, PlanParseError } from "../../src/core/errors.js";
import { parsePostgresJsonPlan } from "../../src/core/postgres/parse-json-plan.js";
import { chainNode, depthOf, flattenNodes } from "../helpers/plan-tree.js";

/** Build the PostgreSQL `EXPLAIN (FORMAT JSON)` array envelope. */
function envelope(node, extra = {}) {
  return [{ Plan: node, ...extra }];
}

function input(plan, overrides = {}) {
  return { database: "postgresql", mode: "estimated", format: "json", plan, ...overrides };
}

test("accepts the full PostgreSQL array envelope, not just the inner Plan object", () => {
  const parsed = parsePostgresJsonPlan(
    input(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "pd_fix_orders",
        "Plan Rows": 4000,
        "Total Cost": 61.0,
      }),
    ),
  );

  assert.equal(parsed.database, "postgresql");
  assert.equal(parsed.format, "json");
  assert.equal(parsed.mode, "estimated");
  assert.equal(parsed.root.nodeType, "Seq Scan");
  assert.equal(parsed.root.relationName, "pd_fix_orders");
  assert.equal(parsed.root.planRows, 4000);
  assert.equal(parsed.root.totalCost, 61.0);
  assert.deepEqual(parsed.root.children, []);
});

test("rejects the inner envelope entry with a pointer to the full payload", () => {
  assert.throws(
    () => parsePostgresJsonPlan(input({ Plan: { "Node Type": "Seq Scan" } })),
    (error) => {
      assert.ok(error instanceof PlanParseError);
      assert.equal(error.code, "MALFORMED_PLAN");
      assert.match(error.message, /full payload/);
      return true;
    },
  );
});

test("rejects malformed envelopes", () => {
  for (const plan of [[], [{ Plan: {} }, { Plan: {} }], [{}], "seq scan", 42]) {
    assert.throws(() => parsePostgresJsonPlan(input(plan)), (error) => {
      assert.ok(error instanceof PlanParseError, `expected PlanParseError for ${JSON.stringify(plan)}`);
      assert.equal(error.code, "MALFORMED_PLAN");
      return true;
    });
  }
});

test("maps the basic fields and preserves children as a tree", () => {
  const parsed = parsePostgresJsonPlan(
    input(
      envelope({
        "Node Type": "Hash Join",
        "Join Type": "Inner",
        "Plan Rows": 120,
        "Total Cost": 33.5,
        Plans: [
          { "Node Type": "Seq Scan", "Relation Name": "a", "Plan Rows": 100, "Total Cost": 20.0 },
          { "Node Type": "Hash", "Plan Rows": 20, "Total Cost": 11.0, Plans: [{ "Node Type": "Seq Scan", "Relation Name": "b" }] },
        ],
      }),
    ),
  );

  assert.equal(parsed.root.nodeType, "Hash Join");
  assert.equal(parsed.root.relationName, null);
  assert.equal(parsed.root.joinType, "Inner");
  assert.deepEqual(
    parsed.root.children.map((child) => child.nodeType),
    ["Seq Scan", "Hash"],
  );
  assert.equal(parsed.root.children[1].children[0].relationName, "b");
  assert.equal(parsed.root.children[0].planRows, 100);
  assert.equal(parsed.root.children[0].totalCost, 20.0);
});

test("maps PostgreSQL-specific node properties onto typed fields", () => {
  const parsed = parsePostgresJsonPlan(
    input(
      envelope({
        "Node Type": "Index Scan",
        "Parent Relationship": "Outer",
        "Relation Name": "pd_fix_orders",
        Alias: "o",
        "Index Name": "pd_fix_orders_customer_idx",
        "Startup Cost": 0.29,
        "Total Cost": 8.31,
        "Plan Rows": 1,
        "Plan Width": 27,
        "Index Cond": "(customer_id = 42)",
        Filter: "(status = 'paid'::text)",
        "Parallel Aware": true,
        "Async Capable": false,
      }),
    ),
  );

  const root = parsed.root;
  assert.equal(root.indexName, "pd_fix_orders_customer_idx");
  assert.equal(root.alias, "o");
  assert.equal(root.indexCondition, "(customer_id = 42)");
  assert.equal(root.filter, "(status = 'paid'::text)");
  assert.equal(root.startupCost, 0.29);
  assert.equal(root.planWidth, 27);
  assert.equal(root.parentRelationship, "Outer");
  assert.equal(root.parallelAware, true);
  assert.equal(root.asyncCapable, false);
});

test("maps join conditions, sort keys, group keys and aggregate strategy", () => {
  const parsed = parsePostgresJsonPlan(
    input(
      envelope({
        "Node Type": "Hash Join",
        "Join Type": "Left",
        "Hash Cond": "(e.customer_id = c.id)",
        "Join Filter": "(e.total > 0)",
        "Plan Rows": 10,
      }),
    ),
  );
  assert.equal(parsed.root.hashCondition, "(e.customer_id = c.id)");
  assert.equal(parsed.root.joinFilter, "(e.total > 0)");

  const sorted = parsePostgresJsonPlan(
    input(envelope({ "Node Type": "Sort", "Sort Key": ["total DESC", "id"], "Plan Rows": 10 })),
  );
  assert.deepEqual(sorted.root.sortKeys, ["total DESC", "id"]);

  const grouped = parsePostgresJsonPlan(
    input(envelope({ "Node Type": "HashAggregate", "Group Key": ["status"], Strategy: "Hashed", "Partial Mode": "Simple" })),
  );
  assert.deepEqual(grouped.root.groupKeys, ["status"]);
  assert.equal(grouped.root.strategy, "Hashed");
  assert.equal(grouped.root.partialMode, "Simple");
});

test("handles arbitrary nesting depth without a hard-coded shape", () => {
  const parsed = parsePostgresJsonPlan(input(envelope(chainNode(6))));
  assert.equal(depthOf(parsed.root), 6);
  assert.equal(flattenNodes(parsed.root).length, 6);
  assert.equal(flattenNodes(parsed.root).at(-1).nodeType, "Leaf Scan");
});

test("unknown node types keep their type, children and unknown properties", () => {
  const parsed = parsePostgresJsonPlan(
    input(
      envelope({
        "Node Type": "Future Shuffle Node",
        "Plan Rows": 5,
        "Future Planner Field": { "introduced-in": "postgresql-19" },
        Plans: [{ "Node Type": "Another Future Node", "Unknown Leaf Property": "keep-me" }],
      }),
    ),
  );

  assert.equal(parsed.root.nodeType, "Future Shuffle Node");
  assert.equal(parsed.root.children[0].nodeType, "Another Future Node");
  assert.deepEqual(parsed.root.extra, { "Future Planner Field": { "introduced-in": "postgresql-19" } });
  assert.equal(parsed.root.children[0].extra["Unknown Leaf Property"], "keep-me");
});

test("keeps unmapped node properties in extra instead of dropping them", () => {
  const parsed = parsePostgresJsonPlan(
    input(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "t",
        "Plan Rows": 10,
        "Total Cost": 1.5,
        "Future Planner Field": { "introduced-in": "postgresql-19" },
        "Custom Node Metric": 1.5,
        Plans: [],
      }),
    ),
  );

  assert.deepEqual(parsed.root.extra, {
    "Future Planner Field": { "introduced-in": "postgresql-19" },
    "Custom Node Metric": 1.5,
  });
  assert.equal("Plans" in parsed.root.extra, false, "Plans must live in children, not be duplicated");
  assert.equal("Total Cost" in parsed.root.extra, false, "mapped properties must not be duplicated");
});

test("actual-only properties outside the mapped set stay in extra in actual mode", () => {
  const parsed = parsePostgresJsonPlan(
    input(
      envelope({
        "Node Type": "Seq Scan",
        "Plan Rows": 20,
        "Actual Rows": 30,
        "Actual Loops": 1,
        "Rows Removed by Filter": 3,
        "Heap Fetches": 0,
      }),
      { mode: "actual" },
    ),
  );

  assert.deepEqual(parsed.root.extra, { "Rows Removed by Filter": 3, "Heap Fetches": 0 });
  assert.equal(parsed.root.actualRows, 30);
});

test("estimated mode keeps actual-execution fields absent (null, never 0)", () => {
  const parsed = parsePostgresJsonPlan(input(envelope({ "Node Type": "Seq Scan", "Plan Rows": 4000 })));
  assert.equal(parsed.root.actualRows, null);
  assert.equal(parsed.root.actualTotalTime, null);
  assert.equal(parsed.root.actualLoops, null);
  assert.equal(parsed.root.actualStartupTime, null);
});

test("actual mode maps actual-execution fields separately from estimates", () => {
  const parsed = parsePostgresJsonPlan(
    input(
      envelope({
        "Node Type": "Seq Scan",
        "Plan Rows": 20,
        "Total Cost": 61.0,
        "Actual Rows": 3600,
        "Actual Total Time": 1.234,
        "Actual Loops": 1,
        "Actual Startup Time": 0.02,
      }),
      { mode: "actual" },
    ),
  );

  assert.equal(parsed.root.planRows, 20);
  assert.equal(parsed.root.actualRows, 3600);
  assert.equal(parsed.root.actualTotalTime, 1.234);
  assert.equal(parsed.root.actualLoops, 1);
  assert.equal(parsed.root.actualStartupTime, 0.02);
  assert.deepEqual(parsed.root.extra, {});
});

test("actual mode tolerates missing actual fields instead of inventing values", () => {
  const parsed = parsePostgresJsonPlan(input(envelope({ "Node Type": "Seq Scan", "Plan Rows": 1 }), { mode: "actual" }));
  assert.equal(parsed.root.actualRows, null);
});

test("refuses to mix estimated mode with EXPLAIN ANALYZE output", () => {
  for (const property of ["Actual Rows", "Actual Total Time", "Actual Loops", "Rows Removed by Filter", "Heap Fetches"]) {
    assert.throws(
      () => parsePostgresJsonPlan(input(envelope({ "Node Type": "Seq Scan", [property]: 1 }))),
      (error) => {
        assert.ok(error instanceof PlanParseError);
        assert.equal(error.code, "MODE_MISMATCH");
        assert.match(error.message, new RegExp(property.replace(/ /g, " ")));
        return true;
      },
    );
  }
});

test("malformed nodes fail with a path and a code", () => {
  const cases = [
    [envelope({ "Plan Rows": 1 }), /plan\[0\]\.Plan\["Node Type"\]/],
    [envelope(null), /plan\[0\]\.Plan must be an object/],
    [envelope({ "Node Type": "Seq Scan", "Plan Rows": "10" }), /plan\[0\]\.Plan\["Plan Rows"\] must be a finite number/],
    [envelope({ "Node Type": "Seq Scan", "Parallel Aware": "yes" }), /plan\[0\]\.Plan\["Parallel Aware"\] must be a boolean/],
    [envelope({ "Node Type": "Sort", "Sort Key": [1] }), /plan\[0\]\.Plan\["Sort Key"\] must be a string or an array of strings/],
    [envelope({ "Node Type": "Seq Scan", Plans: {} }), /plan\[0\]\.Plan\.Plans must be an array/],
    [
      envelope({ "Node Type": "Hash Join", Plans: [{ "Node Type": "Seq Scan" }, { "Total Cost": 1 }] }),
      /plan\[0\]\.Plan\.Plans\[1\]\["Node Type"\]/,
    ],
  ];

  for (const [plan, pattern] of cases) {
    assert.throws(() => parsePostgresJsonPlan(input(plan)), (error) => {
      assert.ok(error instanceof PlanParseError, `expected PlanParseError for ${JSON.stringify(plan)}`);
      assert.equal(error.code, "MALFORMED_NODE");
      assert.match(error.message, pattern);
      return true;
    });
  }
});

test("a single sort key reported as a string is accepted as a one-element list", () => {
  const parsed = parsePostgresJsonPlan(input(envelope({ "Node Type": "Sort", "Sort Key": "total" })));
  assert.deepEqual(parsed.root.sortKeys, ["total"]);
});

test("contract violations surface as PlanInputError before parsing", () => {
  assert.throws(
    () => parsePostgresJsonPlan({ database: "mysql", mode: "estimated", format: "json", plan: [] }),
    (error) => {
      assert.ok(error instanceof PlanInputError);
      assert.equal(error.code, "INVALID_RAW_PLAN_INPUT");
      return true;
    },
  );
});
