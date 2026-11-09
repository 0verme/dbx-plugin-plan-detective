import assert from "node:assert/strict";
import test from "node:test";
import { runHostAnalysis } from "../../src/lib/analysis-session.js";
import { describeAnalysisNotice } from "../../src/lib/host-view-model.js";
import { adaptDbxEstimatedPlanResponse } from "../../src/core/adapter/dbx-plan-response.js";
import { analyzeRawPlan } from "../../src/core/parsers/index.js";
import { loadFixture } from "../helpers/fixtures.js";

const fixture = await loadFixture({ database: "db2", mode: "estimated", name: "shared-temp-plan" });

function capabilities(supportsEstimatedPlan = true) {
  return {
    dbType: "db2",
    dbVersion: "11.5",
    supports: { estimatedPlan: supportsEstimatedPlan },
    limits: { maxTimeoutMs: 30_000, maxPlanBytes: 4 * 1024 * 1024 },
  };
}

test("DBX DB2 response adapts through the DB2 parser, never through PostgreSQL", () => {
  const response = {
    dbType: "db2",
    dbVersion: "11.5",
    format: "json",
    rawPlan: fixture.plan,
    truncated: false,
    warnings: [],
  };
  const adapted = adaptDbxEstimatedPlanResponse(response, { capabilities: capabilities() });
  assert.equal(adapted.database, "db2");
  assert.equal(adapted.format, "json");
  assert.equal(adapted.mode, "estimated");
  assert.strictEqual(adapted.plan, response.rawPlan);
  const analysis = analyzeRawPlan(adapted);
  assert.equal(analysis.status, "structured");
  assert.equal(analysis.parser, "db2-luw-json-v1");
  assert.equal(analysis.parsed.database, "db2");
  assert.equal(analysis.normalized.database, "db2");
});

test("Host analysis uses the same-connection DB2 capability before requesting a plan", async () => {
  const calls = [];
  const bridge = {
    capabilities: { planApi: true },
    getPlanCapabilities: async (connectionId) => {
      calls.push(["capabilities", connectionId]);
      return capabilities();
    },
    explainPlan: async (request) => {
      calls.push(["explain", request]);
      return {
        dbType: "db2",
        dbVersion: "11.5",
        format: "json",
        rawPlan: fixture.plan,
        truncated: false,
        warnings: [],
      };
    },
  };
  const session = await runHostAnalysis({ connectionId: "db2-connection", sql: "SELECT 1", bridge });
  assert.equal(session.status, "structured");
  assert.equal(session.analysis.parser, "db2-luw-json-v1");
  assert.equal(session.rawInput.database, "db2");
  assert.equal(calls[0][0], "capabilities");
  assert.equal(calls[1][0], "explain");
  assert.equal(calls[1][1].mode, "estimated");
});

test("DB2 unsupported notice surfaces version guidance in both UI locales", () => {
  const session = { status: "unsupported", capabilities: capabilities(false) };
  const zh = describeAnalysisNotice(session, "zh-CN");
  const en = describeAnalysisNotice(session, "en");
  assert.match(zh.detail, /DBX Desktop ≥ 0\.6\.38/);
  assert.match(zh.detail, /DB2 Agent ≥ 0\.1\.78/);
  assert.match(en.detail, /DBX Desktop ≥ 0\.6\.38/);
  assert.match(en.detail, /DB2 Agent ≥ 0\.1\.78/);
  assert.match(en.detail, /not a verified end-to-end combination/);
});

test("Host negative DB2 capability yields unsupported status and does not request or fake a plan", async () => {
  let explainCalls = 0;
  const bridge = {
    capabilities: { planApi: true },
    getPlanCapabilities: async () => capabilities(false),
    explainPlan: async () => {
      explainCalls += 1;
      throw new Error("must not be called");
    },
  };
  const session = await runHostAnalysis({ connectionId: "db2-connection", sql: "SELECT 1", bridge });
  assert.equal(session.status, "unsupported");
  assert.equal(session.rawInput, null);
  assert.equal(session.analysis, null);
  assert.match(session.message, /DBX Desktop >= 0\.6\.38/);
  assert.match(session.message, /DB2 Agent >= 0\.1\.78/);
  assert.equal(explainCalls, 0);
});
