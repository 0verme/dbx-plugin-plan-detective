import assert from "node:assert/strict";
import test from "node:test";
import { idleAnalysis, loadPlanCapabilities, loadingAnalysis, runHostAnalysis } from "../../src/lib/analysis-session.js";
import { loadFixture } from "../helpers/fixtures.js";

/**
 * The analysis session is the only orchestration path from a DBX connection to
 * a renderable result. These tests drive the whole state machine with a fake
 * bridge: capability gate, one estimated plan request, adapter, parser registry
 * and every documented failure state.
 */

const postgresFixture = await loadFixture({ mode: "estimated", name: "large-seq-scan" });
const postgresRawPlan = postgresFixture.input.plan;

function capabilities(overrides = {}) {
  return {
    dbType: "postgres",
    dbVersion: "15.19",
    supports: { estimatedPlan: true },
    limits: { maxTimeoutMs: 30_000, maxPlanBytes: 4 * 1024 * 1024 },
    ...overrides,
  };
}

function planResult(overrides = {}) {
  return {
    dbType: "postgres",
    dbVersion: "15.19",
    format: "json",
    rawPlan: postgresRawPlan,
    truncated: false,
    warnings: [],
    ...overrides,
  };
}

function fakeBridge(overrides = {}) {
  return {
    capabilities: { planApi: true },
    getPlanCapabilities: async () => capabilities(),
    explainPlan: async () => planResult(),
    ...overrides,
  };
}

const REQUEST = { connectionId: "conn-1", sql: "SELECT * FROM pd_fix_orders;" };

test("idle and loading are explicit states, not null", () => {
  assert.deepEqual(idleAnalysis(), { status: "idle" });
  assert.deepEqual(loadingAnalysis(), { status: "loading" });
});

test("loadPlanCapabilities reports ready without acquiring a plan", async () => {
  let explained = 0;
  const bridge = fakeBridge({
    explainPlan: async () => {
      explained += 1;
      return planResult();
    },
  });

  const result = await loadPlanCapabilities({ bridge, connectionId: "conn-1" });
  assert.equal(result.status, "ready");
  assert.equal(result.capabilities.dbType, "postgres");
  assert.equal(explained, 0);
});

test("loadPlanCapabilities reports a closed connection as an error state", async () => {
  const bridge = fakeBridge({
    getPlanCapabilities: async () => {
      throw new Error("Connection is not open");
    },
  });

  const result = await loadPlanCapabilities({ bridge, connectionId: "conn-1" });
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "CONNECTION_NOT_OPEN");
});

test("runHostAnalysis acquires capabilities first and sends one estimated plan", async () => {
  const calls = [];
  const bridge = fakeBridge({
    getPlanCapabilities: async (connectionId) => {
      calls.push(["capabilities", connectionId]);
      return capabilities();
    },
    explainPlan: async (request) => {
      calls.push(["explain", request]);
      return planResult();
    },
  });

  const session = await runHostAnalysis({ ...REQUEST, bridge });

  assert.deepEqual(calls, [
    ["capabilities", "conn-1"],
    ["explain", { connectionId: "conn-1", sql: REQUEST.sql, mode: "estimated" }],
  ]);
  assert.equal(session.status, "structured");
  assert.equal(session.capabilities.dbType, "postgres");
  assert.equal(session.hostResult.format, "json");
  assert.equal(session.rawInput.database, "postgresql");
  assert.equal(session.analysis.status, "structured");
  assert.deepEqual(
    session.analysis.findings.map((finding) => finding.ruleId),
    postgresFixture.meta.expect.findingRuleIds,
  );
});

test("runHostAnalysis does not acquire a plan when the dialect is unsupported", async () => {
  let explained = 0;
  const bridge = fakeBridge({
    getPlanCapabilities: async () => capabilities({ dbType: "redis", supports: { estimatedPlan: false } }),
    explainPlan: async () => {
      explained += 1;
      return planResult();
    },
  });

  const session = await runHostAnalysis({ ...REQUEST, bridge });
  assert.equal(session.status, "unsupported");
  assert.equal(session.capabilities.dbType, "redis");
  assert.equal(explained, 0);
  assert.match(session.message, /redis/);
});

test("runHostAnalysis reports a closed connection without probing the plan path", async () => {
  let explained = 0;
  const bridge = fakeBridge({
    getPlanCapabilities: async () => {
      throw new Error("Connection is not open");
    },
    explainPlan: async () => {
      explained += 1;
      return planResult();
    },
  });

  const session = await runHostAnalysis({ ...REQUEST, bridge });
  assert.equal(session.status, "error");
  assert.equal(session.error.code, "CONNECTION_NOT_OPEN");
  assert.equal(session.error.hostMessage, "Connection is not open");
  assert.equal(explained, 0);
});

