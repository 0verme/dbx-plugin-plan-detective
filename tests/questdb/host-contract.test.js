import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRawPlan } from "../../src/core/parsers/index.js";
import { adaptDbxEstimatedPlanResponse } from "../../src/core/adapter/dbx-plan-response.js";
import { loadFixture } from "../helpers/fixtures.js";

test("DBX QuestDB estimated text response enters the QuestDB structured pipeline", async () => {
  const fixture = await loadFixture({ database: "questdb", mode: "estimated", name: "ordered-backward" });
  const response = {
    dbType: "questdb",
    dbVersion: "unknown",
    format: "text",
    rawPlan: fixture.input.plan,
    truncated: false,
    warnings: [],
  };
  const rawInput = adaptDbxEstimatedPlanResponse(response, { sql: fixture.meta.sql });
  const analysis = analyzeRawPlan(rawInput);

  assert.equal(rawInput.database, "questdb");
  assert.equal(rawInput.mode, "estimated");
  assert.equal(rawInput.format, "text");
  assert.equal(analysis.status, "structured");
  assert.equal(analysis.parser, "questdb");
  assert.equal(analysis.normalized.root.nodeType, "PageFrame");
});
