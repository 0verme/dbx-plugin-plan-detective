import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";

/** Repo root, resolved from this file so tests work from any cwd. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const POSTGRES_FIXTURES_DIR = path.join(REPO_ROOT, "fixtures", "postgres");
export const MODES = ["estimated", "actual"];
export const SOURCE_KINDS = ["official", "locally-generated", "synthetic"];

const PLAN_SUFFIX = ".plan.json";
const META_SUFFIX = ".meta.json";

/**
 * List fixture names for one mode, sorted. A fixture named
 * `seq-scan.plan.json` is returned as `seq-scan`.
 *
 * @param {string} mode
 * @returns {Promise<string[]>}
 */
export async function listFixtureNames(mode) {
  const entries = await readdir(path.join(POSTGRES_FIXTURES_DIR, mode));
  return entries
    .filter((entry) => entry.endsWith(PLAN_SUFFIX))
    .map((entry) => entry.slice(0, -PLAN_SUFFIX.length))
    .sort();
}

/**
 * @returns {Promise<Array<{ mode: string, name: string }>>}
 */
export async function listFixtures() {
  const fixtures = [];
  for (const mode of MODES) {
    for (const name of await listFixtureNames(mode)) {
      fixtures.push({ mode, name });
    }
  }
  return fixtures;
}

/**
 * Load one fixture plus its metadata sidecar and turn them into a RawPlanInput.
 *
 * @param {{ mode: string, name: string }} fixture
 */
export async function loadFixture({ mode, name }) {
  const dir = path.join(POSTGRES_FIXTURES_DIR, mode);
  const planPath = path.join(dir, `${name}${PLAN_SUFFIX}`);
  const metaPath = path.join(dir, `${name}${META_SUFFIX}`);

  const [planText, metaText] = await Promise.all([readFile(planPath, "utf8"), readFile(metaPath, "utf8")]);

  let plan;
  try {
    plan = JSON.parse(planText);
  } catch (error) {
    throw new Error(`Fixture ${relativeToRepo(planPath)} is not valid JSON: ${error.message}`);
  }

  let meta;
  try {
    meta = JSON.parse(metaText);
  } catch (error) {
    throw new Error(`Fixture metadata ${relativeToRepo(metaPath)} is not valid JSON: ${error.message}`);
  }

  const problems = validateFixtureMeta(meta, { mode, file: relativeToRepo(metaPath), name });
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

  return { mode, name, planPath, metaPath, plan, meta, input };
}

/** @returns {Promise<Array<Awaited<ReturnType<typeof loadFixture>>>>} */
export async function loadAllFixtures() {
  const fixtures = await listFixtures();
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
 * - `mode` must match the directory the fixture lives in;
 * - provenance (`source.kind`, `source.detail`) is mandatory and must match the
 *   kind of data that is actually committed;
 * - real captures must record databaseVersion / capturedAt / captureCommand / sql;
 * - synthetic fixtures must carry nulls there and be marked in the file name
 *   with `.synthetic`;
 * - `expect` records the behavior the fixture pins down.
 *
 * @param {unknown} meta
 * @param {{ mode?: string, file?: string, name?: string }} [context]
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

  if (meta.database !== "postgresql") {
    problems.push(`database must be "postgresql"; got ${JSON.stringify(meta.database)}`);
  }
  if (!MODES.includes(meta.mode)) {
    problems.push(`mode must be one of ${MODES.join(", ")}; got ${JSON.stringify(meta.mode)}`);
  }
  if (context.mode !== undefined && meta.mode !== context.mode) {
    problems.push(`mode ${JSON.stringify(meta.mode)} does not match fixture directory ${JSON.stringify(context.mode)}`);
  }
  if (meta.format !== "json") {
    problems.push(`format must be "json"; got ${JSON.stringify(meta.format)}`);
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
  }

  return problems;
}

/** Absolute path of the golden file that pins a fixture's parsed output. */
export function goldenPathFor(mode, name) {
  return path.join(POSTGRES_FIXTURES_DIR, "golden", mode, `${name}.json`);
}

/** @param {string} absolutePath */
export function relativeToRepo(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