test("runHostAnalysis fails closed when the host has no plan API", async () => {
  const session = await runHostAnalysis({ ...REQUEST, bridge: { request: () => {} } });
  assert.equal(session.status, "error");
  assert.equal(session.error.code, "PLAN_API_UNAVAILABLE");
});

test("runHostAnalysis keeps the raw host result for a raw-only dialect", async () => {
  const bridge = fakeBridge({
    getPlanCapabilities: async () => capabilities({ dbType: "mysql" }),
    explainPlan: async () =>
      planResult({ dbType: "mysql", rawPlan: { query_block: { table: { table_name: "orders" } } } }),
  });

  const session = await runHostAnalysis({ ...REQUEST, bridge });
  assert.equal(session.status, "raw-only");
  assert.equal(session.rawInput.database, "mysql");
  assert.equal(session.analysis.reasonCode, "PARSER_NOT_IMPLEMENTED");
  assert.deepEqual(session.analysis.findings, []);
  assert.deepEqual(session.hostResult.rawPlan, { query_block: { table: { table_name: "orders" } } });
});

test("runHostAnalysis refuses to parse a truncated plan and keeps it for display", async () => {
  const bridge = fakeBridge({
    explainPlan: async () => planResult({ truncated: true, warnings: ["plan_truncated"] }),
  });

  const session = await runHostAnalysis({ ...REQUEST, bridge });
  assert.equal(session.status, "truncated");
  assert.equal(session.rawInput, null);
  assert.equal(session.analysis, null);
  assert.equal(session.hostResult.truncated, true);
  assert.match(session.message, /截断/);
});

test("runHostAnalysis maps adapter and parser failures to error states", async () => {
  const adapterFailure = await runHostAnalysis({
    ...REQUEST,
    bridge: fakeBridge({ explainPlan: async () => planResult({ format: "yaml", rawPlan: "plan: yes" }) }),
  });
  assert.equal(adapterFailure.status, "error");
  assert.equal(adapterFailure.error.code, "INVALID_RESPONSE");

  const parserFailure = await runHostAnalysis({
    ...REQUEST,
    bridge: fakeBridge({ explainPlan: async () => planResult({ rawPlan: [{ NotAPlan: true }] }) }),
  });
  assert.equal(parserFailure.status, "error");
  assert.equal(parserFailure.error.code, "PLAN_PARSE_FAILED");
});

test("runHostAnalysis maps every documented host failure without a generic fallback", async () => {
  const cases = [
    ["The requested statement is not safe to plan", "UNSAFE_SQL"],
    ["Estimated execution plans are not available for 'redis' connections", "UNSUPPORTED_DIALECT"],
    ["The estimated plan exceeds the 4194304 byte host limit", "PLAN_TOO_LARGE"],
    ["The database returned an empty estimated plan", "EMPTY_PLAN"],
    ["connection timed out while planning", "TIMEOUT"],
    ["Plugin plan requests need a valid connectionId", "INVALID_REQUEST"],
  ];

  for (const [message, code] of cases) {
    const bridge = fakeBridge({
      explainPlan: async () => {
        throw new Error(message);
      },
    });
    const session = await runHostAnalysis({ ...REQUEST, bridge });
    assert.equal(session.status, "error", message);
    assert.equal(session.error.code, code, message);
    assert.equal(session.error.hostMessage, message);
  }
});

test("runHostAnalysis rejects empty SQL before calling the host", async () => {
  let explained = 0;
  const bridge = fakeBridge({
    explainPlan: async () => {
      explained += 1;
      return planResult();
    },
  });

  const session = await runHostAnalysis({ ...REQUEST, sql: "   ", bridge });
  assert.equal(session.status, "error");
  assert.equal(session.error.code, "EMPTY_SQL");
  assert.equal(explained, 0);
});

test("runHostAnalysis passes database and schema through to the host request", async () => {
  const seen = [];
  const bridge = fakeBridge({
    explainPlan: async (request) => {
      seen.push(request);
      return planResult();
    },
  });

  await runHostAnalysis({ ...REQUEST, database: "analytics", schema: "public", timeoutMs: 5_000, bridge });
  assert.deepEqual(seen[0], {
    connectionId: "conn-1",
    sql: REQUEST.sql,
    mode: "estimated",
    database: "analytics",
    schema: "public",
    timeoutMs: 5_000,
  });
});

test("session errors never carry the raw plan payload", async () => {
  const sentinel = "RAW_PLAN_SECRET_SENTINEL";
  const bridge = fakeBridge({
    explainPlan: async () => planResult({ rawPlan: [{ Plan: { Detail: sentinel } }], truncated: true }),
  });

  const session = await runHostAnalysis({ ...REQUEST, bridge });
  assert.equal(session.status, "truncated");
  assert.equal(JSON.stringify({ ...session, hostResult: undefined }).includes(sentinel), false);
});
