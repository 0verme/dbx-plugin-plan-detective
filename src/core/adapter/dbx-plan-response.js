/**
 * Adapter: DBX estimated plan Host API response -> RawPlanInput.
 *
 * This is the single DBX-aware boundary of Plan Detective. It is deliberately a
 * pure function: it validates the plain object the host returned, applies a
 * fail-closed policy and hands the result to the existing
 * `createRawPlanInput(...)` contract. It never calls a host bridge, opens a
 * connection, runs EXPLAIN, or parses XML / text plans.
 *
 *     DBX estimated plan response -> adaptDbxEstimatedPlanResponse() -> RawPlanInput -> Plan Core
 *
 * Upstream contract: t8y2/dbx#9675, implementation PR t8y2/dbx#9692. The
 * response shape accepted here is that PR's `PluginPlanResult`:
 *
 *     { dbType, dbVersion?, format, rawPlan, truncated, warnings }
 *
 * `dbType` uses DBX's `db_type` vocabulary, where PostgreSQL is `"postgres"`.
 * The response carries no `mode`: #9692 only serves estimated plans, so this
 * adapter always emits `mode: "estimated"`. There is no actual-plan path and no
 * actual -> estimated fallback; actual plans need a separate contract.
 */

import { DbxPlanAdapterError } from "../errors.js";
import { SUPPORTED_DATABASES, SUPPORTED_FORMATS, createRawPlanInput } from "../raw-plan-input.js";

/** DBX `db_type` for PostgreSQL (upstream `plugins/connection-types/postgres.yaml`). */
const DBX_DB_TYPE_POSTGRES = "postgres";

/** RawPlanInput database value the DBX PostgreSQL dbType maps to. */
const CORE_DATABASE_POSTGRES = "postgresql";

/** The only mode this host contract serves (t8y2/dbx#9692). */
const CORE_MODE_ESTIMATED = "estimated";

/** The only plan serialization Plan Core can parse today. */
const CORE_FORMAT_JSON = "json";

/**
 * Host warnings that mean the payload must not enter the analysis pipeline.
 *
 * `plan_not_json` is emitted together with `format: "text"` by the host, so it
 * is checked before the format gate to keep the specific reason instead of
 * collapsing into "unsupported format". Unknown warnings stay inert: they are
 * ignored rather than turned into a crash, because only these three are defined
 * as "the payload is incomplete or not JSON".
 */
const UNSAFE_WARNING_CODES = new Map([
  ["plan_not_json", "PLAN_NOT_JSON"],
  ["plan_truncated", "PLAN_TRUNCATED"],
  ["plan_rows_truncated", "PLAN_ROWS_TRUNCATED"],
]);

/**
 * Validate one DBX estimated plan response and map it to a RawPlanInput.
 *
 * @param {unknown} response the plain object returned by the host plan call
 * @param {{ sql?: string | null }} [options] adapter-known display provenance the
 *   response does not carry. Only `sql` is consumed; unknown option keys are
 *   ignored on purpose, mirroring `createRawPlanInput` forward compatibility.
 * @returns {import("../raw-plan-input.js").RawPlanInput}
 * @throws {DbxPlanAdapterError} with a stable `code`; the message never includes
 *   the plan payload itself.
 */
export function adaptDbxEstimatedPlanResponse(response, options) {
  const sql = readSqlOption(options);

  if (!isPlainObject(response)) {
    throw invalidResponse(`DBX plan response must be a plain object; got ${describeValue(response)}.`);
  }

  assertResponseShape(response);

  if (response.dbType !== DBX_DB_TYPE_POSTGRES) {
    throw new DbxPlanAdapterError(
      "UNSUPPORTED_DB_TYPE",
      `DBX dbType ${describeValue(response.dbType)} is not supported; this adapter only maps ` +
        `"${DBX_DB_TYPE_POSTGRES}" to ${SUPPORTED_DATABASES.map((database) => JSON.stringify(database)).join(", ")}.`,
    );
  }

  rejectUnsafeWarnings(response.warnings);
  rejectTruncation(response.truncated);

  if (response.format !== CORE_FORMAT_JSON) {
    throw new DbxPlanAdapterError(
      "UNSUPPORTED_PLAN_FORMAT",
      `DBX plan format ${describeValue(response.format)} is not supported; Plan Core can only parse ` +
        `${SUPPORTED_FORMATS.map((format) => JSON.stringify(format)).join(", ")}.`,
    );
  }

  return createRawPlanInput({
    database: CORE_DATABASE_POSTGRES,
    mode: CORE_MODE_ESTIMATED,
    format: CORE_FORMAT_JSON,
    plan: response.rawPlan,
    ...(sql === undefined ? {} : { sql }),
    ...(response.dbVersion === undefined ? {} : { databaseVersion: response.dbVersion }),
  });
}

