import assert from "node:assert/strict";
import test from "node:test";
import { HOST_PLAN_ERROR_CODES } from "../../src/host/index.js";
import {
  RAW_PLAN_PREVIEW_CHARS,
  describeAnalysisError,
  describeAnalysisNotice,
  describeCapabilities,
  describeConnectionContext,
  describePlanWarning,
  formatBytes,
  formatRawPlan,
} from "../../src/lib/host-view-model.js";

/**
 * The host view model is the pure copy/formatting layer for Host mode. These
 * tests pin the connection-context detection, the error copy coverage and the
 * Raw Plan formatting rules (display-only cap, payload untouched).
 */

test("describeConnectionContext reads a result-view context", () => {
  const view = describeConnectionContext({
    connectionId: "conn-1",
    database: "analytics",
    sql: "SELECT 1",
    result: { columns: ["a"], rows: [[1]] },
  });

  assert.deepEqual(view, {
    connectionId: "conn-1",
    database: "analytics",
    schema: null,
    contextSql: "SELECT 1",
    hasConnection: true,
    source: "result-view",
  });
});

test("describeConnectionContext distinguishes a standalone workbench", () => {
  assert.deepEqual(describeConnectionContext({ connectionId: "conn-1" }), {
    connectionId: "conn-1",
    database: null,
    schema: null,
    contextSql: null,
    hasConnection: true,
    source: "workbench",
  });

  assert.deepEqual(describeConnectionContext({ title: "Plan Detective" }), {
    connectionId: null,
    database: null,
    schema: null,
    contextSql: null,
    hasConnection: false,
    source: "none",
  });

  assert.equal(describeConnectionContext(null).hasConnection, false);
  assert.equal(describeConnectionContext(undefined).hasConnection, false);
});

test("describeConnectionContext trims values and ignores blank ones", () => {
  const view = describeConnectionContext({ connectionId: "  conn-1  ", database: "   ", schema: " public " });
  assert.equal(view.connectionId, "conn-1");
  assert.equal(view.database, null);
  assert.equal(view.schema, "public");
});

test("describeCapabilities renders the host answer without reinterpretation", () => {
  const view = describeCapabilities({
    dbType: "postgres",
    dbVersion: "15.19",
    supports: { estimatedPlan: true },
    limits: { maxTimeoutMs: 30_000, maxPlanBytes: 4 * 1024 * 1024 },
  });

  assert.deepEqual(view, {
    dbType: "postgres",
    dbVersion: "15.19",
    estimatedPlan: true,
    maxTimeoutMs: "30,000",
    maxPlanBytes: "4.0 MiB",
    maxPlanBytesRaw: 4 * 1024 * 1024,
  });

  assert.equal(describeCapabilities(null), null);
  assert.equal(describeCapabilities(undefined), null);
});

test("every host error code has its own copy", () => {
  const seen = new Set();
  for (const code of HOST_PLAN_ERROR_CODES) {
    const copy = describeAnalysisError(code);
    assert.ok(copy.title.length > 0, code);
    assert.ok(copy.hint.length > 0, code);
    seen.add(copy.title);
  }
  // No two codes collapse into the same title, so the UI can never show a
  // generic "analysis failed" for a classified failure.
  assert.equal(seen.size, HOST_PLAN_ERROR_CODES.length);

  assert.deepEqual(describeAnalysisError("NOT_A_REAL_CODE"), describeAnalysisError("HOST_ERROR"));
});

test("describeAnalysisNotice covers every non-error session state", () => {
  assert.equal(describeAnalysisNotice(null), null);
  assert.equal(describeAnalysisNotice({ status: "idle" }), null);

  assert.equal(describeAnalysisNotice({ status: "loading" }).tone, "info");
  assert.equal(describeAnalysisNotice({ status: "structured" }).tone, "success");
  assert.equal(describeAnalysisNotice({ status: "unsupported", message: "no plan path" }).detail, "no plan path");
  assert.equal(describeAnalysisNotice({ status: "truncated", message: "cut" }).tone, "warning");
  assert.equal(describeAnalysisNotice({ status: "raw-only", analysis: { reason: "no parser" } }).detail, "no parser");
});

test("formatRawPlan pretty-prints JSON without changing the payload", () => {
  const rawPlan = [{ Plan: { "Node Type": "Seq Scan" } }];
  const preview = formatRawPlan({ format: "json", rawPlan });

  assert.equal(preview.truncatedForDisplay, false);
  assert.equal(preview.totalChars, JSON.stringify(rawPlan, null, 2).length);
  assert.deepEqual(JSON.parse(preview.text), rawPlan);
});

test("formatRawPlan keeps text and XML exactly as the host returned them", () => {
  const text = "1 #NSET2: [0, 1, 0]\n2 #PRJT2: [0, 1, 0]";
  assert.deepEqual(formatRawPlan({ format: "text", rawPlan: text }), {
    text,
    truncatedForDisplay: false,
    totalChars: text.length,
  });

  const xml = "<ShowPlanXML><BatchSequence/></ShowPlanXML>";
  assert.equal(formatRawPlan({ format: "xml", rawPlan: xml }).text, xml);
});

test("formatRawPlan caps only the display preview", () => {
  const rawPlan = "x".repeat(RAW_PLAN_PREVIEW_CHARS + 10);
  const preview = formatRawPlan({ format: "text", rawPlan });

  assert.equal(preview.truncatedForDisplay, true);
  assert.equal(preview.text.length, RAW_PLAN_PREVIEW_CHARS);
  assert.equal(preview.totalChars, RAW_PLAN_PREVIEW_CHARS + 10);

  const small = formatRawPlan({ format: "text", rawPlan: "abc" }, { maxChars: 2 });
  assert.equal(small.text, "ab");
  assert.equal(small.truncatedForDisplay, true);
});

test("formatRawPlan returns null without a host result", () => {
  assert.equal(formatRawPlan(null), null);
  assert.equal(formatRawPlan(undefined), null);
});

test("formatBytes renders host limits", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KiB");
  assert.equal(formatBytes(4 * 1024 * 1024), "4.0 MiB");
  assert.equal(formatBytes(Number.NaN), "—");
});

test("describePlanWarning maps known host warning codes and keeps unknown ones", () => {
  assert.match(describePlanWarning("plan_not_json"), /JSON/);
  assert.match(describePlanWarning("plan_truncated"), /maxPlanBytes/);
  assert.match(describePlanWarning("plan_rows_truncated"), /行数上限/);
  assert.equal(describePlanWarning("plan_future_unknown"), "plan_future_unknown");
});
