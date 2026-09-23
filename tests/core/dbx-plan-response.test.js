import assert from "node:assert/strict";
import test from "node:test";
import { adaptDbxEstimatedPlanResponse } from "../../src/core/adapter/dbx-plan-response.js";
import { analyzePlan } from "../../src/core/analyze.js";
import { DbxPlanAdapterError } from "../../src/core/errors.js";
import { createRawPlanInput, validateRawPlanInput } from "../../src/core/raw-plan-input.js";
import { listFixtureNames, loadFixture } from "../helpers/fixtures.js";

/**
 * The adapter is the only DBX-aware boundary. These tests pin the response
 * shape to t8y2/dbx#9692 (`PluginPlanResult`) and the fail-closed policy:
 * unknown databases, unknown formats and incomplete payloads must throw a
 * stable error instead of degrading into a plausible-looking analysis.
 *
 * Every dialect the merged host contract can return maps to a Plan Core family
 * (structured or raw-only); only a dbType the contract cannot produce is
 * rejected.
 */

/** Minimal well-formed response matching the #9692 `PluginPlanResult` shape. */
function dbxResponse(overrides = {}) {
  return {
    dbType: "postgres",
    dbVersion: "15.19",
    format: "json",
    rawPlan: [{ Plan: { "Node Type": "Seq Scan" } }],
    truncated: false,
    warnings: [],
    ...overrides,
  };
}

/** Wrap the committed fixture payload exactly like a host response would. */
function mockDbxResponseFor(loaded) {
  return {
    dbType: "postgres",
    ...(loaded.meta.databaseVersion === null ? {} : { dbVersion: loaded.meta.databaseVersion }),
    format: "json",
    rawPlan: loaded.plan,
    truncated: false,
    warnings: [],
  };
}

function assertAdapterError(label, run, code) {
  try {
    run();
  } catch (error) {
    assert.ok(
      error instanceof DbxPlanAdapterError,
      `${label}: expected DbxPlanAdapterError, got ${error?.name ?? typeof error}: ${error?.message}`,
    );
    assert.equal(error.code, code, `${label}: ${error.message}`);
    return;
  }
  assert.fail(`${label}: expected DbxPlanAdapterError with code ${code}`);
}

test("maps a PostgreSQL JSON estimated response to RawPlanInput", () => {
  const response = dbxResponse();
  const input = adaptDbxEstimatedPlanResponse(response);

  assert.deepEqual(input, {
    database: "postgresql",
    mode: "estimated",
    format: "json",
    plan: response.rawPlan,
    databaseVersion: "15.19",
  });
  assert.equal(input.plan, response.rawPlan, "rawPlan must be passed by reference, not rewritten");
  assert.deepEqual(validateRawPlanInput(input), []);
  assert.deepEqual(input, createRawPlanInput(input));
});

test("adapter output exposes exactly the RawPlanInput contract", () => {
  const input = adaptDbxEstimatedPlanResponse(dbxResponse());
  assert.deepEqual(Object.keys(input).sort(), ["database", "databaseVersion", "format", "mode", "plan"]);
});

test("maps Native MySQL and OceanBase MySQL conservatively from dbType plus dbVersion", () => {
  for (const dbVersion of ["8.0.36", "5.7.44"]) {
    assert.equal(adaptDbxEstimatedPlanResponse(dbxResponse({ dbType: "mysql", dbVersion })).database, "mysql");
  }

  const oceanBaseVersion = "5.7.25-OceanBase-v4.2.5.7";
  const oceanBase = adaptDbxEstimatedPlanResponse(dbxResponse({ dbType: "mysql", dbVersion: oceanBaseVersion }));
  assert.equal(oceanBase.database, "oceanbase-mysql");
  assert.equal(oceanBase.databaseVersion, oceanBaseVersion);

  const mixedCase = adaptDbxEstimatedPlanResponse(dbxResponse({ dbType: "mysql", dbVersion: "5.7.25-oCeAnBaSe-v4.2.5.7" }));
  assert.equal(mixedCase.database, "oceanbase-mysql", "OceanBase version evidence is case-insensitive");
});

test("does not infer OceanBase from Raw Plan shape when dbVersion has no OceanBase evidence", () => {
  const input = adaptDbxEstimatedPlanResponse(
    dbxResponse({
      dbType: "mysql",
      dbVersion: undefined,
      rawPlan: { ID: 0, OPERATOR: "TABLE FULL SCAN", "EST.ROWS": 47_383 },
    }),
  );
  assert.equal(input.database, "mysql");
});

test("maps every dbType the merged host contract can return", () => {
  const cases = [
    ["postgres", "postgresql"],
    ["mysql", "mysql"],
    ["sqlserver", "sqlserver"],
    ["oracle", "oracle"],
    ["oceanbase-oracle", "oceanbase-oracle"],
    ["doris", "doris"],
    ["dameng", "dameng"],
    ["questdb", "questdb"],
  ];

  for (const [dbType, database] of cases) {
    const input = adaptDbxEstimatedPlanResponse(dbxResponse({ dbType }));
    assert.equal(input.database, database, `${dbType} must map to ${database}`);
    assert.equal(input.mode, "estimated");
  }
});

