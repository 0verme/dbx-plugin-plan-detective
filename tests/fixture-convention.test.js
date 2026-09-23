import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  FIXTURE_DATABASES,
  FIXTURE_DIRS,
  MODES,
  MODES_BY_DATABASE,
  MYSQL_FIXTURES_DIR,
  OCEANBASE_ORACLE_FIXTURES_DIR,
  ORACLE_FIXTURES_DIR,
  DAMENG_FIXTURES_DIR,
  DORIS_FIXTURES_DIR,
  POSTGRES_FIXTURES_DIR,
  QUESTDB_FIXTURES_DIR,
  SQLSERVER_FIXTURES_DIR,
  listFixtures,
  loadAllFixtures,
  planSuffixFor,
  validateFixtureMeta,
} from "./helpers/fixtures.js";

/** @returns {Record<string, unknown>} a metadata object that satisfies the convention */
function validMeta(overrides = {}) {
  return {
    database: "postgresql",
    mode: "estimated",
    format: "json",
    databaseVersion: "15.19",
    capturedAt: "2026-09-19",
    captureCommand: "EXPLAIN (FORMAT JSON) SELECT 1;",
    sql: "SELECT 1;",
    source: {
      kind: "locally-generated",
      detail: "locally generated test fixture: captured from a throwaway local test database.",
      reference: null,
    },
    features: ["unit-test fixture"],
    expect: { rootNodeType: "Result", hasActualFields: false, minDepth: 1, findingRuleIds: [] },
    ...overrides,
  };
}

test("fixtures/postgres is organised by estimated / actual", async () => {
  for (const mode of MODES) {
    const entries = await readdir(path.join(POSTGRES_FIXTURES_DIR, mode));
    assert.ok(
      entries.some((entry) => entry.endsWith(".plan.json")),
      `fixtures/postgres/${mode} must contain at least one .plan.json`,
    );
  }
});

test("fixtures/mysql has an estimated directory and no actual directory", async () => {
  const entries = await readdir(path.join(MYSQL_FIXTURES_DIR, "estimated"));
  assert.ok(entries.some((entry) => entry.endsWith(".plan.json")), "fixtures/mysql/estimated must contain .plan.json files");
  await assert.rejects(readdir(path.join(MYSQL_FIXTURES_DIR, "actual")), (error) => error.code === "ENOENT");
  assert.deepEqual(MODES_BY_DATABASE.mysql, ["estimated"]);
});

test("fixtures/sqlserver has an estimated directory of plan.xml files and no actual directory", async () => {
  const entries = await readdir(path.join(SQLSERVER_FIXTURES_DIR, "estimated"));
  assert.ok(entries.some((entry) => entry.endsWith(".plan.xml")), "fixtures/sqlserver/estimated must contain .plan.xml files");
  await assert.rejects(readdir(path.join(SQLSERVER_FIXTURES_DIR, "actual")), (error) => error.code === "ENOENT");
  assert.deepEqual(MODES_BY_DATABASE.sqlserver, ["estimated"]);
  assert.equal(planSuffixFor("sqlserver"), ".plan.xml");
});

test("fixtures/oceanbase-oracle has an estimated directory of plan.json files and no actual directory", async () => {
  const entries = await readdir(path.join(OCEANBASE_ORACLE_FIXTURES_DIR, "estimated"));
  assert.ok(
    entries.some((entry) => entry.endsWith(".plan.json")),
    "fixtures/oceanbase-oracle/estimated must contain .plan.json files",
  );
  await assert.rejects(readdir(path.join(OCEANBASE_ORACLE_FIXTURES_DIR, "actual")), (error) => error.code === "ENOENT");
  assert.deepEqual(MODES_BY_DATABASE["oceanbase-oracle"], ["estimated"]);
  assert.equal(planSuffixFor("oceanbase-oracle"), ".plan.json");
});

test("fixtures/oracle has an estimated directory of plan.txt files and no actual directory", async () => {
  const entries = await readdir(path.join(ORACLE_FIXTURES_DIR, "estimated"));
  assert.ok(entries.some((entry) => entry.endsWith(".plan.txt")), "fixtures/oracle/estimated must contain .plan.txt files");
  await assert.rejects(readdir(path.join(ORACLE_FIXTURES_DIR, "actual")), (error) => error.code === "ENOENT");
  assert.deepEqual(MODES_BY_DATABASE.oracle, ["estimated"]);
  assert.equal(planSuffixFor("oracle"), ".plan.txt");
});

