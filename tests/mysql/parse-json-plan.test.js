import assert from "node:assert/strict";
import test from "node:test";
import { PlanInputError, PlanParseError } from "../../src/core/errors.js";
import { parseMySqlJsonPlan } from "../../src/core/mysql/parse-json-plan.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";

/**
 * Parser contract tests for `EXPLAIN FORMAT=JSON`.
 *
 * The committed fixtures pin the whole pipeline; these tests pin the parser's
 * field mapping, its structural folding (nested_loop -> binary tree) and its
 * fail-closed behavior on payloads that are not a trustworthy MySQL plan.
 */

/** @param {unknown} plan */
function mysqlInput(plan, overrides = {}) {
  return createRawPlanInput({ database: "mysql", mode: "estimated", format: "json", plan, ...overrides });
}

function table(overrides = {}) {
  return {
    table_name: "t1",
    access_type: "ALL",
    rows_examined_per_scan: 10,
    rows_produced_per_join: 10,
    filtered: "100.00",
    cost_info: { read_cost: "0.50", eval_cost: "0.10", prefix_cost: "0.60", data_read_per_join: "80" },
    ...overrides,
  };
}

/** @param {Record<string, unknown>} block */
function plan(block) {
  return { query_block: { select_id: 1, cost_info: { query_cost: "0.60" }, ...block } };
}

test("parses the MySQL envelope and table fields into typed values", () => {
  const parsed = parseMySqlJsonPlan(
    mysqlInput(
      plan({
        table: table({
          possible_keys: ["idx_t1_status"],
          key: "idx_t1_status",
          used_key_parts: ["status"],
          key_length: "4",
          ref: ["const"],
          used_columns: ["id", "status"],
          attached_condition: "(`t1`.`status` = 'OPEN')",
        }),
      }),
    ),
  );

  assert.equal(parsed.database, "mysql");
  assert.equal(parsed.format, "json");
  assert.equal(parsed.mode, "estimated");
  assert.equal(parsed.root.structure, "query_block");
  assert.equal(parsed.root.nodeType, "Query Block");
  assert.equal(parsed.root.mysql.selectId, 1);
  assert.equal(parsed.root.mysql.queryCost, 0.6);

  const [node] = parsed.root.children;
  assert.equal(node.structure, "table");
  assert.equal(node.nodeType, "Table Scan");
  assert.equal(node.relationName, "t1");
  assert.equal(node.indexName, "idx_t1_status");
  assert.equal(node.estimatedRows, 10);
  assert.equal(node.filter, "(`t1`.`status` = 'OPEN')");
  assert.equal(node.indexCondition, null);

  // Raw MySQL values stay typed and available under `mysql`.
  assert.equal(node.mysql.accessType, "ALL");
  assert.deepEqual(node.mysql.possibleKeys, ["idx_t1_status"]);
  assert.deepEqual(node.mysql.usedKeyParts, ["status"]);
  assert.deepEqual(node.mysql.usedColumns, ["id", "status"]);
  assert.equal(node.mysql.keyLength, "4");
  assert.deepEqual(node.mysql.ref, ["const"]);
  assert.equal(node.mysql.rowsExaminedPerScan, 10);
  assert.equal(node.mysql.rowsProducedPerJoin, 10);
  assert.equal(node.mysql.filteredPercent, 100);
  // `cost_info` is numeric-string encoded by MySQL and parsed strictly.
  assert.equal(node.mysql.queryCost, null, "query_cost belongs to the query block, not the table");
  assert.equal(node.mysql.readCost, 0.5);
  assert.equal(node.mysql.evalCost, 0.1);
  assert.equal(node.mysql.prefixCost, 0.6);
  assert.equal(node.mysql.dataReadPerJoin, 80);
  assert.deepEqual(node.extra, {});
});

