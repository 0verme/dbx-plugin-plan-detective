import assert from "node:assert/strict";
import test from "node:test";
import {
  HostPlanError,
  MAX_PLUGIN_PLAN_TIMEOUT_MS,
  PLAN_API_STATES,
  classifyHostMessage,
  describePlanApi,
  explainEstimatedPlan,
  getPlanCapabilities,
  resolvePlanBridge,
} from "../../src/host/index.js";
import { createSdkBridge } from "../helpers/sdk-bridge.js";

/**
 * The host boundary is the only place that talks to `window.dbxPlugin`. These
 * tests lock the merged t8y2/dbx#9692 contract without a live DBX host:
 * method presence, the exact request the bridge receives, the `"estimated"`
 * mode, response validation, and the error-code mapping for every documented
 * host failure.
 */

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
    rawPlan: [{ Plan: { "Node Type": "Seq Scan" } }],
    truncated: false,
    warnings: [],
    ...overrides,
  };
}

function fakeBridge(overrides = {}) {
  return {
    capabilities: { downloadFile: false, planApi: true },
    getPlanCapabilities: async () => capabilities(),
    explainPlan: async () => planResult(),
    ...overrides,
  };
}

function assertHostError(label, run, code) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof HostPlanError, `${label}: expected HostPlanError, got ${error?.name ?? typeof error}`);
    assert.equal(error.code, code, `${label}: ${error.message}`);
    return;
  }
  assert.fail(`${label}: expected HostPlanError with code ${code}`);
}

async function assertRejectsHostError(label, promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HostPlanError, `${label}: expected HostPlanError, got ${error?.name ?? typeof error}`);
    assert.equal(error.code, code, `${label}: ${error.message}`);
    return;
  }
  assert.fail(`${label}: expected HostPlanError with code ${code}`);
}

test("resolvePlanBridge only accepts the injected dbxPlugin object", () => {
  assert.equal(resolvePlanBridge({}), null);
  assert.equal(resolvePlanBridge({ dbxPlugin: null }), null);
  assert.equal(resolvePlanBridge({ dbxPlugin: "bridge" }), null);

  const bridge = fakeBridge();
  assert.equal(resolvePlanBridge({ dbxPlugin: bridge }), bridge);
});

test("describePlanApi gates on capabilities.planApi instead of method presence", () => {
  assert.deepEqual(describePlanApi(null), {
    state: PLAN_API_STATES.unavailable,
    available: false,
    advertised: false,
    missing: ["getPlanCapabilities", "explainPlan"],
    reason: "当前不在 DBX 宿主中：window.dbxPlugin 不存在。",
  });

  // An old host with no init surface left to wait for: fail closed.
  const oldHost = describePlanApi({ capabilities: { planApi: false }, request: () => {} });
  assert.equal(oldHost.state, PLAN_API_STATES.unavailable);
  assert.equal(oldHost.available, false);
  assert.equal(oldHost.advertised, false);
  assert.deepEqual(oldHost.missing, ["getPlanCapabilities", "explainPlan"]);

  // capability false with both methods present is still unavailable.
  const disabled = describePlanApi({
    capabilities: { downloadFile: true, planApi: false },
    getPlanCapabilities: () => {},
    explainPlan: () => {},
  });
  assert.equal(disabled.state, PLAN_API_STATES.unavailable);
  assert.equal(disabled.available, false);
  assert.deepEqual(disabled.missing, []);

  // capability absent with both methods present is unavailable too.
  const absent = describePlanApi({
    capabilities: { downloadFile: true },
    getPlanCapabilities: () => {},
    explainPlan: () => {},
  });
  assert.equal(absent.state, PLAN_API_STATES.unavailable);
  assert.equal(absent.available, false);

  // capability true with a missing method fails closed.
  const halfHost = describePlanApi({ capabilities: { planApi: true }, getPlanCapabilities: () => {} });
  assert.equal(halfHost.state, PLAN_API_STATES.unavailable);
  assert.equal(halfHost.advertised, true);
  assert.deepEqual(halfHost.missing, ["explainPlan"]);

  // capability true with both methods is the only available combination.
  const full = describePlanApi(fakeBridge());
  assert.equal(full.state, PLAN_API_STATES.available);
  assert.equal(full.available, true);
  assert.equal(full.advertised, true);
  assert.deepEqual(full.missing, []);
  assert.equal(full.reason, null);
});

