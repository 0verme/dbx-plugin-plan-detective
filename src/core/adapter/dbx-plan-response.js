/**
 * Adapter: DBX estimated plan Host API response -> RawPlanInput.
 *
 * This is the single DBX-aware boundary of Plan Core. It is deliberately a
 * pure function: it validates the plain object the host returned, applies a
 * fail-closed policy and hands the result to the existing
 * `createRawPlanInput(...)` contract. It never calls a host bridge, opens a
 * connection, runs EXPLAIN, or parses JSON / XML / text plans.
 *
 *     DBX estimated plan response -> adaptDbxEstimatedPlanResponse() -> RawPlanInput -> Plan Core
 *
 * Upstream contract: t8y2/dbx#9675, implementation PR t8y2/dbx#9692 (merged).
 * The response shape accepted here is that PR's `PluginPlanResult`:
 *
 *     { dbType, dbVersion?, format, rawPlan, truncated, warnings }
 *
 * `dbType` uses DBX's `db_type` vocabulary (for example `"postgres"` or
 * `"oceanbase-oracle"`); the adapter maps it to Plan Core's database family.
 * The response carries no `mode`: #9692 only serves estimated plans, so this
 * adapter always emits `mode: "estimated"`. There is no actual-plan path and no
 * actual -> estimated fallback; actual plans need a separate contract.
 *
 * Structured parsing is not decided here. Every dialect the host can return
 * maps to a RawPlanInput; the parser registry decides whether that family has a
 * structured parser or is raw-only.
 */

import { DbxPlanAdapterError } from "../errors.js";
import { SUPPORTED_DATABASES, SUPPORTED_FORMATS, createRawPlanInput } from "../raw-plan-input.js";

/**
 * DBX `db_type` -> Plan Core database family.
 *
 * Mirrors `supports_explain_plan` / `estimated_plan_format` in
 * `crates/dbx-sql/src/query_execution_sql.rs`. A dbType that is absent here is
 * not a dialect the merged host contract can produce, so it fails closed
 * instead of being guessed into a family.
 */
const DATABASE_BY_DBX_DB_TYPE = Object.freeze({
  postgres: "postgresql",
  mysql: "mysql",
  sqlserver: "sqlserver",
  oracle: "oracle",
  "oceanbase-oracle": "oceanbase-oracle",
  doris: "doris",
  dameng: "dameng",
  questdb: "questdb",
});

/** The only mode this host contract serves (t8y2/dbx#9692). */
const CORE_MODE_ESTIMATED = "estimated";

/** Host warnings that mean the payload is incomplete and must not be parsed. */
const TRUNCATION_WARNINGS = Object.freeze(["plan_truncated", "plan_rows_truncated"]);

/** `plan_not_json` means the host already downgraded the payload to `text`. */
const WARNING_PLAN_NOT_JSON = "plan_not_json";

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

  const database = DATABASE_BY_DBX_DB_TYPE[response.dbType];
  if (database === undefined) {
    throw new DbxPlanAdapterError(
      "UNSUPPORTED_DB_TYPE",
      `DBX dbType ${describeValue(response.dbType)} is not a dialect the merged plan contract serves; ` +
        `supported dbTypes map to ${SUPPORTED_DATABASES.map((family) => JSON.stringify(family)).join(", ")}.`,
    );
  }

  if (!SUPPORTED_FORMATS.includes(response.format)) {
    throw new DbxPlanAdapterError(
      "UNSUPPORTED_PLAN_FORMAT",
      `DBX plan format ${describeValue(response.format)} is not supported; Plan Core accepts ` +
        `${SUPPORTED_FORMATS.map((format) => JSON.stringify(format)).join(", ")}.`,
    );
  }

  rejectTruncation(response.truncated, response.warnings);

  return createRawPlanInput({
    database,
    mode: CORE_MODE_ESTIMATED,
    format: response.format,
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
  if (response.format === "json" && typeof response.rawPlan === "string") {
    throw invalidResponse("format is json but rawPlan is a string; the host must return a JSON payload.");
  }
  if (response.format !== "json" && typeof response.rawPlan !== "string") {
    throw invalidResponse(`format is ${response.format} but rawPlan is not a string.`);
  }
  if (response.warnings.includes(WARNING_PLAN_NOT_JSON) && response.format !== "text") {
    throw invalidResponse(`warning ${WARNING_PLAN_NOT_JSON} requires format "text".`);
  }
}

/**
 * An incomplete plan cannot produce trustworthy findings, so truncation is a
 * hard failure for this boundary. The UI keeps the raw host result and shows it
 * with a warning instead of routing it through the parser.
 *
 * @param {boolean} truncated
 * @param {string[]} warnings
 */
function rejectTruncation(truncated, warnings) {
  const truncatedWarning = warnings.find((warning) => TRUNCATION_WARNINGS.includes(warning));
  if (!truncated && truncatedWarning === undefined) return;

  throw new DbxPlanAdapterError(
    "PLAN_TRUNCATED",
    `DBX plan response is incomplete (${truncatedWarning ?? "truncated"}); an incomplete plan must not reach the plan parser.`,
  );
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
