import { PlanInputError } from "./errors.js";

/**
 * RawPlanInput — the only input contract Plan Core knows about.
 *
 *     DBX context --(adapter, added later)--> RawPlanInput --> Plan Core
 *
 * The adapter is the single place allowed to know about DBX payloads. Plan Core
 * (parse / normalize / metrics / rules) must not import host or plugin types,
 * and must not care whether the payload came from DBX, a file, a paste or a
 * test fixture.
 *
 * `connectionId`, credentials, database / schema selection and timeout options
 * are deliberately NOT part of this contract: Plan Core never opens or manages
 * a connection, so those values must stay in the adapter / host layer.
 *
 * @typedef {Object} RawPlanInput
 * @property {string} database Database family the raw plan came from. The
 *   vocabulary is Plan Core's own, not DBX's `dbType`; the adapter maps between
 *   them. Families with a structured parser are listed in
 *   `STRUCTURED_DATABASES`; every other supported family is raw-only.
 * @property {"estimated"|"actual"} mode `estimated` for `EXPLAIN` output, `actual`
 *   for `EXPLAIN ANALYZE` output. This flag decides whether actual-execution
 *   properties are expected at all. The DBX Host API only serves `estimated`;
 *   `actual` exists for offline fixtures and future contracts.
 * @property {"json"|"text"|"xml"} format Serialization of `plan`, matching the
 *   host's `format` value.
 * @property {unknown} plan Raw payload exactly as produced by the source. For
 *   PostgreSQL this is the complete `EXPLAIN (FORMAT JSON)` envelope, array
 *   wrapper included; for text / XML formats it is the plan string.
 * @property {string} [sql] Original SQL text, for display and evidence only.
 *   Parsers must not depend on it, and it must never carry credentials.
 * @property {string} [databaseVersion] Server version, for provenance only.
 */

/** Database families with a structured parser today. */
export const STRUCTURED_DATABASES = ["postgresql", "mysql", "sqlserver", "oceanbase-oracle", "oracle", "dameng", "questdb"];

/**
 * Database families this contract accepts. Mirrors the dialects DBX can return
 * an estimated plan for (`supports_explain_plan` in `crates/dbx-sql`); the rest
 * are raw-only until a parser exists. A family is never silently renamed.
 */
export const SUPPORTED_DATABASES = [
  "postgresql",
  "mysql",
  "sqlserver",
  "oracle",
  "oceanbase-oracle",
  "doris",
  "dameng",
  "questdb",
];
export const SUPPORTED_MODES = ["estimated", "actual"];
export const SUPPORTED_FORMATS = ["json", "text", "xml"];

/**
 * Validate a candidate RawPlanInput without throwing.
 *
 * @param {unknown} input
 * @returns {string[]} one message per problem; empty when the input is valid
 */
export function validateRawPlanInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return [`RawPlanInput must be a plain object, got ${describeValue(input)}.`];
  }

  const problems = [];

  if (!SUPPORTED_DATABASES.includes(input.database)) {
    problems.push(`database must be one of ${SUPPORTED_DATABASES.join(", ")}; got ${describeValue(input.database)}.`);
  }
  if (!SUPPORTED_MODES.includes(input.mode)) {
    problems.push(`mode must be one of ${SUPPORTED_MODES.join(", ")}; got ${describeValue(input.mode)}.`);
  }
  if (!SUPPORTED_FORMATS.includes(input.format)) {
    problems.push(`format must be one of ${SUPPORTED_FORMATS.join(", ")}; got ${describeValue(input.format)}.`);
  }
  if (!Object.hasOwn(input, "plan") || input.plan === undefined || input.plan === null) {
    problems.push("plan is required and must be the raw payload returned by the source.");
  }
  if (input.sql !== undefined && input.sql !== null && typeof input.sql !== "string") {
    problems.push(`sql must be a string when present; got ${describeValue(input.sql)}.`);
  }
  if (input.databaseVersion !== undefined && input.databaseVersion !== null && typeof input.databaseVersion !== "string") {
    problems.push(`databaseVersion must be a string when present; got ${describeValue(input.databaseVersion)}.`);
  }

  return problems;
}

/**
 * Build a validated RawPlanInput.
 *
 * Unknown top-level properties are ignored on purpose: adapters may add
 * transport metadata in the future without breaking older core versions.
 *
 * @param {unknown} input
 * @returns {RawPlanInput}
 * @throws {PlanInputError}
 */
export function createRawPlanInput(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }

  const candidate = /** @type {RawPlanInput} */ (input);
  return {
    database: candidate.database,
    mode: candidate.mode,
    format: candidate.format,
    plan: candidate.plan,
    ...(candidate.sql === undefined || candidate.sql === null ? {} : { sql: candidate.sql }),
    ...(candidate.databaseVersion === undefined || candidate.databaseVersion === null
      ? {}
      : { databaseVersion: candidate.databaseVersion }),
  };
}

/** Describe an arbitrary value for error messages without dumping entire payloads. */
function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length ${value.length})`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") {
    const shown = value.length > 40 ? `${value.slice(0, 37)}...` : value;
    return `string(${JSON.stringify(shown)})`;
  }
  return `${typeof value}(${String(value)})`;
}
