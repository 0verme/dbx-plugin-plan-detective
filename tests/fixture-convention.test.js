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
  POSTGRES_FIXTURES_DIR,
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