test("maps access types onto stable MySQL labels instead of PostgreSQL ones", () => {
  const cases = [
    ["ALL", "Table Scan"],
    ["index", "Full Index Scan"],
    ["range", "Index Range Scan"],
    ["ref", "Index Lookup"],
    ["eq_ref", "Unique Index Lookup"],
    ["ref_or_null", "Index Lookup Or Null"],
    ["fulltext", "Fulltext Lookup"],
    ["index_merge", "Index Merge"],
    ["unique_subquery", "Unique Subquery Lookup"],
    ["index_subquery", "Index Subquery Lookup"],
    ["const", "Const Row Lookup"],
    ["system", "System Row Lookup"],
  ];

  for (const [accessType, nodeType] of cases) {
    const parsed = parseMySqlJsonPlan(mysqlInput(plan({ table: table({ access_type: accessType }) })));
    assert.equal(parsed.root.children[0].nodeType, nodeType, `${accessType} must map to ${nodeType}`);
    assert.equal(parsed.root.children[0].mysql.accessType, accessType, "the raw access type must stay available");
  }
});

test("folds nested_loop into a left-deep binary tree with cumulative row estimates", () => {
  const parsed = parseMySqlJsonPlan(
    mysqlInput(
      plan({
        nested_loop: [
          { table: table({ table_name: "a", access_type: "ALL", rows_examined_per_scan: 100, rows_produced_per_join: 100 }) },
          { table: table({ table_name: "b", access_type: "ref", rows_examined_per_scan: 1, rows_produced_per_join: 250 }) },
          { table: table({ table_name: "c", access_type: "eq_ref", rows_examined_per_scan: 1, rows_produced_per_join: 750 }) },
        ],
      }),
    ),
  );

  const root = parsed.root.children[0];
  assert.equal(root.nodeType, "Nested Loop");
  assert.equal(root.estimatedRows, 750, "the outer join node carries the full prefix estimate");
  assert.equal(root.children.length, 2, "a nested loop is binary, not a flat list");

  const [outer, inner] = root.children;
  assert.equal(inner.relationName, "c");
  assert.equal(outer.nodeType, "Nested Loop");
  assert.equal(outer.estimatedRows, 250);
  assert.deepEqual(
    outer.children.map((child) => child.relationName),
    ["a", "b"],
    "the first join pair stays the innermost join node",
  );
});

test("parses ordering / grouping / duplicates_removal wrappers and their flags", () => {
  const parsed = parseMySqlJsonPlan(
    mysqlInput(
      plan({
        ordering_operation: {
          using_filesort: true,
          using_temporary_table: true,
          grouping_operation: {
            using_filesort: false,
            duplicates_removal: { using_temporary_table: true, table: table({ access_type: "range" }) },
          },
        },
      }),
    ),
  );

  const ordering = parsed.root.children[0];
  assert.equal(ordering.nodeType, "Ordering Operation");
  assert.equal(ordering.mysql.usingFilesort, true);
  assert.equal(ordering.mysql.usingTemporaryTable, true);

  const grouping = ordering.children[0];
  assert.equal(grouping.nodeType, "Grouping Operation");
  assert.equal(grouping.mysql.usingFilesort, false);

  const duplicates = grouping.children[0];
  assert.equal(duplicates.nodeType, "Duplicates Removal");
  assert.equal(duplicates.mysql.usingTemporaryTable, true);
  assert.equal(duplicates.children[0].nodeType, "Index Range Scan");
});

test("parses set operations and their query specifications", () => {
  const cases = [
    ["union_result", "Union Result"],
    ["unary_result", "Unary Result"],
    ["intersect_result", "Intersect Result"],
    ["except_result", "Except Result"],
  ];

  for (const [key, nodeType] of cases) {
    const parsed = parseMySqlJsonPlan(
      mysqlInput(
        plan({
          [key]: {
            using_temporary_table: true,
            select_id: 3,
            table_name: "<result1,2>",
            access_type: "ALL",
            query_specifications: [
              { dependent: false, cacheable: true, query_block: { select_id: 1, table: table() } },
              { dependent: false, cacheable: true, query_block: { select_id: 2, table: table({ table_name: "t2" }) } },
            ],
          },
        }),
      ),
    );

    const node = parsed.root.children[0];
    assert.equal(node.nodeType, nodeType, `${key} must map to ${nodeType}`);
    assert.equal(node.relationName, "<result1,2>");
    assert.equal(node.mysql.usingTemporaryTable, true);
    assert.equal(node.children.length, 2);
    assert.equal(node.children[0].nodeType, "Query Block");
    assert.equal(node.children[1].children[0].relationName, "t2");
  }
});

