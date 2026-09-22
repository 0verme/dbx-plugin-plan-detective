/**
 * Parser registry: database family -> structured parser.
 *
 *     RawPlanInput -> analyzeRawPlan() -> ParsedPlan -> NormalizedPlan -> Metrics -> Findings
 *
 * The registry is the only place that decides whether a database family has a
 * structured parser. A family without one is not an error: the host can return
 * a perfectly valid estimated plan for Doris or QuestDB, and the UI still shows
 * the Raw Plan and the host warnings. What it must not do is
 * pretend to parse a payload no one has validated against a real sample.
 *
 * Adding a database means adding one parser module here; the UI, rules and
 * metrics never change.
 */

import { PlanInputError, PlanParseError } from "../errors.js";
import { computeHotspots } from "../hotspots/compute-hotspots.js";
import { damengParser } from "./dameng.js";
import { computeMetrics } from "../metrics/compute-metrics.js";
import { validateRawPlanInput } from "../raw-plan-input.js";
import { runRules } from "../rules/index.js";
import { mysqlParser } from "./mysql.js";
import { oceanBaseOracleParser } from "./oceanbase-oracle.js";
import { oracleParser } from "./oracle.js";
import { postgresParser } from "./postgres.js";
import { sqlserverParser } from "./sqlserver.js";

/**
 * Structured parsers by Plan Core database family.
 *
 * @type {Map<string, { id: string, database: string, formats: readonly string[], parse: Function, normalize: Function }>}
 */
const PARSERS = new Map([
  [postgresParser.database, postgresParser],
  [mysqlParser.database, mysqlParser],
  [sqlserverParser.database, sqlserverParser],
  [oceanBaseOracleParser.database, oceanBaseOracleParser],
  [oracleParser.database, oracleParser],
  [damengParser.database, damengParser],
]);

/**
 * Dialects the merged host contract can return that have no structured parser
 * yet. They are listed explicitly so the UI can say *which* parser is missing
 * instead of reporting a generic failure. The value is a stable reason code.
 *
 * @type {Map<string, string>}
 */
const PENDING_PARSERS = new Map([
  ["doris", "PARSER_NOT_IMPLEMENTED"],
  ["questdb", "PARSER_NOT_IMPLEMENTED"],
]);

/**
 * @typedef {Object} PlanAnalysis
 * @property {"structured"|"raw-only"} status
 * @property {string} parser parser id, `"none"` when the family has none
 * @property {string|null} reasonCode stable reason for a raw-only result
 * @property {string|null} reason human-readable reason for a raw-only result
 * @property {import("../postgres/parse-json-plan.js").ParsedPlan|null} parsed
 * @property {import("../normalize/normalize-postgres.js").NormalizedPlan|null} normalized
 * @property {import("../metrics/compute-metrics.js").PlanMetrics|null} metrics
 * @property {import("../findings/finding.js").Finding[]} findings
 * @property {import("../hotspots/compute-hotspots.js").HotspotAnalysis|null} hotspots
 *   `null` for raw-only: hotspot analysis needs the structured plan
 */

/**
 * @param {string} database Plan Core database family
 * @returns {{ id: string, database: string, formats: readonly string[], parse: Function, normalize: Function } | null}
 */
export function getParser(database) {
  return PARSERS.get(database) ?? null;
}

/**
 * Describe structured-parser support for one family/format pair without running
 * anything. Used by tests and by the UI status copy.
 *
 * @param {string} database
 * @param {string} format
 * @returns {{ structured: boolean, parser: string, reasonCode: string | null }}
 */
export function describeParserSupport(database, format) {
  const parser = PARSERS.get(database);
  if (parser !== undefined) {
    if (parser.formats.includes(format)) return { structured: true, parser: parser.id, reasonCode: null };
    return { structured: false, parser: parser.id, reasonCode: "UNSUPPORTED_FORMAT" };
  }
  if (PENDING_PARSERS.has(database)) {
    return { structured: false, parser: "none", reasonCode: PENDING_PARSERS.get(database) ?? "PARSER_NOT_IMPLEMENTED" };
  }
  return { structured: false, parser: "none", reasonCode: "UNKNOWN_DATABASE" };
}

/**
 * Run the structured pipeline when the family has a parser, otherwise report a
 * raw-only result. A malformed payload for a family that *does* have a parser
 * still throws `PlanParseError` — that is a real contract violation, not a
 * missing feature.
 *
 * @param {import("../raw-plan-input.js").RawPlanInput} rawInput
 * @returns {PlanAnalysis}
 * @throws {import("../errors.js").PlanInputError} the input is not a valid RawPlanInput
 * @throws {PlanParseError} the family has a parser and the payload is malformed
 */
export function analyzeRawPlan(rawInput) {
  const problems = validateRawPlanInput(rawInput);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }

  const support = describeParserSupport(rawInput.database, rawInput.format);
  if (!support.structured) {
    return {
      status: "raw-only",
      parser: support.parser,
      reasonCode: support.reasonCode,
      reason: describeRawOnlyReason(rawInput, support.reasonCode),
      parsed: null,
      normalized: null,
      metrics: null,
      findings: [],
      hotspots: null,
    };
  }

  const parser = PARSERS.get(rawInput.database);
  if (parser === undefined) {
    // describeParserSupport said structured; this cannot happen. Fail loudly
    // instead of silently degrading a plan the caller expects to be parsed.
    throw new PlanParseError("PARSER_REGISTRY_INCONSISTENT", `No parser registered for ${rawInput.database}.`);
  }

  const parsed = parser.parse(rawInput);
  const normalized = parser.normalize(parsed);
  const metrics = computeMetrics(normalized);

  return {
    status: "structured",
    parser: parser.id,
    reasonCode: null,
    reason: null,
    parsed,
    normalized,
    metrics,
    findings: runRules(normalized, metrics),
    hotspots: computeHotspots(normalized, metrics),
  };
}

/**
 * @param {import("../raw-plan-input.js").RawPlanInput} rawInput
 * @param {string | null} reasonCode
 */
function describeRawOnlyReason(rawInput, reasonCode) {
  switch (reasonCode) {
    case "UNSUPPORTED_FORMAT":
      return `${rawInput.database} has a structured parser but not for format "${rawInput.format}".`;
    case "UNKNOWN_DATABASE":
      return `No structured parser is registered for database "${rawInput.database}".`;
    default:
      return `Structured parser not implemented for "${rawInput.database}" yet; the Raw Plan is still available.`;
  }
}
