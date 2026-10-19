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
 * MySQL is mapped to `oceanbase-mysql` only when `dbVersion` independently
 * identifies OceanBase; `gaussdb` is mapped to its own family only when the
 * caller supplies a matching Host capability with `supports.estimatedPlan`.
 * The plan payload is never inspected to guess a family.
 * The response carries no `mode`: #9692 only serves estimated plans, so this
 * adapter always emits `mode: "estimated"`. There is no actual-plan path and no
 * actual -> estimated fallback; actual plans need a separate contract.
 *
 * Structured parsing is not decided here. Every dialect the host can return
 * maps to a RawPlanInput; the parser registry decides whether that family has a
 * structured parser or is raw-only.
 */

import { DbxPlanAdapterError } from "../errors.js";
import { SUPPORTED_FORMATS, createRawPlanInput } from "../raw-plan-input.js";

/**
 * DBX `db_type` -> Plan Core database family.
 *
 * Mirrors dialect families exposed by the Host plan contract. `gaussdb` is
 * deliberately gated separately: only the Host's affirmative per-connection
 * `supports.estimatedPlan` result can establish the DWS-enabled path. A plugin
 * parser family does not imply Host capability.
 */
const DATABASE_BY_DBX_DB_TYPE = Object.freeze({
  postgres: "postgresql",
  gaussdb: "gaussdb",
  mysql: "mysql",
  sqlserver: "sqlserver",
  oracle: "oracle",
  "oceanbase-oracle": "oceanbase-oracle",
  doris: "doris",
  dameng: "dameng",
  questdb: "questdb",
});

/**
 * Map the host's protocol-level type to the plan dialect. OceanBase MySQL is
 * selected only from the independently reported version string; the Raw Plan
 * shape is never used for database-family detection.
 *
 * @param {string} dbType
 * @param {string|undefined} dbVersion
 * @param {{ dbType: string, supports: { estimatedPlan: boolean } }|null} capabilities
 * @returns {string|undefined}
 */
function mapDatabaseFamily(dbType, dbVersion, capabilities) {
  if (dbType === "gaussdb") {
    return capabilities?.dbType === "gaussdb" && capabilities.supports.estimatedPlan === true
      ? "gaussdb"
      : undefined;
  }
  if (dbType === "mysql" && typeof dbVersion === "string" && /oceanbase/i.test(dbVersion)) {
    return "oceanbase-mysql";
  }
  return DATABASE_BY_DBX_DB_TYPE[dbType];
}

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
 * @param {{ sql?: string | null, capabilities?: { dbType: string, supports: { estimatedPlan: boolean } }|null }} [options]
 *   adapter-known provenance and the capability snapshot for the same connection.
 *   GaussDB is never inferred from `dbType` / `dbVersion` without that affirmative
 *   Host capability. Unknown option keys are ignored on purpose.
 * @returns {import("../raw-plan-input.js").RawPlanInput}
 * @throws {DbxPlanAdapterError} with a stable `code`; the message never includes
 *   the plan payload itself.
 */
export function adaptDbxEstimatedPlanResponse(response, options) {
  const sql = readSqlOption(options);
  const capabilities = readCapabilitiesOption(options);

  if (!isPlainObject(response)) {
    throw invalidResponse(`DBX plan response must be a plain object; got ${describeValue(response)}.`);
  }

  assertResponseShape(response);

  if (capabilities !== null && capabilities.dbType !== response.dbType) {
    throw invalidResponse(
      `plan result dbType ${JSON.stringify(response.dbType)} does not match getPlanCapabilities dbType ${JSON.stringify(capabilities.dbType)}.`,
    );
  }

  const database = mapDatabaseFamily(response.dbType, response.dbVersion, capabilities);
  if (database === undefined) {
    const detail = response.dbType === "gaussdb"
      ? 'GaussDB is accepted only when getPlanCapabilities for the same connection reports dbType "gaussdb" and supports.estimatedPlan=true; the plugin will not infer Huawei DWS from dbType or dbVersion alone.'
      : `DBX dbType ${describeValue(response.dbType)} is not a dialect the merged plan contract serves; ` +
        `supported dbTypes are ${Object.keys(DATABASE_BY_DBX_DB_TYPE).map((dbType) => JSON.stringify(dbType)).join(", ")}.`;
    throw new DbxPlanAdapterError("UNSUPPORTED_DB_TYPE", detail);
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
 * Read the adapter capability snapshot. It is intentionally narrower than the
 * full Host result and is not persisted in RawPlanInput.
 * @param {unknown} options
 * @returns {{ dbType: string, supports: { estimatedPlan: boolean } }|null}
 */
function readCapabilitiesOption(options) {
  if (options === undefined || options === null) return null;
  if (!isPlainObject(options)) {
    throw new DbxPlanAdapterError(
      "INVALID_ADAPTER_OPTIONS",
      `Adapter options must be a plain object when provided; got ${describeValue(options)}.`,
    );
  }
  if (options.capabilities === undefined || options.capabilities === null) return null;
  const capabilities = options.capabilities;
  if (
    !isPlainObject(capabilities) ||
    typeof capabilities.dbType !== "string" ||
    capabilities.dbType.length === 0 ||
    !isPlainObject(capabilities.supports) ||
    typeof capabilities.supports.estimatedPlan !== "boolean"
  ) {
    throw new DbxPlanAdapterError(
      "INVALID_ADAPTER_OPTIONS",
      "options.capabilities must contain a non-empty dbType and boolean supports.estimatedPlan.",
    );
  }
  return /** @type {{ dbType: string, supports: { estimatedPlan: boolean } }} */ (capabilities);
}

/**
 * Read the only display provenance option Plan Core can use. `null` is treated
 * as absent, matching how `createRawPlanInput` treats optional `sql`.
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