test("parses a nested set operation inside query_specifications", () => {
  // MySQL 8.0.31+ parenthesized query expressions nest a set operation in
  // `query_specifications` instead of a `{ dependent, cacheable, query_block }`
  // wrapper. Shape from MySQL Server 8.0 mysql-test expected output.
  const parsed = parseMySqlJsonPlan(
    mysqlInput({
      query_block: {
        unary_result: {
          using_temporary_table: true,
          select_id: 3,
          table_name: "<ordered2>",
          access_type: "ALL",
          using_filesort: true,
          query_specifications: [
            {
              union_result: {
                using_temporary_table: true,
                select_id: 2,
                table_name: "<union1,2>",
                access_type: "ALL",
                query_specifications: [
                  { dependent: false, cacheable: true, query_block: { select_id: 1, table: table() } },
                  { dependent: false, cacheable: true, query_block: { select_id: 2, table: table({ table_name: "t2" }) } },
                ],
              },
            },
          ],
        },
      },
    }),
  );

  const unary = parsed.root.children[0];
  assert.equal(unary.nodeType, "Unary Result");
  assert.equal(unary.mysql.usingFilesort, true);

  const union = unary.children[0];
  assert.equal(union.nodeType, "Union Result");
  assert.equal(union.relationName, "<union1,2>");
  assert.equal(union.children.length, 2);
  assert.equal(union.children[1].children[0].relationName, "t2");
});

test("parses materialized subqueries nested below a table", () => {
  const parsed = parseMySqlJsonPlan(
    mysqlInput(
      plan({
        table: table({
          table_name: "<derived2>",
          materialized_from_subquery: {
            using_temporary_table: true,
            dependent: false,
            cacheable: true,
            query_block: { select_id: 2, table: table({ table_name: "orders" }) },
          },
        }),
      }),
    ),
  );

  const node = parsed.root.children[0];
  const materialized = node.children[0];
  assert.equal(materialized.nodeType, "Materialized Subquery");
  assert.equal(materialized.mysql.usingTemporaryTable, true);
  assert.equal(materialized.children[0].nodeType, "Query Block");
  assert.equal(materialized.children[0].children[0].relationName, "orders");
});

test("parses every documented subquery array shape", () => {
  const keys = [
    "attached_subqueries",
    "optimized_away_subqueries",
    "group_by_subqueries",
    "having_subqueries",
    "order_by_subqueries",
    "select_list_subqueries",
  ];

  const block = { table: table() };
  for (const key of keys) {
    block[key] = [{ dependent: true, cacheable: false, query_block: { select_id: 9, table: table({ table_name: "sub" }) } }];
  }

  const parsed = parseMySqlJsonPlan(mysqlInput(plan(block)));
  const subqueries = parsed.root.children.slice(1);
  assert.deepEqual(subqueries.map((node) => node.structure), keys);
  for (const subquery of subqueries) {
    assert.equal(subquery.nodeType, "Subquery");
    assert.equal(subquery.mysql.dependent, true);
    assert.equal(subquery.mysql.cacheable, false);
    assert.equal(subquery.children[0].children[0].relationName, "sub");
  }
});

test("keeps an unknown access type and unknown keys instead of failing or dropping them", () => {
  const parsed = parseMySqlJsonPlan(
    mysqlInput({
      query_block: {
        select_id: 1,
        cost_info: { query_cost: "3.00", future_cost: "1.50" },
        windowing: { windows: [] },
        table: table({ access_type: "hypergraph", future_property: { nested: true } }),
      },
    }),
  );

  const node = parsed.root.children[0];
  assert.equal(node.nodeType, "hypergraph", "an unknown access type must keep its raw label");
  assert.equal(node.mysql.accessType, "hypergraph");
  assert.deepEqual(node.extra, { future_property: { nested: true } });
  assert.deepEqual(parsed.root.extra, { windowing: { windows: [] }, cost_info: { future_cost: "1.50" } });
});