/**
 * Structural gate. Every field below is part of the frozen #9692 response
 * contract, so a missing or mistyped one means the caller does not hold that
 * response at all — it is not a value to guess or default.
 *
 * @param {Record<string, unknown>} response
 */
function assertResponseShape(response) {
  if (typeof response.dbType !== "string" || response.dbType.length === 0) {
    throw invalidResponse(`dbType must be a non-empty string; got ${describeValue(response.dbType)}.`);
  }
  if (typeof response.format !== "string" || response.format.length === 0) {
    throw invalidResponse(`format must be a non-empty string; got ${describeValue(response.format)}.`);
  }
  if (!Object.hasOwn(response, "rawPlan") || response.rawPlan === undefined || response.rawPlan === null) {
    throw invalidResponse("rawPlan is required and must not be null or undefined.");
  }
  if (!Array.isArray(response.warnings) || response.warnings.some((warning) => typeof warning !== "string")) {
    throw invalidResponse(`warnings must be an array of strings; got ${describeValue(response.warnings)}.`);
  }
  if (typeof response.truncated !== "boolean") {
    throw invalidResponse(`truncated must be a boolean; got ${describeValue(response.truncated)}.`);
  }
  if (response.dbVersion !== undefined && typeof response.dbVersion !== "string") {
    throw invalidResponse(`dbVersion must be a string when present; got ${describeValue(response.dbVersion)}.`);
  }
}

/**
 * @param {string[]} warnings
 */
function rejectUnsafeWarnings(warnings) {
  for (const warning of warnings) {
    const code = UNSAFE_WARNING_CODES.get(warning);
    if (code !== undefined) {
      throw new DbxPlanAdapterError(
        code,
        `DBX plan response is not analyzable: warning ${JSON.stringify(warning)} means the payload is ` +
          "incomplete or not JSON, so it must not reach the plan parser.",
      );
    }
  }
}

/**
 * @param {boolean} truncated
 */
function rejectTruncation(truncated) {
  if (truncated) {
    throw new DbxPlanAdapterError(
      "PLAN_TRUNCATED",
      "DBX plan response is marked truncated; an incomplete plan cannot produce trustworthy findings.",
    );
  }
}

/**
 * Read the only adapter option Plan Core can use. `null` is treated as absent,
 * matching how `createRawPlanInput` treats the optional `sql` field.
 *
 * @param {unknown} options
 * @returns {string | undefined}
 */
function readSqlOption(options) {
  if (options === undefined || options === null) return undefined;
  if (!isPlainObject(options)) {
    throw new DbxPlanAdapterError(
      "INVALID_ADAPTER_OPTIONS",
      `Adapter options must be a plain object when provided; got ${describeValue(options)}.`,
    );
  }
  if (options.sql === undefined || options.sql === null) return undefined;
  if (typeof options.sql !== "string") {
    throw new DbxPlanAdapterError(
      "INVALID_ADAPTER_OPTIONS",
      `options.sql must be a string when present; got ${describeValue(options.sql)}.`,
    );
  }
  return options.sql;
}

/** @param {string} message */
function invalidResponse(message) {
  return new DbxPlanAdapterError("INVALID_DBX_PLAN_RESPONSE", message);
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Describe an unexpected value for an error message without ever dumping a
 * payload. Objects and arrays are reduced to their shape.
 *
 * @param {unknown} value
 */
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
