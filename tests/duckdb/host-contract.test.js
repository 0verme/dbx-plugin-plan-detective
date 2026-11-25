import assert from "node:assert/strict";
import test from "node:test";
import { adaptDbxEstimatedPlanResponse } from "../../src/core/adapter/dbx-plan-response.js";
import { DbxPlanAdapterError } from "../../src/core/errors.js";
import { analyzeRawPlan } from "../../src/core/parsers/index.js";
import { loadFixture } from "../helpers/fixtures.js";

test("DBX DuckDB estimated text response enters the DuckDB structured pipeline", async () => {
  const fixture = await loadFixture({ database: "duckdb", mode: "estimated", name: "seq-scan-order-by.synthetic" });
  const response = {
    dbType: "duckdb",
    dbVersion: "1.1.3",
    format: "text",
    rawPlan: fixture.input.plan,
    truncated: false,
    warnings: [],
  };
  const rawInput = adaptDbxEstimatedPlanResponse(response, {
    sql: "SELECT id FROM plan_example ORDER BY category_id",
    capabilities: { dbType: "duckdb", supports: { estimatedPlan: true } },
  });
  const analysis = analyzeRawPlan(rawInput);

  assert.equal(rawInput.database, "duckdb");
  assert.equal(rawInput.mode, "estimated");
  assert.equal(rawInput.format, "text");
  assert.equal(analysis.status, "structured");
  assert.equal(analysis.parser, "duckdb");
  assert.equal(analysis.normalized.root.nodeType, "PROJECTION");
  assert.equal(analysis.metrics.nodeCount, 3);
  assert.equal(analysis.metrics.sequentialScanCount, 1);
  assert.equal(analysis.metrics.sortCount, 1);
});

test("truncated DuckDB plan payload fails closed at the DBX response adapter boundary", () => {
  assert.throws(
    () =>
      adaptDbxEstimatedPlanResponse({
        dbType: "duckdb",
        format: "text",
        rawPlan: "┌──────────┐\n│ SEQ_SCAN │",
        truncated: true,
        warnings: ["plan_truncated"],
      }),
    (error) => error instanceof DbxPlanAdapterError && error.code === "PLAN_TRUNCATED",
  );
});
