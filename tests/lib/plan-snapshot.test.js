import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlanSnapshot,
  deserializePlanSnapshot,
  PlanSnapshotError,
  serializePlanSnapshot,
  validatePlanSnapshot,
} from "../../src/lib/plan-snapshot.js";

const NOW = new Date("2026-10-14T01:23:45.000Z");
const SNAPSHOT_ID = "snapshot-test-001";
const SQL = "SELECT '原始 SQL' AS value;";
const PLAN = [{ Plan: { "Node Type": "Seq Scan", "Relation Name": "orders", "Plan Rows": 18, "Total Cost": 7.5 } }];

function makeSession(overrides = {}) {
  return {
    status: "structured",
    capturedAt: "2026-10-14T01:20:00.000Z",
    source: { databaseName: "analytics", schema: "public" },
    rawInput: {
      database: "postgresql",
      mode: "estimated",
      format: "json",
      sql: SQL,
      databaseVersion: "17.2",
      plan: PLAN,
    },
    analysis: { status: "structured" },
    hostResult: { truncated: false, rawPlan: PLAN },
    // These session values are intentionally not part of the snapshot contract.
    bridge: { token: "must-not-be-persisted" },
    connectionId: "private-connection-id",
    capabilities: { connection: { credential: "private-credential" } },
    ...overrides,
  };
}

function makeSnapshot(overrides = {}) {
  return createPlanSnapshot({
    session: makeSession(),
    title: "索引改动前",
    note: "保存时的分析基线",
    producerVersion: "0.7.1",
    snapshotId: SNAPSHOT_ID,
    now: NOW,
    ...overrides,
  });
}

test("creates a versioned envelope from the completed session and whitelists non-sensitive provenance", () => {
  const session = makeSession({
    rawInput: { ...makeSession().rawInput, connectionId: "should-not-copy", credentials: { token: "should-not-copy" } },
    source: { databaseName: "analytics", schema: "public", connectionId: "should-not-copy", credential: "should-not-copy" },
  });
  const snapshot = makeSnapshot({ session });

  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    snapshotId: SNAPSHOT_ID,
    savedAt: NOW.toISOString(),
    capturedAt: session.capturedAt,
    title: "索引改动前",
    note: "保存时的分析基线",
    producerVersion: "0.7.1",
    rawInput: {
      database: "postgresql",
      mode: "estimated",
      format: "json",
      sql: SQL,
      databaseVersion: "17.2",
      plan: PLAN,
    },
    source: { databaseName: "analytics", schema: "public" },
  });
  assert.notStrictEqual(snapshot.rawInput.plan, session.rawInput.plan, "snapshot owns a detached plan copy");
  assert.equal(JSON.stringify(snapshot).includes("private-connection-id"), false);
  assert.equal(JSON.stringify(snapshot).includes("private-credential"), false);
  assert.equal(JSON.stringify(snapshot).includes("must-not-be-persisted"), false);
  assert.equal(JSON.stringify(snapshot).includes("should-not-copy"), false);
});

test("generates a UUID snapshot identifier when the caller does not supply one", () => {
  const snapshot = createPlanSnapshot({ session: makeSession(), title: "未命名基线", now: NOW });
  assert.match(snapshot.snapshotId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("the SQL and raw plan come from the same completed session, not later editor/connection values", () => {
  const oldSession = makeSession({
    rawInput: { ...makeSession().rawInput, sql: "SELECT * FROM baseline;", plan: [{ Plan: { "Node Type": "Seq Scan" } }] },
    source: { databaseName: "db-before", schema: "schema-before" },
  });
  const snapshot = createPlanSnapshot({
    session: oldSession,
    title: "A",
    snapshotId: SNAPSHOT_ID,
    now: NOW,
  });

  assert.equal(snapshot.rawInput.sql, "SELECT * FROM baseline;");
  assert.deepEqual(snapshot.rawInput.plan, [{ Plan: { "Node Type": "Seq Scan" } }]);
  assert.deepEqual(snapshot.source, { databaseName: "db-before", schema: "schema-before" });
});

test("JSON, text and XML RawPlanInput payloads round-trip without changing the payload", () => {
  const cases = [
    { format: "json", plan: PLAN },
    { format: "text", plan: "Seq Scan on orders  (cost=0.00..7.50 rows=18 width=4)\n  Filter: (status = '已付款')" },
    { format: "xml", plan: "<?xml version=\"1.0\"?><ShowPlanXML><RelOp /></ShowPlanXML>" },
  ];

  for (const item of cases) {
    const session = makeSession({ rawInput: { ...makeSession().rawInput, ...item } });
    const snapshot = makeSnapshot({ session });
    const restored = deserializePlanSnapshot(serializePlanSnapshot(snapshot));
    assert.equal(restored.rawInput.format, item.format);
    assert.deepEqual(restored.rawInput.plan, item.plan);
    assert.equal(restored.rawInput.sql, SQL);
  }
});

test("rejects raw-only, actual, truncated, failed and incomplete sessions", () => {
  const cases = [
    makeSession({ status: "raw-only" }),
    makeSession({ rawInput: { ...makeSession().rawInput, mode: "actual" } }),
    makeSession({ hostResult: { truncated: true } }),
    makeSession({ status: "error", analysis: null }),
    makeSession({ analysis: null }),
  ];
  for (const session of cases) {
    assert.throws(
      () => makeSnapshot({ session }),
      (error) => error instanceof PlanSnapshotError && error.code === "SNAPSHOT_NOT_COMPARABLE",
    );
  }
});

test("rejects payload/format mismatches and JSON values that would be lossy", () => {
  const invalidSessions = [
    makeSession({ rawInput: { ...makeSession().rawInput, format: "text", plan: { node: "not text" } } }),
    makeSession({ rawInput: { ...makeSession().rawInput, plan: { total: Number.NaN } } }),
    makeSession({ rawInput: { ...makeSession().rawInput, plan: { missing: undefined } } }),
  ];
  for (const session of invalidSessions) {
    assert.throws(() => makeSnapshot({ session }), PlanSnapshotError);
  }
});

test("corrupt records and unknown schema versions return distinct stable errors", () => {
  assert.throws(
    () => deserializePlanSnapshot("{ definitely not JSON"),
    (error) => error.code === "CORRUPT_SNAPSHOT",
  );

  const future = { ...makeSnapshot(), schemaVersion: 2 };
  const validation = validatePlanSnapshot(future);
  assert.equal(validation.valid, false);
  assert.equal(validation.code, "UNSUPPORTED_SNAPSHOT_VERSION");
  assert.throws(
    () => deserializePlanSnapshot(JSON.stringify(future)),
    (error) => error.code === "UNSUPPORTED_SNAPSHOT_VERSION",
  );
});

test("rejects unknown envelope fields instead of silently persisting them", () => {
  const snapshot = { ...makeSnapshot(), connection: { credential: "must-not-be-stored" } };
  const validation = validatePlanSnapshot(snapshot);
  assert.equal(validation.valid, false);
  assert.equal(validation.code, "INVALID_SNAPSHOT");
});

test("validates title and metadata limits", () => {
  assert.throws(() => makeSnapshot({ title: "   " }), PlanSnapshotError);
  assert.throws(() => makeSnapshot({ title: "x".repeat(121) }), PlanSnapshotError);
  assert.throws(() => makeSnapshot({ note: "x".repeat(2_001) }), PlanSnapshotError);
});
