import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMySqlPlan } from "../../src/core/normalize/normalize-mysql.js";
import { flattenNodes } from "../../src/core/tree.js";
import { parseMySqlJsonPlan } from "../../src/core/mysql/parse-json-plan.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";
import { loadFixture } from "../helpers/fixtures.js";

/**
 * Normalization contract tests: MySQL parsed plan -> database-neutral
 * NormalizedPlan. The fixtures pin the full trees; these tests pin the mapping
 * rules and the deliberate nulls.
 */

const complexFixture = await loadFixture({ database: "mysql", mode: "estimated", name: "complex-mixed.synthetic" });
const indexFixture = await loadFixture({ database: "mysql", mode: "estimated", name: "index-lookup.synthetic" });
const futureFixture = await loadFixture({ database: "mysql", mode: "estimated", name: "future-shape.synthetic" });

/** @param {unknown} plan */
function normalized(plan) {
  return normalizeMySqlPlan(
    parseMySqlJsonPlan(createRawPlanInput({ database: "mysql", mode: "estimated", format: "json", plan })),
  );
}

test("maps MySQL labels onto the shared semantic kinds", () => {
  const cases = [
    ["ALL", "seq_scan"],
    ["index", "index_scan"],
    ["range", "index_scan"],
    ["ref", "index_scan"],
    ["eq_ref", "index_scan"],
    ["const", "const_scan"],
    ["system", "const_scan"],
  ];

  for (const [accessType, kind] of cases) {
    const plan = normalized({ query_block: { select_id: 1, table: { table_name: "t", access_type: accessType } } });
    assert.equal(plan.root.kind, "query_block");
    assert.equal(plan.root.children[0].kind, kind, `${accessType} must normalize to ${kind}`);
    assert.equal(plan.root.children[0].nodeType, plan.root.children[0].nodeType, "the label stays available");
  }

  const operations = normalized({
    query_block: {
      select_id: 1,
      ordering_operation: { using_filesort: true, table: { table_name: "t", access_type: "ALL" } },
    },
  });
  assert.equal(operations.root.children[0].kind, "sort");

  const grouped = normalized({
    query_block: {
      select_id: 1,
      grouping_operation: { using_temporary_table: true, table: { table_name: "t", access_type: "ALL" } },
    },
  });
  assert.equal(grouped.root.children[0].kind, "aggregate");

  const union = normalized({
    query_block: {
      union_result: {
        using_temporary_table: true,
        query_specifications: [{ dependent: false, cacheable: true, query_block: { select_id: 1, table: { table_name: "t", access_type: "ALL" } } }],
      },
    },
  });
  assert.equal(union.root.children[0].kind, "append");
  assert.equal(union.root.children[0].children[0].kind, "query_block");
});

test("assigns stable path ids in pre-order across the whole tree", () => {
  const plan = normalizeMySqlPlan(parseMySqlJsonPlan(complexFixture.input));
  const nodes = flattenNodes(plan.root);

  assert.equal(plan.root.id, "0");
  for (const node of nodes) {
    // Every id is its parent's id plus the child index, so the whole tree is
    // addressable by a stable, human-readable path.
    if (node.id === "0") continue;
    const parentId = node.id.slice(0, node.id.lastIndexOf("."));
    const index = Number(node.id.slice(node.id.lastIndexOf(".") + 1));
    assert.ok(nodes.some((candidate) => candidate.id === parentId), `${node.id} must have a parent row`);
    assert.ok(Number.isInteger(index) && index >= 0);
  }

  const orders = nodes.find((node) => node.relation?.name === "orders" && node.kind === "seq_scan");
  assert.equal(orders.id, "0.0.0.0.0.0");
  assert.equal(orders.children[0].kind, "subquery");
  assert.equal(orders.children[0].id, "0.0.0.0.0.0.0", "the attached subquery stays below the table that owns it");
});

test("maps relation / index and keeps alias empty because MySQL JSON has none", () => {
  const plan = normalizeMySqlPlan(parseMySqlJsonPlan(indexFixture.input));
  const node = plan.root.children[0];

  assert.deepEqual(node.relation, { name: "users", alias: null, indexName: "idx_users_email" });
  assert.equal(node.estimatedRows, 1);
  assert.equal(node.filter, null);
  assert.equal(node.indexCondition, null);
});

test("maps rows_examined_per_scan to estimatedRows for tables and join prefixes to nested loops", () => {
  const plan = normalized({
    query_block: {
      select_id: 1,
      nested_loop: [
        { table: { table_name: "a", access_type: "ALL", rows_examined_per_scan: 100, rows_produced_per_join: 100 } },
        { table: { table_name: "b", access_type: "ALL", rows_examined_per_scan: 7, rows_produced_per_join: 700 } },
      ],
    },
  });

  const [join] = plan.root.children;
  assert.equal(join.kind, "nested_loop");
  assert.equal(join.estimatedRows, 700, "join prefix rows come from the inner table's rows_produced_per_join");
  assert.equal(join.children[0].estimatedRows, 100);
  assert.equal(join.children[1].estimatedRows, 7);
});

