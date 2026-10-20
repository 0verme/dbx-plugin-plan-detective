import assert from "node:assert/strict";
import test from "node:test";
import { createPlanSnapshotRepository } from "../../src/lib/plan-snapshot-store.js";
import { createSnapshotSaveHandler } from "../../src/lib/snapshot-save-action.js";
import {
  beginSnapshotSaveTrace,
  buildSnapshotDiagnosticLog,
  createSnapshotDiagnosticTrace,
  detectDbxVersion,
  finishSnapshotDiagnosticTrace,
  prepareSnapshotSaveTrace,
  recordSnapshotDiagnosticEvent,
  recordSnapshotFormValidationFailure,
  recordSnapshotFormSubmitCapture,
  setSnapshotDiagnosticEnvironment,
  startSnapshotDiagnosticStage,
  withSnapshotDiagnosticStage,
} from "../../src/lib/snapshot-diagnostic-trace.js";
import { PLAN_SNAPSHOT_STORAGE_KEY } from "../../src/lib/plan-snapshot-store.js";

const SQL_SENTINEL = "DO_NOT_EXPORT_SQL";
const PLAN_SENTINEL = "DO_NOT_EXPORT_RAW_PLAN";
const NOTE_SENTINEL = "DO_NOT_EXPORT_NOTE";
const SESSION = {
  status: "structured",
  capturedAt: "2026-10-19T10:20:00.000Z",
  source: { databaseName: "analytics", schema: "public" },
  rawInput: {
    database: "postgresql",
    mode: "estimated",
    format: "json",
    sql: SQL_SENTINEL,
    databaseVersion: "17.2",
    plan: [{ Plan: { "Node Type": PLAN_SENTINEL, "Plan Rows": 18 } }],
  },
  analysis: { status: "structured" },
  hostResult: { truncated: false },
};

setSnapshotDiagnosticEnvironment({
  pluginVersion: "0.7.1",
  buildFingerprint: `sha256:${"c".repeat(64)}`,
  dbxVersion: "4.2.1",
  manifestPermissions: ["host.plans:read", "host.storage"],
  storage: { state: "available", available: true, advertised: true },
});

function createHarness(overrides = {}) {
  const state = {
    repository: {
      async save() {},
      async list() { return []; },
    },
    storageAvailable: true,
    loadState: "ready",
    loadError: null,
    currentSession: SESSION,
    saveTitle: "Baseline",
    saveNote: NOTE_SENTINEL,
    producerVersion: "0.7.1",
    ...overrides,
  };
  const errors = [];
  const messages = [];
  const successes = [];
  const saving = [];
  let pendingRefresh = null;
  const handler = createSnapshotSaveHandler({
    getState: () => state,
    setSaving: (value) => saving.push(value),
    clearFeedback() {},
    setDuplicateMessage: () => messages.push("in-progress"),
    setError: (error) => errors.push(error),
    onSuccess: (snapshot) => successes.push(snapshot),
    refresh: (repository, options = {}) => {
      const trace = options.trace ?? createSnapshotDiagnosticTrace({ kind: "history" });
      pendingRefresh = withSnapshotDiagnosticStage(
        trace,
        "SNAPSHOT_HISTORY_REFRESH",
        () => repository.list({ trace, readRole: "history" }),
        { operation: options.operation ?? "post-save", failedStage: "history.refresh" },
      ).then((items) => {
        if (!options.trace) finishSnapshotDiagnosticTrace(trace, "completed");
        return items;
      }, (error) => {
        if (!options.trace) finishSnapshotDiagnosticTrace(trace, "failed");
        throw error;
      });
      return pendingRefresh;
    },
  });
  return {
    state,
    errors,
    messages,
    successes,
    saving,
    handler,
    get pendingRefresh() { return pendingRefresh; },
    event: () => ({ preventDefault() {} }),
  };
}

function readLog() {
  const text = buildSnapshotDiagnosticLog();
  assert.ok(text, "diagnostic report should be available");
  return JSON.parse(text);
}

function latestTrace() {
  return readLog().latestSaveTrace;
}

function eventByStep(trace, step) {
  return trace.events.find((event) => event.step === step);
}

function createBridge({ get, set, onSet } = {}) {
  let document = null;
  let setCalls = 0;
  const bridge = {
    capabilities: { storage: true },
    storage: {
      async get(key) {
        if (get) return get(key, document);
        return key === PLAN_SNAPSHOT_STORAGE_KEY ? structuredClone(document) : null;
      },
      async set(key, value) {
        setCalls += 1;
        if (onSet) return onSet(key, value, (next) => { document = structuredClone(next); });
        document = structuredClone(value);
      },
      async delete() {},
    },
  };
  return { bridge, getSetCalls: () => setCalls, readDocument: () => structuredClone(document) };
}

