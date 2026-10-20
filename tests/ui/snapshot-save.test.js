import assert from "node:assert/strict";
import test from "node:test";
import { createSnapshotSaveHandler } from "../../src/lib/snapshot-save-action.js";
import {
  createPlanSnapshotRepository,
  PLAN_SNAPSHOT_STORAGE_KEY,
  PlanSnapshotStoreError,
} from "../../src/lib/plan-snapshot-store.js";

const SESSION = {
  status: "structured",
  capturedAt: "2026-10-14T01:20:00.000Z",
  source: { databaseName: "analytics", schema: "public" },
  rawInput: {
    database: "postgresql",
    mode: "estimated",
    format: "json",
    sql: "SELECT * FROM orders;",
    databaseVersion: "17.2",
    plan: [{ Plan: { "Node Type": "Seq Scan", "Relation Name": "orders", "Plan Rows": 18 } }],
  },
  analysis: { status: "structured" },
  hostResult: { truncated: false },
};

function createHarness(overrides = {}) {
  const calls = [];
  const state = {
    repository: {
      async save(snapshot) { calls.push(["save", snapshot]); },
      async list() { calls.push(["list"]); return []; },
    },
    storageAvailable: true,
    loadState: "ready",
    loadError: null,
    currentSession: SESSION,
    saveTitle: "Snapshot baseline",
    saveNote: "Test note",
    producerVersion: "0.7.1",
    ...overrides,
  };
  const errors = [];
  const statuses = [];
  const saving = [];
  const successes = [];
  const events = [];
  let handler;
  handler = createSnapshotSaveHandler({
    getState: () => state,
    setSaving: (value) => saving.push(value),
    clearFeedback: () => { errors.length = 0; statuses.length = 0; },
    setDuplicateMessage: () => statuses.push("in-progress"),
    setError: (error) => errors.push(error),
    onSuccess: (snapshot) => { successes.push(snapshot); events.push("success"); },
    refresh: async (repository) => {
      calls.push(["refresh"]);
      events.push("refresh");
      return repository.list();
    },
  });
  const event = () => ({ preventDefault() { calls.push(["preventDefault"]); } });
  return { calls, state, errors, statuses, saving, successes, events, handler, event };
}

test("successful save writes through Host Storage, reports success, and starts a history refresh", async () => {
  const calls = [];
  let document = null;
  const bridge = {
    capabilities: { storage: true },
    storage: {
      async get(key) {
        calls.push(["get", key]);
        return key === PLAN_SNAPSHOT_STORAGE_KEY && document !== null ? structuredClone(document) : null;
      },
      async set(key, value) {
        calls.push(["set", key, structuredClone(value)]);
        if (key === PLAN_SNAPSHOT_STORAGE_KEY) document = structuredClone(value);
      },
      async delete(key) { calls.push(["delete", key]); },
    },
  };
  const repository = createPlanSnapshotRepository(bridge);
  const harness = createHarness({ repository });
  const result = await harness.handler(harness.event());

  assert.equal(result.status, "saved");
  assert.equal(calls.filter(([name]) => name === "set").length, 1, "one Host storage.set call commits the snapshot document");
  assert.equal(harness.calls.some(([name]) => name === "refresh"), true);
  assert.ok(harness.events.indexOf("success") < harness.events.indexOf("refresh"), "confirmed persistence reports success without waiting for list refresh");
  assert.equal(document.snapshots.length, 1);
  assert.deepEqual((await repository.list()).map(({ title }) => title), ["Snapshot baseline"]);
  assert.equal(harness.successes.length, 1);
  assert.equal(harness.successes[0].title, "Snapshot baseline");
  assert.deepEqual(harness.saving, [true, false]);
});

test("save failures are surfaced, leave the form success callback untouched, and always clear saving state", async () => {
  const harness = createHarness({
    repository: {
      async save() { throw new PlanSnapshotStoreError("HOST_STORAGE_ERROR", "Host storage write failed."); },
      async list() { throw new Error("must not refresh after an ordinary failed write"); },
    },
  });
  const result = await harness.handler(harness.event());

  assert.equal(result.status, "failed");
  assert.equal(harness.errors[0].code, "HOST_STORAGE_ERROR");
  assert.equal(harness.successes.length, 0);
  assert.deepEqual(harness.saving, [true, false]);
});