test("accepts json, xml and text formats without parsing them", () => {
  const json = adaptDbxEstimatedPlanResponse(dbxResponse());
  assert.equal(json.format, "json");

  const xml = adaptDbxEstimatedPlanResponse(
    dbxResponse({ dbType: "sqlserver", format: "xml", rawPlan: "<ShowPlanXML><BatchSequence/></ShowPlanXML>" }),
  );
  assert.equal(xml.format, "xml");
  assert.equal(xml.plan, "<ShowPlanXML><BatchSequence/></ShowPlanXML>");

  const text = adaptDbxEstimatedPlanResponse(
    dbxResponse({ dbType: "dameng", format: "text", rawPlan: "1 #NSET2: [0, 1, 0]" }),
  );
  assert.equal(text.format, "text");
  assert.equal(text.plan, "1 #NSET2: [0, 1, 0]");
});

test("plan_not_json is accepted as text because the host already downgraded the format", () => {
  const input = adaptDbxEstimatedPlanResponse(
    dbxResponse({ format: "text", rawPlan: "Seq Scan on pd_fix_orders", warnings: ["plan_not_json"] }),
  );
  assert.equal(input.format, "text");
  assert.equal(input.plan, "Seq Scan on pd_fix_orders");
});

test("keeps optional sql and databaseVersion as display provenance", () => {
  const withSql = adaptDbxEstimatedPlanResponse(dbxResponse(), { sql: "SELECT * FROM pd_fix_orders;" });
  assert.equal(withSql.sql, "SELECT * FROM pd_fix_orders;");
  assert.equal(withSql.databaseVersion, "15.19");

  const withoutOptional = adaptDbxEstimatedPlanResponse(dbxResponse({ dbVersion: undefined }));
  assert.equal(Object.hasOwn(withoutOptional, "sql"), false);
  assert.equal(Object.hasOwn(withoutOptional, "databaseVersion"), false);
});

test("null optional provenance is treated as absent, matching RawPlanInput", () => {
  assert.equal(Object.hasOwn(adaptDbxEstimatedPlanResponse(dbxResponse(), { sql: null }), "sql"), false);
  assert.equal(Object.hasOwn(adaptDbxEstimatedPlanResponse(dbxResponse(), null), "sql"), false);
  assert.equal(Object.hasOwn(adaptDbxEstimatedPlanResponse(dbxResponse(), undefined), "sql"), false);
});

test("unknown response and option keys are ignored on purpose", () => {
  const input = adaptDbxEstimatedPlanResponse(
    dbxResponse({ requestId: "abc", limits: { maxPlanBytes: 4 * 1024 * 1024 } }),
    { sql: "select 1", timeoutMs: 15_000 },
  );
  assert.deepEqual(Object.keys(input).sort(), ["database", "databaseVersion", "format", "mode", "plan", "sql"]);
});

test("every committed estimated fixture survives mock response -> adapter -> analyzePlan()", async () => {
  const names = await listFixtureNames("estimated");
  assert.ok(names.length > 0, "expected committed estimated fixtures");

  for (const name of names) {
    const loaded = await loadFixture({ mode: "estimated", name });
    const adapted = adaptDbxEstimatedPlanResponse(mockDbxResponseFor(loaded), { sql: loaded.meta.sql });

    assert.equal(adapted.plan, loaded.plan, `${name}: adapter must not rewrite rawPlan`);
    assert.deepEqual(adapted, loaded.input, `${name}: adapter output must equal the fixture RawPlanInput`);
    assert.deepEqual(analyzePlan(adapted), analyzePlan(loaded.input), `${name}: analysis result must match`);
  }
});

test("adapter output reaches the existing rule engine unchanged", async () => {
  const loaded = await loadFixture({ mode: "estimated", name: "large-seq-scan" });
  const adapted = adaptDbxEstimatedPlanResponse(mockDbxResponseFor(loaded), { sql: loaded.meta.sql });

  const { findings } = analyzePlan(adapted);
  assert.deepEqual(findings.map((finding) => finding.ruleId), loaded.meta.expect.findingRuleIds);
  assert.deepEqual(findings, analyzePlan(loaded.input).findings);
});