test("confirmed save records a complete redacted end-to-end trace with a unique ID", async () => {
  const harness = createHarness();
  const { bridge, readDocument } = createBridge();
  harness.state.repository = createPlanSnapshotRepository(bridge);
  prepareSnapshotSaveTrace({ storageAvailable: true, sessionStructured: true, loadState: "ready", titlePresent: true });

  const result = await harness.handler(harness.event());
  await harness.pendingRefresh;

  assert.equal(result.status, "saved");
  assert.equal(readDocument().snapshots.length, 1);
  const trace = latestTrace();
  assert.equal(trace.status, "completed");
  assert.match(trace.traceId, /^snapshot-/);
  const historyTrace = readLog().recentTraces.findLast((entry) => entry.kind === "history");
  assert.equal(historyTrace.status, "completed");
  const events = [...trace.events, ...historyTrace.events];
  for (const step of [
    "SNAPSHOT_UI_CLICK",
    "SNAPSHOT_FORM_SUBMIT",
    "SNAPSHOT_SAVE_GATE_START",
    "SNAPSHOT_SAVE_GATE",
    "SNAPSHOT_CREATE_START",
    "SNAPSHOT_CREATE_END",
    "SNAPSHOT_REPOSITORY_SAVE_START",
    "SNAPSHOT_STORE_LOAD_START",
    "SNAPSHOT_HOST_STORAGE_GET_START",
    "SNAPSHOT_HOST_STORAGE_GET_END",
    "SNAPSHOT_STORE_VALIDATE",
    "SNAPSHOT_STORAGE_SET_START",
    "SNAPSHOT_STORAGE_SET_END",
    "SNAPSHOT_STORAGE_VERIFY_START",
    "SNAPSHOT_STORAGE_VERIFY_END",
    "SNAPSHOT_REPOSITORY_SAVE_END",
    "SNAPSHOT_STORAGE_VERIFY_RESULT",
    "SNAPSHOT_UI_SUCCESS",
    "SNAPSHOT_HISTORY_REFRESH_START",
    "SNAPSHOT_HISTORY_REFRESH_END",
  ]) assert.ok(events.some((event) => event.step === step), `missing ${step}`);
  const completed = trace.events.find((event) => event.step === "SNAPSHOT_STORAGE_SET_END");
  assert.equal(completed.status, "success");
  assert.equal(typeof completed.durationMs, "number");
  assert.equal(completed.failedStage, undefined);
  const verified = eventByStep(trace, "SNAPSHOT_STORAGE_VERIFY_RESULT");
  assert.equal(verified.status, "success");
  assert.equal(verified.failedStage, undefined);
  const exported = JSON.stringify(readLog());
  for (const secret of [SQL_SENTINEL, PLAN_SENTINEL, NOTE_SENTINEL]) assert.equal(exported.includes(secret), false);
  assert.equal(exported.includes("host.storage"), true, "non-sensitive manifest permission is included");
});

test("save gate records unavailable Storage and does not create or persist a snapshot", async () => {
  let created = false;
  const harness = createHarness({ repository: null, storageAvailable: false });
  const blockedHandler = createSnapshotSaveHandler({
    getState: () => harness.state,
    setSaving: () => {},
    clearFeedback() {},
    setDuplicateMessage() {},
    setError: (error) => harness.errors.push(error),
    onSuccess() {},
    refresh: async () => [],
    createSnapshot: () => { created = true; },
  });
  assert.equal((await blockedHandler(harness.event())).status, "blocked");
  assert.equal(created, false);
  const trace = latestTrace();
  assert.equal(eventByStep(trace, "SNAPSHOT_SAVE_GATE").errorCode, "STORAGE_API_UNAVAILABLE");
  assert.equal(eventByStep(trace, "SNAPSHOT_UI_ERROR").failedStage, "save.gate");
});

test("Host permission denial is classified without exporting the raw Host message", async () => {
  const { bridge } = createBridge({ get: async () => { throw new Error("host.storage permission denied SECRET_HOST_TEXT"); } });
  const harness = createHarness({ repository: createPlanSnapshotRepository(bridge) });
  assert.equal((await harness.handler(harness.event())).status, "failed");
  const trace = latestTrace();
  const error = trace.events.find((event) => event.errorCode === "STORAGE_PERMISSION_DENIED");
  assert.equal(error.failedStage, "storage.get");
  const exported = JSON.stringify(readLog());
  assert.equal(exported.includes("SECRET_HOST_TEXT"), false);
  assert.equal(readLog().environment.storage.permissionStatus, "denied");
});