test("a confirmed save does not leave the form busy while history refresh is pending", async () => {
  let finishRefresh;
  let saveCount = 0;
  const harness = createHarness({
    repository: {
      async save() { saveCount += 1; },
      list() { return new Promise((resolve) => { finishRefresh = resolve; }); },
    },
  });

  const result = await harness.handler(harness.event());
  assert.equal(result.status, "saved");
  assert.equal(saveCount, 1);
  assert.equal(harness.successes.length, 1);
  assert.deepEqual(harness.saving, [true, false]);
  assert.equal(harness.events.includes("refresh"), true);
  finishRefresh([]);
});

test("an unconfirmed write is checked against refreshed history before success or error feedback", async () => {
  let persisted = [];
  let saveCount = 0;
  const harness = createHarness({
    repository: {
      async save(snapshot) {
        saveCount += 1;
        persisted = [snapshot];
        throw new PlanSnapshotStoreError("SNAPSHOT_WRITE_UNCONFIRMED", "Host read-back failed.");
      },
      async list() { return persisted; },
    },
  });

  const result = await harness.handler(harness.event());
  assert.equal(result.status, "saved");
  assert.equal(result.confirmedAfterUncertainWrite, true);
  assert.equal(saveCount, 1, "checking history never calls save a second time");
  assert.equal(harness.successes[0].snapshotId, persisted[0].snapshotId);
  assert.equal(harness.errors.length, 0);
  assert.deepEqual(harness.saving, [true, false]);
});

test("duplicate submits during an in-flight save are explicitly reported and do not write twice", async () => {
  let finishSave;
  let saveCount = 0;
  const harness = createHarness({
    repository: {
      save() {
        saveCount += 1;
        return new Promise((resolve) => { finishSave = resolve; });
      },
      async list() { return []; },
    },
  });

  const first = harness.handler(harness.event());
  await Promise.resolve();
  const second = await harness.handler(harness.event());
  assert.equal(second.status, "in-progress");
  assert.deepEqual(harness.statuses, ["in-progress"]);
  assert.equal(saveCount, 1);
  finishSave();
  assert.equal((await first).status, "saved");
  assert.equal(saveCount, 1);
});

test("unavailable Host Storage is reported without creating a snapshot or calling save", async () => {
  let createCount = 0;
  let saveCount = 0;
  const harness = createHarness({ repository: null, storageAvailable: false });
  harness.handler = createSnapshotSaveHandler({
    getState: () => harness.state,
    setSaving: (value) => harness.saving.push(value),
    clearFeedback: () => { harness.errors.length = 0; harness.statuses.length = 0; },
    setDuplicateMessage: () => harness.statuses.push("in-progress"),
    setError: (error) => harness.errors.push(error),
    onSuccess: (snapshot) => harness.successes.push(snapshot),
    refresh: async () => {},
    createSnapshot: () => { createCount += 1; },
  });
  harness.state.repository = { async save() { saveCount += 1; } };

  const result = await harness.handler(harness.event());
  assert.equal(result.status, "blocked");
  assert.equal(harness.errors[0].code, "STORAGE_API_UNAVAILABLE");
  assert.equal(createCount, 0);
  assert.equal(saveCount, 0);
});

test("permission denial from Host Storage reaches the caller as a visible operation error", async () => {
  let setCount = 0;
  const bridge = {
    capabilities: { storage: true },
    storage: {
      async get() { throw new Error("Plugin has not declared permission 'host.storage'"); },
      async set() { setCount += 1; },
      async delete() {},
    },
  };
  const harness = createHarness({ repository: createPlanSnapshotRepository(bridge) });
  const result = await harness.handler(harness.event());

  assert.equal(result.status, "failed");
  assert.equal(harness.errors[0].code, "STORAGE_PERMISSION_DENIED");
  assert.equal(setCount, 0, "permission rejection occurs before storage.set");
  assert.equal(harness.successes.length, 0);
});

test("a structured analysis that becomes unavailable is not silently ignored", async () => {
  const harness = createHarness({ currentSession: { status: "loading" } });
  const result = await harness.handler(harness.event());

  assert.equal(result.status, "blocked");
  assert.equal(harness.errors[0].code, "SNAPSHOT_NOT_COMPARABLE");
  assert.equal(harness.calls.some(([name]) => name === "save"), false);
});