test("fixtures/dameng has an estimated directory of plan.txt files and no actual directory", async () => {
  const entries = await readdir(path.join(DAMENG_FIXTURES_DIR, "estimated"));
  assert.ok(entries.some((entry) => entry.endsWith(".plan.txt")), "fixtures/dameng/estimated must contain .plan.txt files");
  await assert.rejects(readdir(path.join(DAMENG_FIXTURES_DIR, "actual")), (error) => error.code === "ENOENT");
  assert.deepEqual(MODES_BY_DATABASE.dameng, ["estimated"]);
  assert.equal(planSuffixFor("dameng"), ".plan.txt");
});

test("fixtures/questdb has estimated text plans and no actual directory", async () => {
  const entries = await readdir(path.join(QUESTDB_FIXTURES_DIR, "estimated"));
  assert.ok(entries.some((entry) => entry.endsWith(".plan.txt")), "fixtures/questdb/estimated must contain .plan.txt files");
  await assert.rejects(readdir(path.join(QUESTDB_FIXTURES_DIR, "actual")), (error) => error.code === "ENOENT");
  assert.deepEqual(MODES_BY_DATABASE.questdb, ["estimated"]);
  assert.equal(planSuffixFor("questdb"), ".plan.txt");
});

test("fixtures/doris has estimated EXPLAIN text plans and no actual directory", async () => {
  const entries = await readdir(path.join(DORIS_FIXTURES_DIR, "estimated"));
  assert.ok(entries.some((entry) => entry.endsWith(".plan.txt")), "fixtures/doris/estimated must contain .plan.txt files");
  await assert.rejects(readdir(path.join(DORIS_FIXTURES_DIR, "actual")), (error) => error.code === "ENOENT");
  assert.deepEqual(MODES_BY_DATABASE.doris, ["estimated"]);
  assert.equal(planSuffixFor("doris"), ".plan.txt");
});

test("every plan file has exactly one metadata sidecar in every fixture root", async () => {
  for (const database of FIXTURE_DATABASES) {
    const root = FIXTURE_DIRS[database];
    const planSuffix = planSuffixFor(database);
    for (const mode of MODES_BY_DATABASE[database]) {
      const entries = await readdir(path.join(root, mode));
      const plans = entries.filter((entry) => entry.endsWith(planSuffix)).sort();
      const metas = entries.filter((entry) => entry.endsWith(".meta.json")).sort();
      assert.deepEqual(
        metas,
        plans.map((plan) => plan.replace(new RegExp(`\\${planSuffix}$`), ".meta.json")),
        `fixtures/${database}/${mode}: plan and .meta.json files must come in pairs`,
      );
    }
  }
});

test("all committed fixtures satisfy the fixture convention", async () => {
  for (const database of FIXTURE_DATABASES) {
    const fixtures = await loadAllFixtures(database);
    assert.ok(fixtures.length >= 5, `expected at least 5 ${database} fixtures, found ${fixtures.length}`);
    for (const fixture of fixtures) {
      assert.ok(fixture.meta.features.length > 0, `${database}/${fixture.mode}/${fixture.name} must declare features`);
      assert.equal(fixture.meta.database, database, `${database}/${fixture.mode}/${fixture.name} database must match its root`);
    }
  }
});

test("synthetic fixtures are marked in the file name and never claim a capture", async () => {
  for (const database of FIXTURE_DATABASES) {
    for (const fixture of await loadAllFixtures(database)) {
      const marked = fixture.name.includes(".synthetic");
      assert.equal(
        marked,
        fixture.meta.source.kind === "synthetic",
        `${database}/${fixture.mode}/${fixture.name}: .synthetic file name and source.kind must agree`,
      );
    }
  }
});

