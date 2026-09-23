import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { adaptDbxEstimatedPlanResponse } from "../../src/core/adapter/dbx-plan-response.js";
import { analyzePlan } from "../../src/core/analyze.js";
import { analyzeRawPlan } from "../../src/core/parsers/index.js";
import { goldenPathFor, loadFixture, relativeToRepo } from "../helpers/fixtures.js";

const fixture = await loadFixture({ database: "oceanbase-mysql", mode: "estimated", name: "mysql-mode-full-scan" });
const STAGES = ["parsed", "normalized", "metrics", "findings", "hotspots"];

test("the OceanBase MySQL fixture records reported real provenance without inventing capture details", () => {
  assert.equal(fixture.meta.source.kind, "real");
  assert.equal(fixture.meta.database, "oceanbase-mysql");
  assert.equal(fixture.meta.databaseVersion, "5.7.25-OceanBase-v4.2.5.7");
  assert.equal(fixture.meta.capturedAt, null);
  assert.equal(fixture.meta.captureCommand, null);
  assert.equal(fixture.meta.sql, null);
  assert.match(fixture.meta.source.detail, /真实 OceanBase 4\.2\.5\.7 MySQL compatibility-mode/);
  assert.match(fixture.meta.source.detail, /脱敏/);
});

test("DBX MySQL plus OceanBase version evidence routes the real plan through the shared OceanBase pipeline", () => {
  const adapted = adaptDbxEstimatedPlanResponse({
    dbType: "mysql",
    dbVersion: fixture.meta.databaseVersion,
    format: "json",
    rawPlan: fixture.plan,
    truncated: false,
    warnings: [],
  });

  assert.equal(adapted.database, "oceanbase-mysql");
  assert.equal(adapted.plan, fixture.plan, "the adapter passes the raw payload through unchanged");

  const result = analyzeRawPlan(adapted);
  assert.equal(result.status, "structured");
  assert.equal(result.parser, "oceanbase-mysql");
  assert.equal(result.parsed.database, "oceanbase-mysql");
  assert.equal(result.parsed.root.nodeType, "TABLE FULL SCAN");
  assert.equal(result.normalized.database, "oceanbase-mysql");
  assert.equal(result.normalized.root.kind, "seq_scan");
  assert.equal(result.normalized.root.nodeType, "TABLE FULL SCAN");
  assert.equal(result.normalized.root.estimatedRows, 47_383);
  assert.equal(result.normalized.root.engineSpecific.database, "oceanbase-mysql");
  assert.equal(result.normalized.root.engineSpecific.oceanBase.estimatedTimeUs, 312_576);
  assert.equal(result.metrics.rootEstimatedRows, 47_383);
  assert.equal(result.metrics.costAttribution.engine, "oceanbase-mysql");
  assert.equal(result.metrics.costAttribution.status, "not-applicable");
  assert.equal(result.hotspots.items[0].reasons[0].source, "EST.ROWS");
  assert.deepEqual(result.findings.map((finding) => finding.ruleId), fixture.meta.expect.findingRuleIds);
  assert.deepEqual(result.hotspots.items.map((hotspot) => hotspot.nodeId), fixture.meta.expect.hotspotNodeRefs);
  assert.deepEqual(analyzePlan(adapted), analyzePlan(fixture.input));
});

test("all OceanBase MySQL pipeline stages match the committed golden", async () => {
  const goldenFile = goldenPathFor(fixture.mode, fixture.name, "oceanbase-mysql");
  const golden = JSON.parse(await readFile(goldenFile, "utf8"));
  const analysis = analyzePlan(fixture.input);

  assert.deepEqual(Object.keys(golden).sort(), [...STAGES].sort());
  for (const stage of STAGES) {
    assert.deepStrictEqual(
      analysis[stage],
      golden[stage],
      `${relativeToRepo(goldenFile)} is stale for ${stage}`,
    );
  }
});
