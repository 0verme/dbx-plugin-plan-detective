import { createRawPlanInput } from "../core/raw-plan-input.js";

/** Maximum raw-plan payload accepted through a model tool call. */
export const MAX_AI_TOOL_RAW_PLAN_CHARS = 100_000;
const MAX_SQL_CHARS = 200_000;
const MAX_WARNINGS = 32;
const MAX_WARNING_CHARS = 128;

/** DBX DatabaseType values mapped explicitly to Plan Core families. */
const CORE_DATABASE_BY_DBX_TYPE = Object.freeze({
  postgres: "postgresql",
  mysql: "mysql",
  sqlserver: "sqlserver",
  oracle: "oracle",
  "oceanbase-oracle": "oceanbase-oracle",
  doris: "doris",
  dameng: "dameng",
  questdb: "questdb",
});
const FORMATS = Object.freeze(["json", "text", "xml"]);
const TRUNCATION_WARNINGS = new Set(["plan_truncated", "plan_rows_truncated"]);
const ALLOWED_FIELDS = new Set(["dbType", "dbVersion", "mode", "format", "rawPlan", "truncated", "warnings", "sql"]);

/**
 * Translate the explicit AI-tool argument contract to Plan Core's RawPlanInput.
 * This is intentionally separate from adaptDbxEstimatedPlanResponse(): the
 * Agent's explain_query ToolResult is currently markdown text, not the Host
 * Plan API's PluginPlanResult contract. The Agent must provide the complete
 * raw plan and its provenance as individual fields; this adapter never infers
 * a database family or silently truncates a payload.
 *
 * @param {unknown} input
 * @returns {import("../core/raw-plan-input.js").RawPlanInput}
 */
export function adaptDbxAgentPlanInput(input) {
  if (!isPlainObject(input)) {
    throw new DbxAgentPlanInputError("INVALID_AI_PLAN_INPUT", "Tool arguments must be a JSON object.");
  }

  const unknownFields = Object.keys(input).filter((field) => !ALLOWED_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new DbxAgentPlanInputError(
      "INVALID_AI_PLAN_INPUT",
      `Unexpected tool argument field(s): ${unknownFields.slice(0, 8).map((field) => field.slice(0, 64)).join(", ")}.`,
    );
  }

  if (typeof input.dbType !== "string" || input.dbType.length === 0) {
    throw new DbxAgentPlanInputError("INVALID_AI_PLAN_INPUT", "dbType must be a non-empty DBX database type.");
  }
  const database = mapDatabaseFamily(input.dbType, input.dbVersion);
  if (database === undefined) {
    throw new DbxAgentPlanInputError("UNSUPPORTED_DB_TYPE", `Unsupported DBX database type: ${describeString(input.dbType)}.`);
  }

  if (input.mode !== "estimated") {
    throw new DbxAgentPlanInputError("UNSUPPORTED_PLAN_MODE", 'mode must be "estimated"; actual plans are not accepted.');
  }
  if (typeof input.format !== "string" || !FORMATS.includes(input.format)) {
    throw new DbxAgentPlanInputError("UNSUPPORTED_PLAN_FORMAT", "format must be one of: json, text, xml.");
  }
  if (typeof input.rawPlan !== "string" || input.rawPlan.trim().length === 0) {
    throw new DbxAgentPlanInputError("INVALID_AI_PLAN_INPUT", "rawPlan must be a non-empty raw plan string.");
  }
  if (input.rawPlan.length > MAX_AI_TOOL_RAW_PLAN_CHARS) {
    throw new DbxAgentPlanInputError(
      "PLAN_TOO_LARGE",
      `rawPlan exceeds the ${MAX_AI_TOOL_RAW_PLAN_CHARS}-character tool limit; it was not truncated or analyzed.`,
    );
  }
  if (typeof input.truncated !== "boolean") {
    throw new DbxAgentPlanInputError("INVALID_AI_PLAN_INPUT", "truncated must be an explicit boolean.");
  }
  if (input.truncated) {
    throw new DbxAgentPlanInputError("PLAN_TRUNCATED", "A truncated Estimated Plan cannot be analyzed safely.");
  }
  if (!Array.isArray(input.warnings) || input.warnings.length > MAX_WARNINGS || input.warnings.some((warning) =>
    typeof warning !== "string" || warning.length > MAX_WARNING_CHARS || !/^[a-z0-9][a-z0-9_-]*$/.test(warning)
  )) {
    throw new DbxAgentPlanInputError("INVALID_AI_PLAN_INPUT", `warnings must be an array of at most ${MAX_WARNINGS} short warning codes.`);
  }
  const truncationWarning = input.warnings.find((warning) => TRUNCATION_WARNINGS.has(warning) || /truncat|incomplete/i.test(warning));
  if (truncationWarning !== undefined) {
    throw new DbxAgentPlanInputError("PLAN_TRUNCATED", `Plan warning ${truncationWarning} marks the input as incomplete.`);
  }
  if (input.warnings.includes("plan_not_json") && input.format !== "text") {
    throw new DbxAgentPlanInputError("INVALID_AI_PLAN_INPUT", 'The plan_not_json warning requires format "text".');
  }

  if (input.dbVersion !== undefined && (typeof input.dbVersion !== "string" || input.dbVersion.length > 256)) {
    throw new DbxAgentPlanInputError("INVALID_AI_PLAN_INPUT", "dbVersion must be a string of at most 256 characters when provided.");
  }
  if (input.sql !== undefined && typeof input.sql !== "string") {
    throw new DbxAgentPlanInputError("INVALID_AI_PLAN_INPUT", "sql must be a string when provided.");
  }
  if (typeof input.sql === "string" && input.sql.length > MAX_SQL_CHARS) {
    throw new DbxAgentPlanInputError("INVALID_AI_PLAN_INPUT", `sql exceeds the ${MAX_SQL_CHARS}-character input limit.`);
  }

  const plan = decodePlan(input.rawPlan, input.format);
  return createRawPlanInput({
    database,
    mode: "estimated",
    format: input.format,
    plan,
    ...(input.dbVersion === undefined ? {} : { databaseVersion: input.dbVersion }),
    ...(input.sql === undefined ? {} : { sql: input.sql }),
  });
}

/** @param {string} dbType @param {unknown} dbVersion */
function mapDatabaseFamily(dbType, dbVersion) {
  if (dbType === "mysql" && typeof dbVersion === "string" && /oceanbase/i.test(dbVersion)) {
    return "oceanbase-mysql";
  }
  return CORE_DATABASE_BY_DBX_TYPE[dbType];
}

/** @param {string} rawPlan @param {string} format */
function decodePlan(rawPlan, format) {
  if (format !== "json") return rawPlan;
  let plan;
  try {
    plan = JSON.parse(rawPlan);
  } catch {
    throw new DbxAgentPlanInputError("MALFORMED_PLAN_JSON", "rawPlan is not valid JSON for format=json.");
  }
  if (plan === null || (typeof plan !== "object")) {
    throw new DbxAgentPlanInputError("MALFORMED_PLAN_JSON", "JSON rawPlan must decode to an object or array.");
  }
  return plan;
}

/** @param {unknown} value */
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {string} value */
function describeString(value) {
  const shown = value.length > 40 ? `${value.slice(0, 37)}...` : value;
  return JSON.stringify(shown);
}

export class DbxAgentPlanInputError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "DbxAgentPlanInputError";
    this.code = code;
  }
}