test("a pre-init bridge is initializing, not unavailable", () => {
  const bridge = createSdkBridge();

  const api = describePlanApi(bridge);
  assert.equal(api.state, PLAN_API_STATES.initializing);
  assert.equal(api.available, false);
  assert.equal(api.advertised, false);
  assert.match(api.reason, /初始化/);

  bridge.sendInit(true);
  assert.equal(describePlanApi(bridge, { initialized: true }).state, PLAN_API_STATES.available);
});

test("init without a planApi advertisement is unavailable, not initializing", () => {
  const bridge = createSdkBridge();
  bridge.sendInit(false);

  const api = describePlanApi(bridge, { initialized: true });
  assert.equal(api.state, PLAN_API_STATES.unavailable);
  assert.equal(api.available, false);
  assert.equal(api.advertised, false);
});

test("getPlanCapabilities passes the trimmed connectionId and normalizes the answer", async () => {
  const seen = [];
  const bridge = fakeBridge({
    getPlanCapabilities: async (connectionId) => {
      seen.push(connectionId);
      return capabilities();
    },
  });

  const result = await getPlanCapabilities(bridge, "  conn-1  ");
  assert.deepEqual(seen, ["conn-1"]);
  assert.deepEqual(result, {
    dbType: "postgres",
    dbVersion: "15.19",
    supports: { estimatedPlan: true },
    limits: { maxTimeoutMs: 30_000, maxPlanBytes: 4 * 1024 * 1024 },
  });
});

test("getPlanCapabilities drops an absent dbVersion instead of inventing one", async () => {
  const bridge = fakeBridge({ getPlanCapabilities: async () => capabilities({ dbVersion: undefined }) });
  const result = await getPlanCapabilities(bridge, "conn-1");
  assert.equal(Object.hasOwn(result, "dbVersion"), false);
});

test("getPlanCapabilities rejects invalid connection ids before calling the bridge", async () => {
  let called = 0;
  const bridge = fakeBridge({
    getPlanCapabilities: async () => {
      called += 1;
      return capabilities();
    },
  });

  await assertRejectsHostError("missing id", getPlanCapabilities(bridge, ""), "INVALID_REQUEST");
  await assertRejectsHostError("non-string id", getPlanCapabilities(bridge, 42), "INVALID_REQUEST");
  await assertRejectsHostError("oversized id", getPlanCapabilities(bridge, "c".repeat(257)), "INVALID_REQUEST");
  assert.equal(called, 0);
});

test("getPlanCapabilities fails closed on a malformed answer", async () => {
  const cases = [
    ["null", null],
    ["array", []],
    ["missing dbType", capabilities({ dbType: undefined })],
    ["missing supports", { ...capabilities(), supports: undefined }],
    ["non-boolean estimatedPlan", capabilities({ supports: { estimatedPlan: "yes" } })],
    ["missing limits", { ...capabilities(), limits: undefined }],
    ["zero maxTimeoutMs", capabilities({ limits: { maxTimeoutMs: 0, maxPlanBytes: 1 } })],
    ["negative maxPlanBytes", capabilities({ limits: { maxTimeoutMs: 1, maxPlanBytes: -1 } })],
    ["non-string dbVersion", capabilities({ dbVersion: 15 })],
  ];

  for (const [label, answer] of cases) {
    const bridge = fakeBridge({ getPlanCapabilities: async () => answer });
    await assertRejectsHostError(label, getPlanCapabilities(bridge, "conn-1"), "INVALID_RESPONSE");
  }
});

