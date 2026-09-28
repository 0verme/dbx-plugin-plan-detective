import assert from "node:assert/strict";
import test from "node:test";
import { runHostAnalysis } from "../../src/lib/analysis-session.js";
import { analyzeEstimatedPlan } from "../../src/ai-tool/analyze-estimated-plan.js";
import { loadFixture } from "../helpers/fixtures.js";

const fixture = await loadFixture({ mode: "estimated", name: "large-seq-scan" });
const version = fixture.input.databaseVersion ?? "15.19";
const sql = fixture.input.sql ?? "SELECT * FROM pd_fix_events;";
const bridge = {
  capabilities: { planApi: true },
  getPlanCapabilities: async () => ({
    dbType: "postgres",
    dbVersion: version,
    supports: { estimatedPlan: true },
    limits: { maxTimeoutMs: 30000, maxPlanBytes: 4 * 1024 * 1024 },
  }),
  explainPlan: async () => ({
    dbType: "postgres",
    dbVersion: version,
    format: fixture.input.format,
    rawPlan: fixture.plan,
    truncated: false,
    warnings: [],
  }),
};

test("UI and AI Tool paths send the same fixture through the same Plan Core", async () => {
  const ui = await runHostAnalysis({ bridge, connectionId: "fixture-connection", sql });
  const ai = analyzeEstimatedPlan({
    dbType: "postgres",
    dbVersion: version,
    mode: "estimated",
    format: fixture.input.format,
    rawPlan: JSON.stringify(fixture.plan),
    truncated: false,
    warnings: [],
    sql,
  });

  assert.equal(ui.status, "structured");
  assert.deepEqual(ai.analysis.metrics, ui.analysis.metrics);
  assert.deepEqual(ai.analysis.findings, ui.analysis.findings);
  assert.deepEqual(ai.analysis.hotspots, ui.analysis.hotspots);
});
