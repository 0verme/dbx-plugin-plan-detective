import assert from "node:assert/strict";
import test from "node:test";
import { createPlanSnapshot } from "../../src/lib/plan-snapshot.js";
import { createPlanSnapshotView, formatPlanSnapshotTime } from "../../src/lib/plan-snapshot-view.js";

const RAW_INPUT = {
  database: "postgresql",
  mode: "estimated",
  format: "json",
  sql: "SELECT 1;",
  databaseVersion: "17.2",
  plan: [{ Plan: { "Node Type": "Result", "Plan Rows": 1 } }],
};

function makeSnapshot(rawInput = RAW_INPUT) {
  return createPlanSnapshot({
    session: {
      status: "structured",
      capturedAt: "2026-10-14T08:00:00.000Z",
      source: { databaseName: "analytics", schema: "reporting", connectionId: "must-not-persist" },
      rawInput,
      analysis: { status: "structured" },
      hostResult: { truncated: false },
    },
    title: "Before tuning",
    note: "baseline",
    producerVersion: "0.7.1",
    snapshotId: "snapshot-1",
    now: new Date("2026-10-14T08:05:00.000Z"),
  });
}

test("reopens a snapshot by re-running current Core locally from its exact RawPlanInput", () => {
  const snapshot = makeSnapshot();
  const result = createPlanSnapshotView(snapshot);

  assert.equal(result.snapshot.snapshotId, "snapshot-1");
  assert.equal(result.session.status, "structured");
  assert.equal(result.session.rawInput.sql, "SELECT 1;");
  assert.deepEqual(result.session.rawInput, snapshot.rawInput);
  assert.equal(result.session.analysis.status, "structured");
  assert.deepEqual(result.session.hostResult.rawPlan, snapshot.rawInput.plan);
  assert.equal(Object.hasOwn(result.session, "capabilities"), false, "history replay does not fabricate live host capabilities");
  assert.equal(result.session.capturedAt, snapshot.capturedAt);
  assert.deepEqual(result.session.source, { databaseName: "analytics", schema: "reporting" });
  assert.equal(Object.hasOwn(result.session, "connectionId"), false);
});

test("returns Raw Plan-only when the current Core has no parser for the stored format", () => {
  const snapshot = makeSnapshot({ ...RAW_INPUT, format: "xml", plan: "<ShowPlanXML />" });
  const result = createPlanSnapshotView(snapshot);

  assert.equal(result.session.status, "raw-only");
  assert.equal(result.session.analysis.status, "raw-only");
  assert.equal(result.session.hostResult.rawPlan, "<ShowPlanXML />");
  assert.equal(result.session.analysis.findings.length, 0);
});

test("captures parser failures as local analysis errors while retaining the raw payload", () => {
  const snapshot = makeSnapshot({ ...RAW_INPUT, plan: [{ NotPlan: true }] });
  const result = createPlanSnapshotView(snapshot);

  assert.equal(result.session.status, "error");
  assert.equal(result.session.error.code, "PLAN_PARSE_FAILED");
  assert.deepEqual(result.session.hostResult.rawPlan, snapshot.rawInput.plan);
  assert.equal(result.session.hostResult.truncated, false);
});

test("rejects corrupt or unknown snapshots instead of replaying them", () => {
  const snapshot = makeSnapshot();
  assert.throws(() => createPlanSnapshotView({ ...snapshot, schemaVersion: 99 }), (error) => error.code === "UNSUPPORTED_SNAPSHOT_VERSION");
  assert.throws(() => createPlanSnapshotView(null), (error) => error.code === "INVALID_SNAPSHOT");
});

test("formats known timestamps per locale and leaves absent values unknown", () => {
  assert.equal(formatPlanSnapshotTime(null, "en"), null);
  assert.equal(formatPlanSnapshotTime("not-a-date", "zh-CN"), null);
  assert.match(formatPlanSnapshotTime("2026-10-14T08:05:00.000Z", "en"), /2026/);
});
