import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  FIXTURE_DATABASES,
  MODES,
  MODES_BY_DATABASE,
  MYSQL_FIXTURES_DIR,
  POSTGRES_FIXTURES_DIR,
  listFixtures,
  loadAllFixtures,
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

test("every plan file has exactly one metadata sidecar in every fixture root", async () => {
  for (const database of FIXTURE_DATABASES) {
    const root = database === "mysql" ? MYSQL_FIXTURES_DIR : POSTGRES_FIXTURES_DIR;
    for (const mode of MODES_BY_DATABASE[database]) {
      const entries = await readdir(path.join(root, mode));
      const plans = entries.filter((entry) => entry.endsWith(".plan.json")).sort();
      const metas = entries.filter((entry) => entry.endsWith(".meta.json")).sort();
      assert.deepEqual(
        metas,
        plans.map((plan) => plan.replace(/\.plan\.json$/, ".meta.json")),
        `fixtures/${database}/${mode}: .plan.json and .meta.json files must come in pairs`,
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
    for (const fixture of await listFixtures(database)) {
      for (const suffix of [".plan.json", ".meta.json"]) {
        const root = database === "mysql" ? MYSQL_FIXTURES_DIR : POSTGRES_FIXTURES_DIR;
        const file = path.join(root, fixture.mode, `${fixture.name}${suffix}`);
        const text = await readFile(file, "utf8");
        assert.doesNotMatch(text, banned, `${path.relative(process.cwd(), file)} must not contain credential-like fields`);
      }
    }
  }
});
