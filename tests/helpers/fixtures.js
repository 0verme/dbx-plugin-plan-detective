import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";

/** Repo root, resolved from this file so tests work from any cwd. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const POSTGRES_FIXTURES_DIR = path.join(REPO_ROOT, "fixtures", "postgres");
export const MYSQL_FIXTURES_DIR = path.join(REPO_ROOT, "fixtures", "mysql");
export const SQLSERVER_FIXTURES_DIR = path.join(REPO_ROOT, "fixtures", "sqlserver");
export const OCEANBASE_ORACLE_FIXTURES_DIR = path.join(REPO_ROOT, "fixtures", "oceanbase-oracle");

/**
 * Fixture roots by Plan Core database family. The default stays PostgreSQL so
 * existing call sites keep working; MySQL / SQL Server / OceanBase Oracle call
 * sites pass the family explicitly.
 */
export const FIXTURE_DIRS = Object.freeze({
  postgresql: POSTGRES_FIXTURES_DIR,
  mysql: MYSQL_FIXTURES_DIR,
  sqlserver: SQLSERVER_FIXTURES_DIR,
  "oceanbase-oracle": OCEANBASE_ORACLE_FIXTURES_DIR,
});

export const FIXTURE_DATABASES = Object.freeze(["postgresql", "mysql", "sqlserver", "oceanbase-oracle"]);
export const MODES = ["estimated", "actual"];
/**
 * Modes each database has fixtures for. MySQL, SQL Server and OceanBase Oracle
 * support estimated plans only: the Host API never serves an actual plan for
 * them, and none of them has an actual-plan shape this plugin models, so there
 * is no `actual/` directory for any of them by design.
 */
export const MODES_BY_DATABASE = Object.freeze({
  postgresql: ["estimated", "actual"],
  mysql: ["estimated"],
  sqlserver: ["estimated"],
  "oceanbase-oracle": ["estimated"],
});
export const SOURCE_KINDS = ["official", "locally-generated", "synthetic"];

/** Plan file suffix by database family (SQL Server plans are ShowPlanXML strings). */
const PLAN_SUFFIX_BY_DATABASE = Object.freeze({
  postgresql: ".plan.json",
  mysql: ".plan.json",
  sqlserver: ".plan.xml",
  "oceanbase-oracle": ".plan.json",
});

/** RawPlanInput format each fixture family commits. */
export const FORMAT_BY_DATABASE = Object.freeze({
  postgresql: "json",
  mysql: "json",
  sqlserver: "xml",
  "oceanbase-oracle": "json",
});

const META_SUFFIX = ".meta.json";

/** @param {string} database */
export function planSuffixFor(database) {
  const suffix = PLAN_SUFFIX_BY_DATABASE[database];
  if (suffix === undefined) {
    throw new Error(`Unknown fixture database ${JSON.stringify(database)}; expected one of ${FIXTURE_DATABASES.join(", ")}.`);
  }
  return suffix;
}

/** @param {string} database */
function fixturesDir(database) {
  const dir = FIXTURE_DIRS[database];
  if (dir === undefined) {
    throw new Error(`Unknown fixture database ${JSON.stringify(database)}; expected one of ${FIXTURE_DATABASES.join(", ")}.`);
  }
  return dir;
}

/**
 * List fixture names for one mode, sorted. A fixture named
 * `seq-scan.plan.json` is returned as `seq-scan`.
 *
 * @param {string} mode
 * @param {string} [database]
 * @returns {Promise<string[]>}
 */
export async function listFixtureNames(mode, database = "postgresql") {
  const planSuffix = planSuffixFor(database);
  const entries = await readdir(path.join(fixturesDir(database), mode));
  return entries
    .filter((entry) => entry.endsWith(planSuffix))
    .map((entry) => entry.slice(0, -planSuffix.length))
    .sort();
}

/**
 * @param {string} [database]
 * @returns {Promise<Array<{ database: string, mode: string, name: string }>>}
 */
export async function listFixtures(database = "postgresql") {
  const fixtures = [];
  for (const mode of MODES_BY_DATABASE[database] ?? MODES) {
    for (const name of await listFixtureNames(mode, database)) {
      fixtures.push({ database, mode, name });
    }
  }
  return fixtures;
}

/**
 * Load one fixture plus its metadata sidecar and turn them into a RawPlanInput.
 *
 * @param {{ mode: string, name: string, database?: string }} fixture
 */