test("cost fields stay null: MySQL cost is not PostgreSQL incremental cost", () => {
  const plan = normalizeMySqlPlan(parseMySqlJsonPlan(indexFixture.input));
  const node = plan.root.children[0];

  assert.equal(node.startupCost, null);
  assert.equal(node.totalCost, null);
  assert.equal(node.width, null);
  // The server-reported costs survive under engineSpecific instead.
  assert.equal(node.engineSpecific.mysql.readCost, 1.1);
  assert.equal(node.engineSpecific.mysql.prefixCost, 4.2);
  assert.equal(node.engineSpecific.mysql.dataReadPerJoin, 64);
  assert.equal(plan.root.engineSpecific.mysql.queryCost, 4.2);
});

test("actual-execution fields stay null for estimated MySQL plans", () => {
  const plan = normalizeMySqlPlan(parseMySqlJsonPlan(complexFixture.input));

  /** @param {any} node */
  function assertActualNull(node) {
    assert.equal(node.actualRows, null);
    assert.equal(node.actualStartupTime, null);
    assert.equal(node.actualTotalTime, null);
    assert.equal(node.loops, null);
    for (const child of node.children) assertActualNull(child);
  }

  assertActualNull(plan.root);
});

test("keeps MySQL-only values under engineSpecific.mysql and unmapped keys under extra", () => {
  const plan = normalizeMySqlPlan(parseMySqlJsonPlan(futureFixture.input));
  const node = plan.root.children[0];

  assert.equal(plan.database, "mysql");
  assert.equal(plan.mode, "estimated");
  assert.equal(plan.format, "json");
  assert.equal(node.engineSpecific.database, "mysql");
  assert.equal(node.engineSpecific.mysql.structure, "table");
  assert.equal(node.engineSpecific.mysql.accessType, "hypergraph");
  assert.deepEqual(node.engineSpecific.extra, { future_property: { nested: true } });
  assert.deepEqual(plan.root.engineSpecific.extra, { windowing: { windows: [] }, cost_info: { future_cost: "1.5" } });
});

test("records unclassified labels once and sorted", () => {
  const plan = normalized({
    query_block: {
      select_id: 1,
      table: { table_name: "a", access_type: "hypergraph" },
    },
  });

  assert.equal(plan.root.children[0].kind, "unknown");
  assert.deepEqual(plan.unknownNodeTypes, ["hypergraph"]);
});

test("is deterministic and JSON-serializable", () => {
  const first = normalizeMySqlPlan(parseMySqlJsonPlan(complexFixture.input));
  const second = normalizeMySqlPlan(parseMySqlJsonPlan(complexFixture.input));

  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(first)), first);
});

test("normalizes V2 access-path fields into the shared tree without promoting MySQL cost", () => {
  const plan = normalized({
    json_schema_version: "2.0",
    query_plan: {
      operation: "Inner hash join",
      access_type: "join",
      join_type: "inner join",
      join_algorithm: "hash",
      estimated_rows: 10,
      estimated_total_cost: 12.5,
      inputs: [
        {
          operation: "Table scan on sample_table",
          table_name: "sample_table",
          alias: "st",
          schema_name: "sample_db",
          access_type: "table",
          used_columns: ["id", "name"],
          estimated_rows: 100,
        },
        {
          operation: "Filter: (id > 0)",
          access_type: "filter",
          condition: "(id > 0)",
          filter_columns: ["id"],
          estimated_rows: 20,
          sort_fields: ["id"],
        },
      ],
    },
  });

  assert.equal(plan.root.kind, "hash_join");
  assert.equal(plan.root.joinType, "inner join");
  assert.equal(plan.root.estimatedRows, 10);
  assert.equal(plan.root.totalCost, null);
  assert.equal(plan.root.engineSpecific.mysql.estimatedTotalCost, 12.5);
  assert.deepEqual(plan.root.children.map((node) => node.id), ["0.0", "0.1"]);

  const table = plan.root.children[0];
  assert.equal(table.kind, "seq_scan");
  assert.deepEqual(table.relation, { name: "sample_table", alias: "st", indexName: null });
  assert.equal(table.estimatedRows, 100);
  assert.equal(table.engineSpecific.mysql.accessType, "table");
  assert.equal(table.engineSpecific.mysql.schemaName, "sample_db");
  assert.deepEqual(table.engineSpecific.mysql.usedColumns, ["id", "name"]);

  const filter = plan.root.children[1];
  assert.equal(filter.kind, "filter");
  assert.equal(filter.filter, "(id > 0)");
  assert.deepEqual(filter.sortKeys, ["id"]);
});