test("explainEstimatedPlan sends exactly the merged request shape with mode estimated", async () => {
  const seen = [];
  const bridge = fakeBridge({
    explainPlan: async (request) => {
      seen.push(request);
      return planResult();
    },
  });

  await explainEstimatedPlan(bridge, { connectionId: "conn-1", sql: "  SELECT 1  " });
  await explainEstimatedPlan(bridge, {
    connectionId: "conn-1",
    sql: "SELECT 1",
    database: " app ",
    schema: " public ",
    timeoutMs: 12_345.6,
  });

  assert.deepEqual(seen[0], { connectionId: "conn-1", sql: "SELECT 1", mode: "estimated" });
  assert.deepEqual(seen[1], {
    connectionId: "conn-1",
    sql: "SELECT 1",
    mode: "estimated",
    database: "app",
    schema: "public",
    timeoutMs: 12_346,
  });
});

test("explainEstimatedPlan never sends a mode other than estimated", async () => {
  let called = 0;
  const bridge = fakeBridge({
    explainPlan: async () => {
      called += 1;
      return planResult();
    },
  });

  await assertRejectsHostError(
    "actual mode",
    explainEstimatedPlan(bridge, { connectionId: "conn-1", sql: "SELECT 1", mode: "actual" }),
    "UNSUPPORTED_MODE",
  );
  assert.equal(called, 0, "the bridge must never receive a non-estimated mode");
});

test("explainEstimatedPlan validates the SQL before the bridge sees it", async () => {
  let called = 0;
  const bridge = fakeBridge({
    explainPlan: async () => {
      called += 1;
      return planResult();
    },
  });

  await assertRejectsHostError("empty sql", explainEstimatedPlan(bridge, { connectionId: "c", sql: "   " }), "EMPTY_SQL");
  await assertRejectsHostError("non-string sql", explainEstimatedPlan(bridge, { connectionId: "c", sql: 42 }), "INVALID_REQUEST");
  await assertRejectsHostError(
    "oversized sql",
    explainEstimatedPlan(bridge, { connectionId: "c", sql: "x".repeat(200_001) }),
    "SQL_TOO_LARGE",
  );
  assert.equal(called, 0);
});

test("explainEstimatedPlan clamps timeoutMs to the host ceiling", async () => {
  const seen = [];
  const bridge = fakeBridge({
    explainPlan: async (request) => {
      seen.push(request.timeoutMs);
      return planResult();
    },
  });

  await explainEstimatedPlan(bridge, { connectionId: "c", sql: "SELECT 1", timeoutMs: 0 });
  await explainEstimatedPlan(bridge, { connectionId: "c", sql: "SELECT 1", timeoutMs: 999_999 });
  await explainEstimatedPlan(bridge, { connectionId: "c", sql: "SELECT 1" });

  assert.deepEqual(seen, [1, MAX_PLUGIN_PLAN_TIMEOUT_MS, undefined]);
});

test("explainEstimatedPlan validates the plan result before handing it on", async () => {
  const cases = [
    ["null", null],
    ["array", []],
    ["unknown format", planResult({ format: "yaml" })],
    ["json with a string plan", planResult({ rawPlan: "Seq Scan" })],
    ["text with a JSON plan", planResult({ format: "text", rawPlan: [{ Plan: {} }] })],
    ["null rawPlan", planResult({ rawPlan: null })],
    ["non-boolean truncated", planResult({ truncated: "no" })],
    ["non-array warnings", planResult({ warnings: "plan_truncated" })],
    ["non-string warning", planResult({ warnings: [42] })],
    ["plan_not_json without text", planResult({ warnings: ["plan_not_json"] })],
    ["non-string dbVersion", planResult({ dbVersion: 15 })],
  ];

  for (const [label, answer] of cases) {
    const bridge = fakeBridge({ explainPlan: async () => answer });
    await assertRejectsHostError(label, explainEstimatedPlan(bridge, { connectionId: "c", sql: "SELECT 1" }), "INVALID_RESPONSE");
  }
});