test("a pending Host Storage get leaves its START event as the exact blocking stage", async () => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const { bridge } = createBridge({ get: () => { entered(); return new Promise(() => {}); } });
  const harness = createHarness({ repository: createPlanSnapshotRepository(bridge) });
  void harness.handler(harness.event());
  await started;
  const trace = latestTrace();
  assert.equal(trace.events.at(-1).step, "SNAPSHOT_HOST_STORAGE_GET_START");
  assert.equal(trace.events.at(-1).status, "pending");
  assert.equal(trace.events.at(-1).finished, null);
});

test("a pending Host Storage set is UNKNOWN/PENDING and is never retried", async () => {
  let enterSet;
  const started = new Promise((resolve) => { enterSet = resolve; });
  const { bridge, getSetCalls } = createBridge({
    onSet: () => { enterSet(); return new Promise(() => {}); },
  });
  const harness = createHarness({ repository: createPlanSnapshotRepository(bridge) });
  void harness.handler(harness.event());
  await started;
  const trace = latestTrace();
  assert.ok(trace.events.some((event) => event.step === "SNAPSHOT_STORAGE_SET_START" && event.status === "pending"));
  assert.equal(getSetCalls(), 1);
  assert.equal(trace.events.some((event) => event.step === "SNAPSHOT_STORAGE_SET_END"), false);
});

test("write/read-back mismatch is reported as unconfirmed without a second set", async () => {
  const { bridge, getSetCalls } = createBridge({ onSet: async () => {} });
  const harness = createHarness({ repository: createPlanSnapshotRepository(bridge) });
  assert.equal((await harness.handler(harness.event())).status, "failed");
  const trace = latestTrace();
  const verification = trace.events.find((event) => event.step === "SNAPSHOT_STORAGE_VERIFY_RESULT");
  assert.equal(verification.status, "failed");
  assert.equal(verification.errorCode, "SNAPSHOT_WRITE_UNCONFIRMED");
  assert.equal(getSetCalls(), 1);
});

test("a history refresh failure has its own failed trace without changing confirmed save success", async () => {
  const repository = { async save() {}, async list() { throw new Error("history read SECRET"); } };
  const harness = createHarness({ repository });
  assert.equal((await harness.handler(harness.event())).status, "saved");
  await harness.pendingRefresh.catch(() => {});
  const report = readLog();
  assert.equal(report.latestSaveTrace.status, "completed");
  assert.ok(report.latestSaveTrace.events.some((event) => event.step === "SNAPSHOT_UI_SUCCESS"));
  const historyTrace = report.recentTraces.findLast((entry) => entry.kind === "history");
  assert.equal(historyTrace.status, "failed");
  const refreshEnd = historyTrace.events.find((event) => event.step === "SNAPSHOT_HISTORY_REFRESH_END");
  assert.equal(refreshEnd.status, "failed");
  assert.equal(refreshEnd.failedStage, "history.refresh");
  assert.equal(JSON.stringify(report).includes("SECRET"), false);
});

test("UI success-state failure is distinguished from a confirmed persisted write", async () => {
  const harness = createHarness();
  const handler = createSnapshotSaveHandler({
    getState: () => harness.state,
    setSaving: () => {},
    clearFeedback() {},
    setDuplicateMessage() {},
    setError: (error) => harness.errors.push(error),
    onSuccess: () => { throw new Error("UI status update failure"); },
    refresh: async () => [],
  });
  const result = await handler(harness.event());
  assert.equal(result.status, "failed");
  assert.equal(result.persisted, true);
  const error = latestTrace().events.find((event) => event.step === "SNAPSHOT_UI_ERROR");
  assert.equal(error.failedStage, "ui.update");
});

test("simultaneous duplicate submission receives a different trace and performs one write", async () => {
  let finishSave;
  let saveCalls = 0;
  let saveEntered;
  const entered = new Promise((resolve) => { saveEntered = resolve; });
  const repository = {
    save() { saveCalls += 1; saveEntered(); return new Promise((resolve) => { finishSave = resolve; }); },
    async list() { return []; },
  };
  const harness = createHarness({ repository });
  const first = harness.handler(harness.event());
  await entered;
  assert.equal((await harness.handler(harness.event())).status, "in-progress");
  finishSave();
  assert.equal((await first).status, "saved");
  assert.equal(saveCalls, 1);
  assert.equal(harness.messages.length, 1);
  const report = readLog();
  assert.notEqual(report.latestSaveTrace.traceId, report.recentTraces.at(-1)?.traceId);
  assert.ok(report.latestSaveTrace.events.some((event) => event.errorCode === "DUPLICATE_SUBMISSION"));
});

