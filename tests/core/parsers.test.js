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
const oceanBaseFixture = await loadFixture({ database: "oceanbase-oracle", mode: "estimated", name: "hash-join" });
const oracleFixture = await loadFixture({ database: "oracle", mode: "estimated", name: "table-scan.synthetic" });
const damengFixture = await loadFixture({ database: "dameng", mode: "estimated", name: "official-nested-loop-index-join" });
const questDbFixture = await loadFixture({ database: "questdb", mode: "estimated", name: "async-jit-filter" });

function pendingDialectInput() {
  return createRawPlanInput({
    database: "doris",
    mode: "estimated",
    format: "text",
    plan: "Physical Plan",
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

  const oceanBaseOracle = getParser("oceanbase-oracle");
  assert.equal(oceanBaseOracle?.id, "oceanbase-oracle");
  assert.deepEqual(oceanBaseOracle?.formats, ["json"]);

  const oracle = getParser("oracle");
  assert.equal(oracle?.id, "oracle");
  assert.deepEqual(oracle?.formats, ["text"]);

  const dameng = getParser("dameng");
  assert.equal(dameng?.id, "dameng");
  assert.deepEqual(dameng?.formats, ["text"]);

  const questdb = getParser("questdb");
  assert.equal(questdb?.id, "questdb");
  assert.deepEqual(questdb?.formats, ["text"]);

  for (const database of ["doris", "unknown-database"]) {
    assert.equal(getParser(database), null, `${database} must not claim a structured parser`);
  }
});

test("STRUCTURED_DATABASES lists exactly the families with a parser", () => {
  assert.deepEqual(STRUCTURED_DATABASES, ["postgresql", "mysql", "sqlserver", "oceanbase-oracle", "oracle", "dameng", "questdb"]);
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

  assert.deepEqual(describeParserSupport("oceanbase-oracle", "json"), {
    structured: true,
    parser: "oceanbase-oracle",
    reasonCode: null,
  });
  assert.deepEqual(describeParserSupport("oceanbase-oracle", "text"), {
    structured: false,
    parser: "oceanbase-oracle",
    reasonCode: "UNSUPPORTED_FORMAT",
  });

  assert.deepEqual(describeParserSupport("oracle", "text"), { structured: true, parser: "oracle", reasonCode: null });
  assert.deepEqual(describeParserSupport("oracle", "json"), {
    structured: false,
    parser: "oracle",
    reasonCode: "UNSUPPORTED_FORMAT",
  });

  assert.deepEqual(describeParserSupport("dameng", "text"), { structured: true, parser: "dameng", reasonCode: null });
  assert.deepEqual(describeParserSupport("dameng", "json"), {
    structured: false,
    parser: "dameng",
    reasonCode: "UNSUPPORTED_FORMAT",
  });

  assert.deepEqual(describeParserSupport("questdb", "text"), { structured: true, parser: "questdb", reasonCode: null });
  assert.deepEqual(describeParserSupport("questdb", "json"), {
    structured: false,
    parser: "questdb",
    reasonCode: "UNSUPPORTED_FORMAT",
  });

  for (const database of ["doris"]) {
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

test("analyzeRawPlan runs the full structured pipeline for OceanBase Oracle JSON", () => {
  const result = analyzeRawPlan(oceanBaseFixture.input);

  assert.equal(result.status, "structured");
  assert.equal(result.parser, "oceanbase-oracle");
  assert.equal(result.reasonCode, null);
  assert.equal(result.reason, null);
  assert.equal(result.parsed.database, "oceanbase-oracle");
  assert.equal(result.parsed.format, "json");
  assert.equal(result.normalized.database, "oceanbase-oracle");
  assert.ok(result.metrics.nodeCount >= 1);
  assert.ok(result.hotspots !== null);

  const strict = analyzePlan(oceanBaseFixture.input);
  assert.deepEqual(result.parsed, strict.parsed);
  assert.deepEqual(result.normalized, strict.normalized);
  assert.deepEqual(result.metrics, strict.metrics);
  assert.deepEqual(result.findings, strict.findings);
});

test("analyzeRawPlan runs the full structured pipeline for Oracle DBMS_XPLAN text", () => {
  const result = analyzeRawPlan(oracleFixture.input);

  assert.equal(result.status, "structured");
  assert.equal(result.parser, "oracle");
  assert.equal(result.reasonCode, null);
  assert.equal(result.parsed.database, "oracle");
  assert.equal(result.parsed.format, "text");
  assert.equal(result.normalized.database, "oracle");
  assert.equal(result.normalized.root.children[0].kind, "seq_scan");
  assert.equal(result.normalized.root.children[0].engineSpecific.oracle.predicateMarker, true);
  assert.equal(result.metrics.costAttribution.status, "not-applicable");

  const strict = analyzePlan(oracleFixture.input);
  assert.deepEqual(result.parsed, strict.parsed);
  assert.deepEqual(result.normalized, strict.normalized);
  assert.deepEqual(result.metrics, strict.metrics);
  assert.deepEqual(result.findings, strict.findings);
});

test("analyzeRawPlan runs the full structured pipeline for Dameng estimated text", () => {
  const result = analyzeRawPlan(damengFixture.input);

  assert.equal(result.status, "structured");
  assert.equal(result.parser, "dameng");
  assert.equal(result.reasonCode, null);
  assert.equal(result.parsed.database, "dameng");
  assert.equal(result.parsed.format, "text");
  assert.equal(result.normalized.database, "dameng");
  assert.equal(result.normalized.root.children[0].kind, "project");
  assert.equal(result.metrics.costAttribution.status, "not-applicable");

  const strict = analyzePlan(damengFixture.input);
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
  assert.match(result.reason, /doris/);
  assert.equal(result.parsed, null);
  assert.equal(result.normalized, null);
  assert.equal(result.metrics, null);
  assert.deepEqual(result.findings, []);
});

test("analyzeRawPlan runs the full structured pipeline for QuestDB text", () => {
  const result = analyzeRawPlan(questDbFixture.input);
  assert.equal(result.status, "structured");
  assert.equal(result.parser, "questdb");
  assert.equal(result.parsed.database, "questdb");
  assert.equal(result.parsed.format, "text");
  assert.equal(result.normalized.database, "questdb");
  assert.equal(result.metrics.costAttribution.status, "not-applicable");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.hotspots.items, []);

  const strict = analyzePlan(questDbFixture.input);
  assert.deepEqual(result.parsed, strict.parsed);
  assert.deepEqual(result.normalized, strict.normalized);
  assert.deepEqual(result.metrics, strict.metrics);
  assert.deepEqual(result.findings, strict.findings);
  assert.deepEqual(result.hotspots, strict.hotspots);
});

test("analyzeRawPlan returns raw-only for the remaining Doris family", () => {
  const input = createRawPlanInput({ database: "doris", mode: "estimated", format: "text", plan: "Physical Plan" });
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

  const oceanBaseResult = analyzeRawPlan(
    createRawPlanInput({ database: "oceanbase-oracle", mode: "estimated", format: "text", plan: "| 0 | HASH JOIN |" }),
  );
  assert.equal(oceanBaseResult.status, "raw-only");
  assert.equal(oceanBaseResult.parser, "oceanbase-oracle");
  assert.equal(oceanBaseResult.reasonCode, "UNSUPPORTED_FORMAT");

  const oracleResult = analyzeRawPlan(
    createRawPlanInput({ database: "oracle", mode: "estimated", format: "json", plan: {} }),
  );
  assert.equal(oracleResult.status, "raw-only");
  assert.equal(oracleResult.parser, "oracle");
  assert.equal(oracleResult.reasonCode, "UNSUPPORTED_FORMAT");

  const damengResult = analyzeRawPlan(
    createRawPlanInput({ database: "dameng", mode: "estimated", format: "json", plan: {} }),
  );
  assert.equal(damengResult.status, "raw-only");
  assert.equal(damengResult.parser, "dameng");
  assert.equal(damengResult.reasonCode, "UNSUPPORTED_FORMAT");
});

test("analyzePlan stays strict: a raw-only family throws instead of returning empty findings", () => {
  try {
    analyzePlan(pendingDialectInput());
    assert.fail("analyzePlan must throw for a family without a structured parser");
  } catch (error) {
    assert.ok(error instanceof PlanParseError);
    assert.equal(error.code, "PARSER_NOT_IMPLEMENTED");
    assert.match(error.message, /doris/);
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

  const malformedOceanBase = createRawPlanInput({
    database: "oceanbase-oracle",
    mode: "estimated",
    format: "json",
    plan: { not_a_plan_node: true },
  });

  assert.throws(
    () => analyzeRawPlan(malformedOceanBase),
    (error) => {
      assert.ok(error instanceof PlanParseError);
      assert.equal(error.code, "MALFORMED_PLAN");
      return true;
    },
  );

  const malformedDameng = createRawPlanInput({
    database: "dameng",
    mode: "estimated",
    format: "text",
    plan: "not a Dameng operation row",
  });

  assert.throws(
    () => analyzeRawPlan(malformedDameng),
    (error) => {
      assert.ok(error instanceof PlanParseError);
      assert.equal(error.code, "MALFORMED_PLAN");
      return true;
    },
  );
});
