import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { PlanParseError } from "../../src/core/errors.js";
import { analyzeRawPlan, describeParserSupport, getParser } from "../../src/core/parsers/index.js";
import { STRUCTURED_DATABASES, createRawPlanInput } from "../../src/core/raw-plan-input.js";
import { loadFixture } from "../helpers/fixtures.js";

/**
 * The parser registry is the only place that decides whether a database family
 * has a structured parser. A family without one is a supported raw-only
 * outcome, not an error; a family with one that receives a malformed payload
 * still fails loudly.
 */

const postgresFixture = await loadFixture({ mode: "estimated", name: "large-seq-scan" });
const mysqlFixture = await loadFixture({ database: "mysql", mode: "estimated", name: "table-scan.synthetic" });
const sqlserverFixture = await loadFixture({ database: "sqlserver", mode: "estimated", name: "table-scan.synthetic" });

function pendingDialectInput() {
  return createRawPlanInput({
    database: "oracle",
    mode: "estimated",
    format: "text",
    plan: "| 0 | SELECT STATEMENT |",
  });
}

test("getParser returns a parser only for an implemented family", () => {
  const postgres = getParser("postgresql");
  assert.equal(postgres?.id, "postgres");
  assert.deepEqual(postgres?.formats, ["json"]);

  const mysql = getParser("mysql");
  assert.equal(mysql?.id, "mysql");
  assert.deepEqual(mysql?.formats, ["json"]);

  const sqlserver = getParser("sqlserver");
  assert.equal(sqlserver?.id, "sqlserver");
  assert.deepEqual(sqlserver?.formats, ["xml"]);

  for (const database of ["oracle", "unknown-database"]) {
    assert.equal(getParser(database), null, `${database} must not claim a structured parser`);
  }
});

test("STRUCTURED_DATABASES lists exactly the families with a parser", () => {
  assert.deepEqual(STRUCTURED_DATABASES, ["postgresql", "mysql", "sqlserver"]);
});

test("describeParserSupport separates structured, pending and unknown families", () => {
  assert.deepEqual(describeParserSupport("postgresql", "json"), { structured: true, parser: "postgres", reasonCode: null });
  assert.deepEqual(describeParserSupport("postgresql", "text"), {
    structured: false,
    parser: "postgres",
    reasonCode: "UNSUPPORTED_FORMAT",
  });

  assert.deepEqual(describeParserSupport("mysql", "json"), { structured: true, parser: "mysql", reasonCode: null });
  assert.deepEqual(describeParserSupport("mysql", "text"), {
    structured: false,
    parser: "mysql",
    reasonCode: "UNSUPPORTED_FORMAT",
  });

  assert.deepEqual(describeParserSupport("sqlserver", "xml"), { structured: true, parser: "sqlserver", reasonCode: null });
  assert.deepEqual(describeParserSupport("sqlserver", "json"), {
    structured: false,
    parser: "sqlserver",
    reasonCode: "UNSUPPORTED_FORMAT",
  });

  for (const database of ["oracle", "oceanbase-oracle", "doris", "dameng", "questdb"]) {
    assert.deepEqual(
      describeParserSupport(database, "text"),
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

test("analyzeRawPlan runs the full structured pipeline for MySQL", () => {
  const result = analyzeRawPlan(mysqlFixture.input);

  assert.equal(result.status, "structured");
  assert.equal(result.parser, "mysql");
  assert.equal(result.reasonCode, null);
  assert.equal(result.reason, null);
  assert.equal(result.parsed.database, "mysql");
  assert.equal(result.normalized.database, "mysql");
  assert.ok(result.metrics.nodeCount >= 2);

  const strict = analyzePlan(mysqlFixture.input);
  assert.deepEqual(result.parsed, strict.parsed);
  assert.deepEqual(result.normalized, strict.normalized);
  assert.deepEqual(result.metrics, strict.metrics);
  assert.deepEqual(result.findings, strict.findings);
});

test("analyzeRawPlan runs the full structured pipeline for SQL Server ShowPlanXML", () => {
  const result = analyzeRawPlan(sqlserverFixture.input);

  assert.equal(result.status, "structured");
  assert.equal(result.parser, "sqlserver");
  assert.equal(result.reasonCode, null);
  assert.equal(result.reason, null);
  assert.equal(result.parsed.database, "sqlserver");
  assert.equal(result.parsed.format, "xml");
  assert.equal(result.normalized.database, "sqlserver");
  assert.ok(result.metrics.nodeCount >= 1);
  assert.ok(result.hotspots !== null);

  const strict = analyzePlan(sqlserverFixture.input);
  assert.deepEqual(result.parsed, strict.parsed);
  assert.deepEqual(result.normalized, strict.normalized);
  assert.deepEqual(result.metrics, strict.metrics);
  assert.deepEqual(result.findings, strict.findings);
});

test("analyzeRawPlan returns a raw-only result for a pending dialect", () => {
  const result = analyzeRawPlan(pendingDialectInput());

  assert.equal(result.status, "raw-only");
  assert.equal(result.parser, "none");
  assert.equal(result.reasonCode, "PARSER_NOT_IMPLEMENTED");
  assert.match(result.reason, /oracle/);
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

  const mysqlResult = analyzeRawPlan(
    createRawPlanInput({ database: "mysql", mode: "estimated", format: "text", plan: "-> Table scan on orders" }),
  );
  assert.equal(mysqlResult.status, "raw-only");
  assert.equal(mysqlResult.parser, "mysql");
  assert.equal(mysqlResult.reasonCode, "UNSUPPORTED_FORMAT");

  const sqlserverResult = analyzeRawPlan(
    createRawPlanInput({ database: "sqlserver", mode: "estimated", format: "text", plan: "|--Table Scan" }),
  );
  assert.equal(sqlserverResult.status, "raw-only");
  assert.equal(sqlserverResult.parser, "sqlserver");
  assert.equal(sqlserverResult.reasonCode, "UNSUPPORTED_FORMAT");
});

test("analyzePlan stays strict: a raw-only family throws instead of returning empty findings", () => {
  try {
    analyzePlan(pendingDialectInput());
    assert.fail("analyzePlan must throw for a family without a structured parser");
  } catch (error) {
    assert.ok(error instanceof PlanParseError);
    assert.equal(error.code, "PARSER_NOT_IMPLEMENTED");
    assert.match(error.message, /oracle/);
  }
});

test("a structured parser still fails loudly on a malformed payload", () => {
  const malformedPostgres = createRawPlanInput({
    database: "postgresql",
    mode: "estimated",
    format: "json",
    plan: [{ NotAPlan: true }],
  });

  assert.throws(
    () => analyzeRawPlan(malformedPostgres),
    (error) => {
      assert.ok(error instanceof PlanParseError);
      return true;
    },
  );

  const malformedMysql = createRawPlanInput({
    database: "mysql",
    mode: "estimated",
    format: "json",
    plan: { not_a_query_block: true },
  });

  assert.throws(
    () => analyzeRawPlan(malformedMysql),
    (error) => {
      assert.ok(error instanceof PlanParseError);
      assert.equal(error.code, "MALFORMED_PLAN");
      return true;
    },
  );

  const malformedSqlServer = createRawPlanInput({
    database: "sqlserver",
    mode: "estimated",
    format: "xml",
    plan: "<ShowPlanXML><broken>",
  });

  assert.throws(
    () => analyzeRawPlan(malformedSqlServer),
    (error) => {
      assert.ok(error instanceof PlanParseError);
      assert.equal(error.code, "MALFORMED_XML");
      return true;
    },
  );
});