test("metadata validation rejects convention violations", () => {
  assert.deepEqual(validateFixtureMeta(validMeta(), { mode: "estimated", name: "ok" }), []);
  assert.deepEqual(validateFixtureMeta(validMeta({ mode: "actual" }), { mode: "actual", name: "ok" }), []);

  const uncapturedOfficial = validMeta({
    database: "doris",
    format: "text",
    databaseVersion: null,
    capturedAt: null,
    captureCommand: null,
    sql: null,
    source: {
      kind: "official",
      detail: "Official documentation transcription; not a local database capture and no SQL was executed.",
      reference: "https://doris.apache.org/docs/4.x/sql-manual/sql-statements/data-query/EXPLAIN/",
    },
  });
  assert.deepEqual(
    validateFixtureMeta(uncapturedOfficial, { database: "doris", mode: "estimated", name: "docs-example" }),
    [],
    "a documentation transcription must not invent server capture metadata",
  );

  assert.match(validateFixtureMeta(validMeta({ mode: "actual" }), { mode: "estimated", name: "x" }).join("\n"), /does not match fixture directory/);

  const mysqlMeta = validMeta({
    database: "mysql",
    databaseVersion: null,
    capturedAt: null,
    captureCommand: null,
    sql: null,
    source: { kind: "synthetic", detail: "synthetic fixture: hand-written.", reference: "https://example.com/plan.json" },
    name: "x",
  });
  assert.deepEqual(
    validateFixtureMeta(mysqlMeta, { database: "mysql", mode: "estimated", name: "x.synthetic" }),
    [],
    "a synthetic MySQL fixture must validate when its database matches its root",
  );
  assert.match(
    validateFixtureMeta(mysqlMeta, { database: "postgresql", mode: "estimated", name: "x.synthetic" }).join("\n"),
    /does not match fixture directory/,
  );
  assert.match(
    validateFixtureMeta({ ...mysqlMeta, mode: "actual" }, { database: "mysql", mode: "actual", name: "x.synthetic" }).join("\n"),
    /mysql fixtures only support mode "estimated"/,
  );

  const sqlserverMeta = validMeta({
    database: "sqlserver",
    format: "xml",
    databaseVersion: null,
    capturedAt: null,
    captureCommand: null,
    sql: null,
    source: { kind: "synthetic", detail: "synthetic fixture: hand-written.", reference: "https://example.com/showplan" },
  });
  assert.deepEqual(
    validateFixtureMeta(sqlserverMeta, { database: "sqlserver", mode: "estimated", name: "x.synthetic" }),
    [],
    "a synthetic SQL Server fixture must validate with format xml",
  );
  assert.match(
    validateFixtureMeta({ ...sqlserverMeta, format: "json" }, { database: "sqlserver", mode: "estimated", name: "x.synthetic" }).join("\n"),
    /format must be "xml" for sqlserver fixtures/,
  );
  assert.match(
    validateFixtureMeta({ ...sqlserverMeta, mode: "actual" }, { database: "sqlserver", mode: "actual", name: "x.synthetic" }).join("\n"),
    /sqlserver fixtures only support mode "estimated"/,
  );

  const oceanBaseMeta = validMeta({
    database: "oceanbase-oracle",
    databaseVersion: null,
    capturedAt: null,
    captureCommand: null,
    sql: null,
    source: { kind: "synthetic", detail: "synthetic fixture: hand-written.", reference: "https://example.com/plan.json" },
  });
  assert.deepEqual(
    validateFixtureMeta(oceanBaseMeta, { database: "oceanbase-oracle", mode: "estimated", name: "x.synthetic" }),
    [],
    "a synthetic OceanBase Oracle fixture must validate with format json",
  );
  assert.match(
    validateFixtureMeta({ ...oceanBaseMeta, format: "text" }, { database: "oceanbase-oracle", mode: "estimated", name: "x.synthetic" }).join("\n"),
    /format must be "json" for oceanbase-oracle fixtures/,
  );
  assert.match(
    validateFixtureMeta({ ...oceanBaseMeta, mode: "actual" }, { database: "oceanbase-oracle", mode: "actual", name: "x.synthetic" }).join("\n"),
    /oceanbase-oracle fixtures only support mode "estimated"/,
  );

  const oracleMeta = validMeta({
    database: "oracle",
    format: "text",
    databaseVersion: null,
    capturedAt: null,
    captureCommand: null,
    sql: null,
    source: { kind: "synthetic", detail: "synthetic fixture: hand-written.", reference: null },
  });
  assert.deepEqual(
    validateFixtureMeta(oracleMeta, { database: "oracle", mode: "estimated", name: "x.synthetic" }),
    [],
    "a synthetic Oracle fixture must validate with format text",
  );
  assert.match(
    validateFixtureMeta({ ...oracleMeta, format: "json" }, { database: "oracle", mode: "estimated", name: "x.synthetic" }).join("\n"),
    /format must be "text" for oracle fixtures/,
  );
  assert.match(
    validateFixtureMeta({ ...oracleMeta, mode: "actual" }, { database: "oracle", mode: "actual", name: "x.synthetic" }).join("\n"),
    /oracle fixtures only support mode "estimated"/,
  );

  const damengMeta = validMeta({
    database: "dameng",
    format: "text",
    databaseVersion: null,
    capturedAt: null,
    captureCommand: null,
    sql: null,
    source: { kind: "synthetic", detail: "synthetic fixture: hand-written.", reference: null },
  });
  assert.deepEqual(
    validateFixtureMeta(damengMeta, { database: "dameng", mode: "estimated", name: "x.synthetic" }),
    [],
    "a synthetic Dameng fixture must validate with format text",
  );
  assert.match(
    validateFixtureMeta({ ...damengMeta, format: "json" }, { database: "dameng", mode: "estimated", name: "x.synthetic" }).join("\n"),
    /format must be "text" for dameng fixtures/,
  );
  assert.match(
    validateFixtureMeta({ ...damengMeta, mode: "actual" }, { database: "dameng", mode: "actual", name: "x.synthetic" }).join("\n"),
    /dameng fixtures only support mode "estimated"/,
  );

  const questDbMeta = validMeta({
    database: "questdb",
    format: "text",
    databaseVersion: null,
    capturedAt: null,
    captureCommand: null,
    sql: null,
    source: { kind: "synthetic", detail: "synthetic QuestDB fixture: hand-written.", reference: null },
  });
  assert.deepEqual(
    validateFixtureMeta(questDbMeta, { database: "questdb", mode: "estimated", name: "x.synthetic" }),
    [],
    "a synthetic QuestDB fixture must validate with text format and estimated-only mode",
  );
  assert.match(
    validateFixtureMeta({ ...questDbMeta, format: "json" }, { database: "questdb", mode: "estimated", name: "x.synthetic" }).join("\n"),
    /format must be "text" for questdb/,
  );
  assert.match(
    validateFixtureMeta({ ...questDbMeta, mode: "actual" }, { database: "questdb", mode: "actual", name: "x.synthetic" }).join("\n"),
    /questdb fixtures only support mode "estimated"/,
  );

  const synthetic = validMeta({
    mode: "estimated",
    databaseVersion: "15.19",
    capturedAt: null,
    captureCommand: null,
    sql: null,
    source: { kind: "synthetic", detail: "synthetic fixture: hand-written.", reference: null },
  });
  const syntheticProblems = validateFixtureMeta(synthetic, { mode: "estimated", name: "x" }).join("\n");
  assert.match(syntheticProblems, /databaseVersion must be null for synthetic/);
  assert.match(syntheticProblems, /must be marked in the file name/);

  assert.match(validateFixtureMeta(validMeta({ features: [] }), { mode: "estimated", name: "x" }).join("\n"), /features/);
  assert.match(
    validateFixtureMeta(validMeta({ expect: { rootNodeType: "Result", hasActualFields: "no", minDepth: 0 } }), { mode: "estimated", name: "x" }).join("\n"),
    /hasActualFields/,
  );
  assert.match(
    validateFixtureMeta(validMeta({ expect: { rootNodeType: "Result", hasActualFields: false, minDepth: 1 } }), {
      mode: "estimated",
      name: "x",
    }).join("\n"),
    /findingRuleIds/,
    "findingRuleIds is mandatory: expected findings are part of the fixture contract",
  );
  assert.match(
    validateFixtureMeta(validMeta({ expect: { rootNodeType: "Result", hasActualFields: false, minDepth: 1, findingRuleIds: [""] } }), {
      mode: "estimated",
      name: "x",
    }).join("\n"),
    /findingRuleIds/,
  );
  assert.deepEqual(
    validateFixtureMeta(
      validMeta({
        expect: { rootNodeType: "Result", hasActualFields: false, minDepth: 1, findingRuleIds: [], hotspotNodeRefs: ["0", "0.1"] },
      }),
      { mode: "estimated", name: "x" },
    ),
    [],
    "hotspotNodeRefs is optional but must validate when present",
  );
  assert.match(
    validateFixtureMeta(
      validMeta({
        expect: { rootNodeType: "Result", hasActualFields: false, minDepth: 1, findingRuleIds: [], hotspotNodeRefs: [""] },
      }),
      { mode: "estimated", name: "x" },
    ).join("\n"),
    /hotspotNodeRefs/,
  );
  assert.match(
    validateFixtureMeta(validMeta({ source: { kind: "copied", detail: "", reference: null } }), { mode: "estimated", name: "x" }).join("\n"),
    /source.kind/,
  );
  assert.match(
    validateFixtureMeta(
      validMeta({ source: { kind: "locally-generated", detail: "captured somewhere", reference: null } }),
      { mode: "estimated", name: "x" },
    ).join("\n"),
    /must contain "locally generated"/,
  );
});

test("fixtures contain no credential-like fields", async () => {
  const banned = /"(password|passwd|secret|credential|credentials|token|api_?key|connection_?string|conn_?str)"\s*:/i;
  for (const database of FIXTURE_DATABASES) {
    const root = FIXTURE_DIRS[database];
    for (const fixture of await listFixtures(database)) {
      for (const suffix of [planSuffixFor(database), ".meta.json"]) {
        const file = path.join(root, fixture.mode, `${fixture.name}${suffix}`);
        const text = await readFile(file, "utf8");
        assert.doesNotMatch(text, banned, `${path.relative(process.cwd(), file)} must not contain credential-like fields`);
      }
    }
  }
});