test("explainEstimatedPlan returns the host payload untouched", async () => {
  const rawPlan = [{ Plan: { "Node Type": "Seq Scan", Extra: { deep: [1, 2, 3] } } }];
  const bridge = fakeBridge({ explainPlan: async () => planResult({ rawPlan }) });

  const result = await explainEstimatedPlan(bridge, { connectionId: "c", sql: "SELECT 1" });
  assert.equal(result.rawPlan, rawPlan, "rawPlan must be passed by reference, not rewritten");
  assert.equal(result.truncated, false);
  assert.deepEqual(result.warnings, []);
});

test("a host with no plan surface fails closed before any call", async () => {
  const bridge = { request: () => {} };
  await assertRejectsHostError("capabilities", getPlanCapabilities(bridge, "c"), "PLAN_API_UNAVAILABLE");
  await assertRejectsHostError("explain", explainEstimatedPlan(bridge, { connectionId: "c", sql: "SELECT 1" }), "PLAN_API_UNAVAILABLE");
});

test("capability false with both methods present fails closed with zero host calls", async () => {
  let called = 0;
  const bridge = {
    capabilities: { downloadFile: true, planApi: false },
    getPlanCapabilities: async () => {
      called += 1;
      return capabilities();
    },
    explainPlan: async () => {
      called += 1;
      return planResult();
    },
  };

  assert.equal(describePlanApi(bridge).state, PLAN_API_STATES.unavailable);
  await assertRejectsHostError("capabilities", getPlanCapabilities(bridge, "conn-1"), "PLAN_API_UNAVAILABLE");
  await assertRejectsHostError("plan", explainEstimatedPlan(bridge, { connectionId: "conn-1", sql: "SELECT 1" }), "PLAN_API_UNAVAILABLE");
  assert.equal(called, 0, "the capability gate must not probe the host");
});

test("capability absent with both methods present fails closed with zero host calls", async () => {
  let called = 0;
  const bridge = {
    capabilities: { downloadFile: true },
    getPlanCapabilities: async () => {
      called += 1;
      return capabilities();
    },
    explainPlan: async () => {
      called += 1;
      return planResult();
    },
  };

  assert.equal(describePlanApi(bridge).state, PLAN_API_STATES.unavailable);
  await assertRejectsHostError("capabilities", getPlanCapabilities(bridge, "conn-1"), "PLAN_API_UNAVAILABLE");
  await assertRejectsHostError("plan", explainEstimatedPlan(bridge, { connectionId: "conn-1", sql: "SELECT 1" }), "PLAN_API_UNAVAILABLE");
  assert.equal(called, 0, "the capability gate must not probe the host");
});

test("a pre-init bridge fails closed, then serves calls after init", async () => {
  let called = 0;
  const bridge = createSdkBridge({
    getPlanCapabilities: async () => {
      called += 1;
      return capabilities();
    },
    explainPlan: async () => {
      called += 1;
      return planResult();
    },
  });

  assert.equal(describePlanApi(bridge).state, PLAN_API_STATES.initializing);
  await assertRejectsHostError("capabilities before init", getPlanCapabilities(bridge, "conn-1"), "PLAN_API_UNAVAILABLE");
  await assertRejectsHostError("plan before init", explainEstimatedPlan(bridge, { connectionId: "conn-1", sql: "SELECT 1" }), "PLAN_API_UNAVAILABLE");
  assert.equal(called, 0, "nothing may be called before the host init message");

  bridge.sendInit(true);
  assert.equal(describePlanApi(bridge, { initialized: true }).state, PLAN_API_STATES.available);
  const answer = await getPlanCapabilities(bridge, "conn-1");
  assert.equal(answer.dbType, "postgres");
  assert.equal(called, 1);
});

