import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { PlanParseError } from "../../src/core/errors.js";
import { analyzeRawPlan, describeParserSupport, getParser } from "../../src/core/parsers/index.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";
import { loadFixture } from "../helpers/fixtures.js";

/**
 * The parser registry is the only place that decides whether a database family
 * has a structured parser. A family without one is a supported raw-only
 * outcome, not an error; a family with one that receives a malformed payload
 * still fails loudly.
 */

const postgresFixture = await loadFixture({ mode: "estimated", name: "large-seq-scan" });

function mysqlRawInput() {
  return createRawPlanInput({
    database: "mysql",
    mode: "estimated",
    format: "json",
    plan: { query_block: { table: { table_name: "orders", access_type: "ALL" } } },
  });
}

test("getParser only returns a parser for an implemented family", () => {
  const parser = getParser("postgresql");
  assert.equal(parser?.id, "postgres");
  assert.deepEqual(parser?.formats, ["json"]);

  for (const database of ["mysql", "sqlserver", "oracle", "unknown-database"]) {
    assert.equal(getParser(database), null, `${database} must not claim a structured parser`);
  }
});

test("describeParserSupport separates structured, pending and unknown families", () => {
  assert.deepEqual(describeParserSupport("postgresql", "json"), { structured: true, parser: "postgres", reasonCode: null });
  assert.deepEqual(describeParserSupport("postgresql", "text"), {
    structured: false,
    parser: "postgres",
    reasonCode: "UNSUPPORTED_FORMAT",
  });

  for (const database of ["mysql", "sqlserver", "oracle", "oceanbase-oracle", "doris", "dameng", "questdb"]) {
    assert.deepEqual(
      describeParserSupport(database, "json"),
      { structured: false, parser: "none", reasonCode: "PARSER_NOT_IMPLEMENTED" },
      database,
    );
  }

  assert.deepEqual(describeParserSupport("unknown-database", "json"), {
    structured: false,
    parser: "none",
    reasonCode: "UNKNOWN_DATABASE",
  });
});

test("analyzeRawPlan runs the full structured pipeline for PostgreSQL", () => {
  const result = analyzeRawPlan(postgresFixture.input);

  assert.equal(result.status, "structured");
  assert.equal(result.parser, "postgres");
  assert.equal(result.reasonCode, null);
  assert.equal(result.reason, null);
  assert.ok(result.parsed !== null);
  assert.ok(result.normalized !== null);
  assert.ok(result.metrics !== null);
  assert.ok(result.findings.length > 0);

  // The strict `analyzePlan` must stay a view over the same result.
  const strict = analyzePlan(postgresFixture.input);
  assert.deepEqual(result.parsed, strict.parsed);
  assert.deepEqual(result.normalized, strict.normalized);
  assert.deepEqual(result.metrics, strict.metrics);
  assert.deepEqual(result.findings, strict.findings);
});

test("analyzeRawPlan returns a raw-only result for a pending dialect", () => {
  const result = analyzeRawPlan(mysqlRawInput());

  assert.equal(result.status, "raw-only");
  assert.equal(result.parser, "none");
  assert.equal(result.reasonCode, "PARSER_NOT_IMPLEMENTED");
  assert.match(result.reason, /mysql/);
  assert.equal(result.parsed, null);
  assert.equal(result.normalized, null);
  assert.equal(result.metrics, null);
  assert.deepEqual(result.findings, []);
});

test("analyzeRawPlan returns a raw-only result for an unknown family", () => {
  const input = createRawPlanInput({ database: "questdb", mode: "estimated", format: "text", plan: "Async Group By" });
  const result = analyzeRawPlan(input);

  assert.equal(result.status, "raw-only");
  assert.equal(result.reasonCode, "PARSER_NOT_IMPLEMENTED");
  assert.deepEqual(result.findings, []);
});

test("analyzeRawPlan reports a format mismatch instead of silently skipping the parser", () => {
  const input = createRawPlanInput({ database: "postgresql", mode: "estimated", format: "text", plan: "Seq Scan" });
  const result = analyzeRawPlan(input);

  assert.equal(result.status, "raw-only");
  assert.equal(result.parser, "postgres");
  assert.equal(result.reasonCode, "UNSUPPORTED_FORMAT");
  assert.match(result.reason, /text/);
});

test("analyzePlan stays strict: a raw-only family throws instead of returning empty findings", () => {
  try {
    analyzePlan(mysqlRawInput());
    assert.fail("analyzePlan must throw for a family without a structured parser");
  } catch (error) {
    assert.ok(error instanceof PlanParseError);
    assert.equal(error.code, "PARSER_NOT_IMPLEMENTED");
    assert.match(error.message, /mysql/);
  }
});

test("a structured parser still fails loudly on a malformed payload", () => {
  const malformed = createRawPlanInput({
    database: "postgresql",
    mode: "estimated",
    format: "json",
    plan: [{ NotAPlan: true }],
  });

  assert.throws(
    () => analyzeRawPlan(malformed),
    (error) => {
      assert.ok(error instanceof PlanParseError);
      return true;
    },
  );
});