test("malformed responses fail closed with INVALID_DBX_PLAN_RESPONSE", () => {
  const cases = [
    ["null response", null],
    ["undefined response", undefined],
    ["array response", []],
    ["string response", "plan"],
    ["number response", 42],
    ["boolean response", true],
    ["missing dbType", dbxResponse({ dbType: undefined })],
    ["non-string dbType", dbxResponse({ dbType: 42 })],
    ["empty dbType", dbxResponse({ dbType: "" })],
    ["missing format", dbxResponse({ format: undefined })],
    ["non-string format", dbxResponse({ format: ["json"] })],
    ["missing rawPlan", dbxResponse({ rawPlan: undefined })],
    ["null rawPlan", dbxResponse({ rawPlan: null })],
    ["missing warnings", dbxResponse({ warnings: undefined })],
    ["non-array warnings", dbxResponse({ warnings: "plan_truncated" })],
    ["non-string warning", dbxResponse({ warnings: [42] })],
    ["missing truncated", dbxResponse({ truncated: undefined })],
    ["non-boolean truncated", dbxResponse({ truncated: "false" })],
    ["null dbVersion", dbxResponse({ dbVersion: null })],
    ["non-string dbVersion", dbxResponse({ dbVersion: 15.19 })],
    ["json format with a string plan", dbxResponse({ rawPlan: "Seq Scan" })],
    ["text format with a JSON plan", dbxResponse({ format: "text", rawPlan: [{ Plan: {} }] })],
    ["plan_not_json with json format", dbxResponse({ warnings: ["plan_not_json"] })],
  ];

  for (const [label, response] of cases) {
    assertAdapterError(label, () => adaptDbxEstimatedPlanResponse(response), "INVALID_DBX_PLAN_RESPONSE");
  }
});

test("a dbType the merged contract cannot return fails closed with UNSUPPORTED_DB_TYPE", () => {
  // `postgresql` is Plan Core's family name, not DBX's dbType vocabulary; the
  // rest are dialects without a host estimated-plan path.
  for (const dbType of ["sqlite", "postgresql", "MYSQL", "gaussdb", "redis", "unknown-db"]) {
    assertAdapterError(`dbType ${dbType}`, () => adaptDbxEstimatedPlanResponse(dbxResponse({ dbType })), "UNSUPPORTED_DB_TYPE");
  }

  assert.throws(
    () => adaptDbxEstimatedPlanResponse(dbxResponse({ dbType: "sqlite" })),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_DB_TYPE");
      assert.match(error.message, /sqlite/);
      return true;
    },
  );
});

test("a format outside the merged contract fails closed with UNSUPPORTED_PLAN_FORMAT", () => {
  for (const format of ["yaml", "showplan", "JSON"]) {
    assertAdapterError(
      `format ${format}`,
      () => adaptDbxEstimatedPlanResponse(dbxResponse({ format, rawPlan: "Seq Scan on pd_fix_orders" })),
      "UNSUPPORTED_PLAN_FORMAT",
    );
  }

  assert.throws(
    () => adaptDbxEstimatedPlanResponse(dbxResponse({ format: "yaml", rawPlan: "plan: yes" })),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_PLAN_FORMAT");
      assert.match(error.message, /yaml/);
      return true;
    },
  );
});

test("truncation signals fail closed with PLAN_TRUNCATED", () => {
  assertAdapterError(
    "truncated flag",
    () => adaptDbxEstimatedPlanResponse(dbxResponse({ truncated: true })),
    "PLAN_TRUNCATED",
  );
  assertAdapterError(
    "plan_truncated warning",
    () => adaptDbxEstimatedPlanResponse(dbxResponse({ format: "text", rawPlan: "cut off", truncated: true, warnings: ["plan_truncated"] })),
    "PLAN_TRUNCATED",
  );
  assertAdapterError(
    "plan_rows_truncated warning",
    () => adaptDbxEstimatedPlanResponse(dbxResponse({ truncated: true, warnings: ["plan_rows_truncated"] })),
    "PLAN_TRUNCATED",
  );
  assertAdapterError(
    "truncation warning without the flag",
    () => adaptDbxEstimatedPlanResponse(dbxResponse({ format: "text", rawPlan: "cut off", truncated: false, warnings: ["plan_rows_truncated"] })),
    "PLAN_TRUNCATED",
  );
});

test("unknown warnings are ignored instead of crashing and never enter the output", () => {
  const input = adaptDbxEstimatedPlanResponse(dbxResponse({ warnings: ["plan_future_unknown", "another_note"] }));
  assert.equal(Object.hasOwn(input, "warnings"), false);
  assert.deepEqual(validateRawPlanInput(input), []);
});

test("adapter errors never serialize the raw plan payload", () => {
  const sentinel = "RAW_PLAN_SECRET_SENTINEL";
  const response = dbxResponse({ rawPlan: [{ Plan: { "Node Type": "Seq Scan", Detail: sentinel } }], truncated: true });

  assert.throws(
    () => adaptDbxEstimatedPlanResponse(response),
    (error) => {
      assert.ok(error instanceof DbxPlanAdapterError);
      assert.equal(error.code, "PLAN_TRUNCATED");
      assert.equal(error.message.includes(sentinel), false, "message must not leak the payload");
      assert.equal(String(error.stack).includes(sentinel), false, "stack must not leak the payload");
      return true;
    },
  );
});

test("invalid adapter options fail closed with INVALID_ADAPTER_OPTIONS", () => {
  const cases = [
    ["string options", "SELECT 1"],
    ["array options", []],
    ["number options", 42],
    ["non-string sql", { sql: 42 }],
    ["object sql", { sql: { text: "SELECT 1" } }],
  ];

  for (const [label, options] of cases) {
    assertAdapterError(label, () => adaptDbxEstimatedPlanResponse(dbxResponse(), options), "INVALID_ADAPTER_OPTIONS");
  }
});