export async function loadFixture({ database = "postgresql", mode, name }) {
  const dir = path.join(fixturesDir(database), mode);
  const planSuffix = planSuffixFor(database);
  const planPath = path.join(dir, `${name}${planSuffix}`);
  const metaPath = path.join(dir, `${name}${META_SUFFIX}`);

  const [planText, metaText] = await Promise.all([readFile(planPath, "utf8"), readFile(metaPath, "utf8")]);

  let plan;
  if (planSuffix === ".plan.xml") {
    // XML plans are committed as the exact string the host returns; parsing
    // them here would hide the boundary the parser is supposed to own.
    plan = planText;
  } else {
    try {
      plan = JSON.parse(planText);
    } catch (error) {
      throw new Error(`Fixture ${relativeToRepo(planPath)} is not valid JSON: ${error.message}`);
    }
  }

  let meta;
  try {
    meta = JSON.parse(metaText);
  } catch (error) {
    throw new Error(`Fixture metadata ${relativeToRepo(metaPath)} is not valid JSON: ${error.message}`);
  }

  const problems = validateFixtureMeta(meta, { database, mode, file: relativeToRepo(metaPath), name });
  if (problems.length > 0) {
    throw new Error(`Fixture metadata ${relativeToRepo(metaPath)} violates the fixture convention:\n- ${problems.join("\n- ")}`);
  }

  const input = createRawPlanInput({
    database: meta.database,
    mode: meta.mode,
    format: meta.format,
    plan,
    ...(meta.sql === null ? {} : { sql: meta.sql }),
    ...(meta.databaseVersion === null ? {} : { databaseVersion: meta.databaseVersion }),
  });

  return { database, mode, name, planPath, metaPath, plan, meta, input };
}

/**
 * @param {string} [database]
 * @returns {Promise<Array<Awaited<ReturnType<typeof loadFixture>>>>}
 */
export async function loadAllFixtures(database = "postgresql") {
  const fixtures = await listFixtures(database);
  const loaded = [];
  for (const fixture of fixtures) {
    loaded.push(await loadFixture(fixture));
  }
  return loaded;
}

/**
 * Validate a fixture metadata sidecar without throwing.
 *
 * Convention (see docs/PLAN_INPUT_AND_FIXTURES.md):
 * - `database` must be a structured family the shared conventions cover
 *   (`postgresql` / `mysql` / `sqlserver` / `oceanbase-oracle`) and must match
 *   the fixture directory when known;
 * - `mode` must match the directory the fixture lives in, and each database
 *   only supports the modes `MODES_BY_DATABASE` lists;
 * - `format` must match the family's committed payload format (`json` for
 *   PostgreSQL / MySQL / OceanBase Oracle, `xml` for SQL Server);
 * - provenance (`source.kind`, `source.detail`) is mandatory and must match the
 *   kind of data that is actually committed;
 * - real captures must record databaseVersion / capturedAt / captureCommand / sql;
 * - synthetic fixtures must carry nulls there and be marked in the file name
 *   with `.synthetic`;
 * - `expect` records the behavior the fixture pins down. `hotspotNodeRefs` is
 *   optional; when present it is the deterministic attention order of the
 *   fixture's hotspots, independent of the golden snapshot.
 *
 * @param {unknown} meta
 * @param {{ database?: string, mode?: string, file?: string, name?: string }} [context]
 * @returns {string[]}
 */
