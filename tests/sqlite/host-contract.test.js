import assert from "node:assert/strict";
import test from "node:test";
import { adaptDbxEstimatedPlanResponse } from "../../src/core/adapter/dbx-plan-response.js";
import { DbxPlanAdapterError } from "../../src/core/errors.js";
import { analyzeRawPlan } from "../../src/core/parsers/index.js";
import { loadFixture } from "../helpers/fixtures.js";

test("DBX SQLite estimated JSON response enters the SQLite structured pipeline", async () => {
  const fixture = await loadFixture({ database: "sqlite", mode: "estimated", name: "join-temp-btree-order" });
  const response = {
    dbType: "sqlite",
    dbVersion: "3.54.0",
    format: "json",
    rawPlan: fixture.input.plan,
    truncated: false,
    warnings: [],
  };
  const rawInput = adaptDbxEstimatedPlanResponse(response, {
    sql: fixture.meta.sql,
    capabilities: { dbType: "sqlite", supports: { estimatedPlan: true } },
  });
  const analysis = analyzeRawPlan(rawInput);

  assert.equal(rawInput.database, "sqlite");
  assert.equal(rawInput.mode, "estimated");
  assert.equal(rawInput.format, "json");
  assert.equal(analysis.status, "structured");
  assert.equal(analysis.parser, "sqlite");
  assert.equal(analysis.normalized.root.nodeType, "SQLite Query Plan");
  assert.equal(analysis.metrics.nodeCount, 3);
  assert.equal(analysis.metrics.indexScanCount, 2);
  assert.equal(analysis.metrics.sortCount, 1);
});

test("truncated SQLite plan rows fail closed at the DBX response adapter boundary", () => {
  assert.throws(
    () =>
      adaptDbxEstimatedPlanResponse({
        dbType: "sqlite",
        format: "json",
        rawPlan: [{ id: 2, parent: 0, notused: 0, detail: "SCAN orders" }],
        truncated: true,
        warnings: ["plan_rows_truncated"],
      }),
    (error) => error instanceof DbxPlanAdapterError && error.code === "PLAN_TRUNCATED",
  );
});