test("keeps `message` wherever MySQL reports it", () => {
  // Real MySQL shapes: `Deleting all rows` sits on a table, and set operations
  // carry `Not optimized, outer query is empty` when the outer query is empty.
  const parsed = parseMySqlJsonPlan(
    mysqlInput({
      query_block: {
        select_id: 1,
        message: "Impossible WHERE",
        table: table({ delete: true, message: "Deleting all rows" }),
      },
    }),
  );
  assert.equal(parsed.root.mysql.message, "Impossible WHERE");
  assert.equal(parsed.root.children[0].mysql.message, "Deleting all rows");
  assert.deepEqual(parsed.root.children[0].extra, { delete: true });

  const nested = parseMySqlJsonPlan(
    mysqlInput({
      query_block: {
        intersect_result: {
          using_temporary_table: true,
          message: "Not optimized, outer query is empty",
          query_specifications: [
            { dependent: false, cacheable: true, query_block: { select_id: 3, message: "Not optimized, outer query is empty" } },
          ],
        },
      },
    }),
  );
  assert.equal(nested.root.children[0].mysql.message, "Not optimized, outer query is empty");
});

test("declares only estimated mode: MySQL EXPLAIN ANALYZE is not this JSON payload", () => {
  assert.throws(
    () => parseMySqlJsonPlan(createRawPlanInput({ database: "mysql", mode: "actual", format: "json", plan: plan({ table: table() }) })),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
});

test("rejects payloads whose structure cannot be trusted", () => {
  const cases = [
    ["plan is not an object", ["not", "a", "plan"], "MALFORMED_PLAN"],
    ["plan has no query_block", { other: true }, "MALFORMED_PLAN"],
    ["query_block is not an object", { query_block: "SELECT 1" }, "MALFORMED_NODE"],
    ["table is not an object", plan({ table: "orders" }), "MALFORMED_NODE"],
    ["nested_loop is not an array", plan({ nested_loop: { table: table() } }), "MALFORMED_NODE"],
    ["nested_loop is empty", plan({ nested_loop: [] }), "MALFORMED_NODE"],
    ["nested_loop element is not an object", plan({ nested_loop: [{ table: table() }, 3] }), "MALFORMED_NODE"],
    ["nested_loop element has no table", plan({ nested_loop: [{ table: table() }, { mystery: true }] }), "MALFORMED_NODE"],
    [
      "rows_examined_per_scan is a string",
      plan({ table: table({ rows_examined_per_scan: "10" }) }),
      "MALFORMED_NODE",
    ],
    ["rows_produced_per_join is a string", plan({ table: table({ rows_produced_per_join: "10" }) }), "MALFORMED_NODE"],
    ["filtered is not numeric", plan({ table: table({ filtered: "a lot" }) }), "MALFORMED_NODE"],
    ["cost_info is not an object", plan({ table: table({ cost_info: "0.60" }) }), "MALFORMED_NODE"],
    ["query_cost is not numeric", plan({ table: table({ cost_info: { query_cost: "cheap" } }) }), "MALFORMED_NODE"],
    ["using_filesort is not a flag", plan({ ordering_operation: { using_filesort: "sometimes", table: table() } }), "MALFORMED_NODE"],
    ["select_id is not a number", { query_block: { select_id: "1", table: table() } }, "MALFORMED_NODE"],
    ["message is not a string", { query_block: { select_id: 1, message: 42, table: table() } }, "MALFORMED_NODE"],
    ["query_specifications is not an array", { query_block: { union_result: { query_specifications: "two" } } }, "MALFORMED_NODE"],
    ["query_specifications entry is not an object", { query_block: { union_result: { query_specifications: [3] } } }, "MALFORMED_NODE"],
    [
      "query_specifications entry has neither query_block nor a known structure",
      { query_block: { union_result: { query_specifications: [{ dependent: false }] } } },
      "MALFORMED_NODE",
    ],
    ["table message is not a string", plan({ table: table({ message: 42 }) }), "MALFORMED_NODE"],
    ["materialized_from_subquery has no query_block", plan({ table: table({ materialized_from_subquery: { cacheable: true } }) }), "MALFORMED_NODE"],
    ["attached_subqueries entry has no query_block", plan({ table: table(), attached_subqueries: [{ dependent: true }] }), "MALFORMED_NODE"],
    ["attached_subqueries is not an array", plan({ table: table(), attached_subqueries: { query_block: {} } }), "MALFORMED_NODE"],
    ["used_columns mixes types", plan({ table: table({ used_columns: ["id", 3] }) }), "MALFORMED_NODE"],
  ];

  for (const [label, payload, code] of cases) {
    assert.throws(
      () => parseMySqlJsonPlan(mysqlInput(payload)),
      (error) => {
        assert.ok(error instanceof PlanParseError, `${label}: expected PlanParseError, got ${error.name}: ${error.message}`);
        assert.equal(error.code, code, `${label}: wrong error code`);
        return true;
      },
      label,
    );
  }
});

test("keeps the RawPlanInput contract errors distinct from parse errors", () => {
  assert.throws(
    () => parseMySqlJsonPlan({ database: "redis", mode: "estimated", format: "json", plan: {} }),
    (error) => error instanceof PlanInputError && error.code === "INVALID_RAW_PLAN_INPUT",
  );
});

test("preserves unexpected keys on structural wrappers", () => {
  const parsed = parseMySqlJsonPlan(
    mysqlInput(
      plan({
        nested_loop: [
          { table: table(), future_entry_key: 1 },
          { table: table({ table_name: "t2" }) },
        ],
      }),
    ),
  );
  assert.deepEqual(parsed.root.children[0].children[0].extra, { nested_loop_entry: { future_entry_key: 1 } });

  const union = parseMySqlJsonPlan(
    mysqlInput({
      query_block: {
        union_result: {
          query_specifications: [
            { dependent: false, cacheable: true, query_block: { select_id: 1, table: table() }, future_spec_key: "x" },
          ],
        },
      },
    }),
  );
  assert.deepEqual(union.root.children[0].children[0].extra, { query_specification: { future_spec_key: "x" } });
});

test("does not mutate the raw payload", () => {
  const raw = mysqlInput(
    plan({
      table: table({
        attached_subqueries: [{ dependent: true, cacheable: false, query_block: { select_id: 9, table: table() } }],
        future_property: { nested: [1, 2, 3] },
      }),
    }),
  );
  const snapshot = structuredClone(raw);

  parseMySqlJsonPlan(raw);

  assert.deepEqual(raw, snapshot, "the raw input must stay untouched");
});

test("parses a MySQL JSON V2 single table access path without creating a query_block", () => {
  const parsed = parseMySqlJsonPlan(
    mysqlInput({
      query: "/* select#1 */ select sample columns",
      query_plan: {
        operation: "Table scan on sample_table",
        table_name: "sample_table",
        access_type: "table",
        schema_name: "sample_db",
        used_columns: ["id", "name"],
        estimated_rows: 101885,
        estimated_total_cost: 42.5,
        future_root_field: { preserved: true },
      },
      query_type: "select",
      json_schema_version: "2.0",
      future_envelope_field: "preserved",
    }),
  );

  assert.equal(parsed.root.structure, "query_plan");
  assert.equal(parsed.root.nodeType, "Table Scan");
  assert.equal(parsed.root.relationName, "sample_table");
  assert.equal(parsed.root.estimatedRows, 101885);
  assert.equal(parsed.root.mysql.accessType, "table");
  assert.deepEqual(parsed.root.mysql.usedColumns, ["id", "name"]);
  assert.equal(parsed.root.mysql.schemaName, "sample_db");
  assert.equal(parsed.root.mysql.estimatedTotalCost, 42.5);
  assert.equal(parsed.root.mysql.jsonSchemaVersion, "2.0");
  assert.deepEqual(parsed.root.extra, { future_envelope_field: "preserved", future_root_field: { preserved: true } });
});

test("recursively preserves V2 inputs order and parent-child relationships", () => {
  const parsed = parseMySqlJsonPlan(
    mysqlInput({
      query_plan: {
        operation: "Inner hash join",
        access_type: "join",
        join_type: "inner join",
        join_algorithm: "hash",
        join_columns: ["a.id", "b.id"],
        hash_condition: ["(a.id = b.id)"],
        estimated_rows: 10,
        inputs: [
          { operation: "Table scan on a", table_name: "a", access_type: "table", estimated_rows: 100 },
          {
            operation: "Filter: (b.id > 0)",
            access_type: "filter",
            condition: "(b.id > 0)",
            filter_columns: ["b.id"],
            estimated_rows: 20,
            inputs: [{ operation: "Table scan on b", table_name: "b", access_type: "table", estimated_rows: 200 }],
          },
        ],
      },
      json_schema_version: "2.0",
    }),
  );

  assert.equal(parsed.root.nodeType, "Hash Join");
  assert.equal(parsed.root.mysql.joinType, "inner join");
  assert.equal(parsed.root.mysql.joinAlgorithm, "hash");
  assert.deepEqual(parsed.root.mysql.joinColumns, ["a.id", "b.id"]);
  assert.deepEqual(parsed.root.mysql.hashCondition, ["(a.id = b.id)"]);
  assert.deepEqual(parsed.root.children.map((node) => node.nodeType), ["Table Scan", "Filter"]);
  assert.equal(parsed.root.children[0].relationName, "a");
  assert.equal(parsed.root.children[1].filter, "(b.id > 0)");
  assert.deepEqual(parsed.root.children[1].mysql.filterColumns, ["b.id"]);
  assert.equal(parsed.root.children[1].children[0].relationName, "b");
});

test("preserves unknown V2 node fields and both recursive input arrays", () => {
  const parsed = parseMySqlJsonPlan(
    mysqlInput({
      json_schema_version: "2.0",
      query_plan: {
        operation: "Stream",
        access_type: "stream",
        future_node_field: { keep: [1, 2] },
        inputs_from_select_list: [{ operation: "Table scan on select_list", access_type: "table", table_name: "select_list" }],
        inputs: [{ operation: "Table scan on input", access_type: "table", table_name: "input" }],
      },
    }),
  );

  assert.deepEqual(parsed.root.extra, { future_node_field: { keep: [1, 2] } });
  assert.deepEqual(parsed.root.children.map((node) => node.relationName), ["select_list", "input"]);
});

test("fails closed for ambiguous, versionless, unknown-version, and malformed V2 envelopes", () => {
  const cases = [
    [
      "query_plan without schema version",
      { query_plan: { operation: "Table scan", access_type: "table" } },
      "MISSING_SCHEMA_VERSION",
    ],
    [
      "unknown schema version",
      { json_schema_version: "3.0", query_plan: {} },
      "UNSUPPORTED_SCHEMA_VERSION",
    ],
    [
      "query_plan node has no operation",
      { json_schema_version: "2.0", query_plan: { access_type: "table", future_secret: "must not leak" } },
      "MALFORMED_NODE",
    ],
    [
      "mixed V1 and V2 shapes",
      { query_block: {}, query_plan: {}, json_schema_version: "2.0" },
      "AMBIGUOUS_SCHEMA",
    ],
    [
      "inputs is not an array",
      { json_schema_version: "2.0", query_plan: { operation: "Join", access_type: "join", inputs: "not-array" } },
      "MALFORMED_NODE",
    ],
    [
      "inputs is empty",
      { json_schema_version: "2.0", query_plan: { operation: "Join", access_type: "join", inputs: [] } },
      "MALFORMED_NODE",
    ],
    [
      "estimated rows is not numeric",
      { json_schema_version: "2.0", query_plan: { operation: "Table scan", access_type: "table", estimated_rows: "101885" } },
      "MALFORMED_NODE",
    ],
  ];

  for (const [label, payload, code] of cases) {
    assert.throws(
      () => parseMySqlJsonPlan(mysqlInput(payload)),
      (error) => error instanceof PlanParseError && error.code === code,
      label,
    );
  }
});