test("non-structured sessions are gated before snapshot creation", async () => {
  const harness = createHarness({ currentSession: { status: "raw-only" } });
  assert.equal((await harness.handler(harness.event())).status, "blocked");
  const trace = latestTrace();
  assert.equal(eventByStep(trace, "SNAPSHOT_SAVE_GATE").errorCode, "SNAPSHOT_NOT_COMPARABLE");
  assert.equal(trace.events.some((event) => event.step === "SNAPSHOT_CREATE_START"), false);
});

test("an empty history list is a confirmed successful read, not a read failure", async () => {
  const { bridge } = createBridge();
  const repository = createPlanSnapshotRepository(bridge);
  const trace = createSnapshotDiagnosticTrace({ kind: "history" });
  const items = await withSnapshotDiagnosticStage(
    trace,
    "SNAPSHOT_HISTORY_REFRESH",
    () => repository.list({ trace, readRole: "history" }),
    { operation: "initial", failedStage: "history.refresh" },
  );
  finishSnapshotDiagnosticTrace(trace);
  assert.deepEqual(items, []);
  assert.equal(trace.events.find((event) => event.step === "SNAPSHOT_HISTORY_REFRESH_END").status, "success");
});

test("native front-end validation is distinguishable from a missing submit event", () => {
  prepareSnapshotSaveTrace({ titlePresent: false });
  recordSnapshotFormValidationFailure({ titlePresent: false });
  const trace = latestTrace();
  assert.ok(trace.events.some((event) => event.step === "SNAPSHOT_UI_CLICK"));
  assert.equal(trace.events.some((event) => event.step === "SNAPSHOT_FORM_SUBMIT"), false);
  assert.equal(trace.events.at(-1).errorCode, "FRONTEND_VALIDATION_REJECTED");
  assert.equal(trace.status, "blocked");
});

test("a click without submit is bounded and cannot be consumed by a later unrelated submit", async () => {
  const clicked = prepareSnapshotSaveTrace({ titlePresent: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(clicked.status, "blocked");
  assert.ok(clicked.finishedAt);
  assert.equal(clicked.events.at(-1).errorCode, "FORM_SUBMIT_NOT_OBSERVED");
  const submitted = beginSnapshotSaveTrace();
  assert.notEqual(submitted.traceId, clicked.traceId);
  finishSnapshotDiagnosticTrace(submitted);
});

test("capture without handler also settles, while a consumed submit waiting for Host stays pending", async () => {
  const captured = recordSnapshotFormSubmitCapture({ eventTrusted: true, formConnected: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(captured.status, "blocked");
  assert.ok(captured.events.some((event) => event.step === "SNAPSHOT_FORM_SUBMIT_CAPTURE"));
  prepareSnapshotSaveTrace();
  const submitted = beginSnapshotSaveTrace();
  startSnapshotDiagnosticStage(submitted, "SNAPSHOT_HOST_STORAGE_GET");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(submitted.status, "pending");
  assert.equal(submitted.finishedAt, undefined);
});

test("synchronous submit-entry exceptions are traced before application state can throw", async () => {
  const errors = [];
  const handler = createSnapshotSaveHandler({
    getState() { throw new Error("SENSITIVE_ENTRY_ERROR"); },
    setSaving() {}, clearFeedback() {}, setDuplicateMessage() {},
    setError(error) { errors.push(error); }, onSuccess() {}, refresh() {},
  });
  assert.equal((await handler({ preventDefault() {} })).status, "failed");
  const trace = latestTrace();
  assert.equal(trace.status, "failed");
  assert.ok(trace.events.some((event) => event.step === "SNAPSHOT_FORM_SUBMIT"));
  assert.equal(trace.events.at(-1).failedStage, "form.submit");
  assert.equal(errors.length, 1);
  assert.equal(JSON.stringify(readLog()).includes("SENSITIVE_ENTRY_ERROR"), false);
});

test("trace and export buffers stay bounded over a long plugin session", () => {
  const trace = createSnapshotDiagnosticTrace({ kind: "save" });
  for (let index = 0; index < 160; index += 1) {
    recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_TEST_EVENT", "info", { attempt: index % 3 });
  }
  assert.equal(trace.events.length, 128);
  const report = buildSnapshotDiagnosticLog();
  assert.ok(report.length <= 48 * 1024);
  assert.ok(JSON.parse(report).recentTraces.length <= 2);
});

test("DBX version extraction is conservative and reports unknown when unavailable", () => {
  assert.equal(detectDbxVersion({}, { userAgent: "DBX Desktop/1.4.2 Windows" }), "1.4.2");
  assert.equal(detectDbxVersion({}, { userAgent: "generic desktop" }), "unknown");
  assert.equal(detectDbxVersion({ version: "9.9.9" }, { userAgent: "" }), "unknown", "generic version fields are not mislabeled as DBX version");
});