export function validateFixtureMeta(meta, context = {}) {
  if (!isPlainObject(meta)) {
    return ["metadata must be a plain object"];
  }

  const problems = [];
  const source = isPlainObject(meta.source) ? meta.source : undefined;
  const kind = source?.kind;
  const isSynthetic = kind === "synthetic";

  if (!FIXTURE_DATABASES.includes(meta.database)) {
    problems.push(`database must be one of ${FIXTURE_DATABASES.join(", ")}; got ${JSON.stringify(meta.database)}`);
  }
  if (context.database !== undefined && meta.database !== context.database) {
    problems.push(`database ${JSON.stringify(meta.database)} does not match fixture directory ${JSON.stringify(context.database)}`);
  }
  if (!MODES.includes(meta.mode)) {
    problems.push(`mode must be one of ${MODES.join(", ")}; got ${JSON.stringify(meta.mode)}`);
  }
  const allowedModes = MODES_BY_DATABASE[meta.database];
  if (Array.isArray(allowedModes) && !allowedModes.includes(meta.mode)) {
    problems.push(
      `${meta.database} fixtures only support mode${allowedModes.length === 1 ? "" : "s"} ` +
        `${allowedModes.map((mode) => JSON.stringify(mode)).join(", ")}; got ${JSON.stringify(meta.mode)}`,
    );
  }
  if (context.mode !== undefined && meta.mode !== context.mode) {
    problems.push(`mode ${JSON.stringify(meta.mode)} does not match fixture directory ${JSON.stringify(context.mode)}`);
  }
  const expectedFormat = FORMAT_BY_DATABASE[meta.database];
  if (expectedFormat !== undefined && meta.format !== expectedFormat) {
    problems.push(`format must be ${JSON.stringify(expectedFormat)} for ${meta.database} fixtures; got ${JSON.stringify(meta.format)}`);
  }

  if (source === undefined) {
    problems.push("source must be an object with kind / detail / reference");
  } else {
    if (!SOURCE_KINDS.includes(kind)) {
      problems.push(`source.kind must be one of ${SOURCE_KINDS.join(", ")}; got ${JSON.stringify(kind)}`);
    }
    if (typeof source.detail !== "string" || source.detail.trim().length === 0) {
      problems.push("source.detail must be a non-empty string describing where the plan came from");
    }
    if (source.reference !== null && typeof source.reference !== "string") {
      problems.push("source.reference must be null or a URL string");
    }
    if (kind === "locally-generated" && typeof source.detail === "string" && !source.detail.includes("locally generated")) {
      problems.push('source.detail of a locally-generated fixture must contain "locally generated"');
    }
    if (kind === "official" && (typeof source.reference !== "string" || !source.reference.startsWith("http"))) {
      problems.push("official fixtures must set source.reference to the public source URL");
    }
    if (isSynthetic && context.name !== undefined && !context.name.includes(".synthetic")) {
      problems.push('synthetic fixtures must be marked in the file name with ".synthetic"');
    }
  }

  if (isSynthetic) {
    for (const field of ["databaseVersion", "capturedAt", "captureCommand", "sql"]) {
      if (meta[field] !== null) {
        problems.push(`${field} must be null for synthetic fixtures; got ${JSON.stringify(meta[field])}`);
      }
    }
  } else {
    if (typeof meta.databaseVersion !== "string" || meta.databaseVersion.length === 0) {
      problems.push("databaseVersion must be a non-empty string for captured fixtures");
    }
    if (typeof meta.capturedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(meta.capturedAt)) {
      problems.push("capturedAt must be a YYYY-MM-DD string for captured fixtures");
    }
    if (typeof meta.captureCommand !== "string" || meta.captureCommand.length === 0) {
      problems.push("captureCommand must be a non-empty string for captured fixtures");
    }
    if (typeof meta.sql !== "string" || meta.sql.length === 0) {
      problems.push("sql must be a non-empty string for captured fixtures");
    }
  }

  if (!Array.isArray(meta.features) || meta.features.length === 0 || !meta.features.every((feature) => typeof feature === "string" && feature.length > 0)) {
    problems.push("features must be a non-empty array of non-empty strings");
  }

  const expect = isPlainObject(meta.expect) ? meta.expect : undefined;
  if (expect === undefined) {
    problems.push("expect must be an object with rootNodeType / hasActualFields / minDepth / findingRuleIds");
  } else {
    if (typeof expect.rootNodeType !== "string" || expect.rootNodeType.length === 0) {
      problems.push("expect.rootNodeType must be a non-empty string");
    }
    if (typeof expect.hasActualFields !== "boolean") {
      problems.push("expect.hasActualFields must be a boolean");
    }
    if (!Number.isInteger(expect.minDepth) || expect.minDepth < 1) {
      problems.push("expect.minDepth must be an integer >= 1");
    }
    if (!Array.isArray(expect.findingRuleIds) || !expect.findingRuleIds.every((ruleId) => typeof ruleId === "string" && ruleId.length > 0)) {
      problems.push("expect.findingRuleIds must be an array of non-empty rule id strings");
    }
    if (Object.hasOwn(expect, "hotspotNodeRefs")) {
      if (
        !Array.isArray(expect.hotspotNodeRefs) ||
        !expect.hotspotNodeRefs.every((nodeRef) => typeof nodeRef === "string" && nodeRef.length > 0)
      ) {
        problems.push("expect.hotspotNodeRefs must be an array of non-empty normalized node id strings when present");
      }
    }
  }

  return problems;
}

/**
 * Absolute path of the golden file that pins a fixture's parsed output.
 *
 * @param {string} mode
 * @param {string} name
 * @param {string} [database] defaults to `"postgresql"` for backwards compatibility
 */
export function goldenPathFor(mode, name, database = "postgresql") {
  return path.join(fixturesDir(database), "golden", mode, `${name}.json`);
}

/** @param {string} absolutePath */
export function relativeToRepo(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