test("the UI-side guard turns a hanging host into TIMEOUT", async () => {
  const bridge = fakeBridge({ explainPlan: () => new Promise(() => {}) });
  await assertRejectsHostError(
    "hanging host",
    explainEstimatedPlan(bridge, { connectionId: "c", sql: "SELECT 1" }, { guardMs: 5 }),
    "TIMEOUT",
  );
});

test("a guardMs of null leaves the host timeout in charge", async () => {
  const bridge = fakeBridge({ explainPlan: async () => planResult() });
  const result = await explainEstimatedPlan(bridge, { connectionId: "c", sql: "SELECT 1" }, { guardMs: null });
  assert.equal(result.format, "json");
});

test("host failures map to stable codes from the upstream messages", () => {
  const cases = [
    ["Connection is not open", "CONNECTION_NOT_OPEN"],
    ["Connection config not found", "CONNECTION_NOT_FOUND"],
    ["Estimated execution plans are not available for 'redis' connections", "UNSUPPORTED_DIALECT"],
    ['Plugin plan requests support mode \'estimated\' only; \'actual\' is not available', "UNSUPPORTED_MODE"],
    ['host.explainPlan serves mode "estimated" only', "UNSUPPORTED_MODE"],
    ["Plugin plan requests need a non-empty sql", "EMPTY_SQL"],
    ["host.explainPlan requires sql", "EMPTY_SQL"],
    ["Plugin plan sql exceeds 200000 characters", "SQL_TOO_LARGE"],
    ["sql must be at most 200000 characters", "SQL_TOO_LARGE"],
    ["The requested statement is not safe to plan", "UNSAFE_SQL"],
    ["The estimated plan exceeds the 4194304 byte host limit", "PLAN_TOO_LARGE"],
    ["The database returned an empty estimated plan", "EMPTY_PLAN"],
    ["connection timed out while planning", "TIMEOUT"],
    ["Plugin has not declared permission 'host.plans:read'", "PERMISSION_NOT_DECLARED"],
    ["Host plan API is unavailable", "PLAN_API_UNAVAILABLE"],
    ["Unsupported plugin host method 'host.explainPlan'", "PLAN_API_UNAVAILABLE"],
    ["Plugin plan requests need a valid connectionId", "INVALID_REQUEST"],
    ["something new the host invented", "HOST_ERROR"],
  ];

  for (const [message, code] of cases) {
    assert.equal(classifyHostMessage(message), code, message);
  }
});

test("bridge failures are wrapped with the classified code and the host message", async () => {
  const bridge = fakeBridge({
    explainPlan: async () => {
      throw new Error("Connection is not open");
    },
  });

  await assertRejectsHostError("closed connection", explainEstimatedPlan(bridge, { connectionId: "c", sql: "SELECT 1" }), "CONNECTION_NOT_OPEN");

  try {
    await explainEstimatedPlan(bridge, { connectionId: "c", sql: "SELECT 1" });
  } catch (error) {
    assert.equal(error.hostMessage, "Connection is not open");
    assert.match(error.message, /host\.explainPlan/);
  }
});

test("host errors never serialize the raw plan payload", async () => {
  const sentinel = "RAW_PLAN_SECRET_SENTINEL";
  const bridge = fakeBridge({
    explainPlan: async () => {
      throw new Error(`plan failed near ${sentinel}`);
    },
  });

  try {
    await explainEstimatedPlan(bridge, { connectionId: "c", sql: "SELECT 1" });
    assert.fail("expected the host error to propagate");
  } catch (error) {
    assert.equal(error.code, "HOST_ERROR");
    assert.ok(error.hostMessage.includes(sentinel), "the host message itself is preserved verbatim");
    assert.equal(error.message.includes(sentinel), true, "the wrapped message keeps the host text for debugging");
  }
});
