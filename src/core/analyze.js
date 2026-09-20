import { PlanParseError } from "./errors.js";
import { analyzeRawPlan } from "./parsers/index.js";

/**
 * Offline analysis pipeline:
 *
 *     RawPlanInput -> parsePlan (registry) -> NormalizedPlan -> metrics -> rules -> findings
 *
 * This is the single entry point the adapter and UI call. It never touches a
 * database, a host bridge or the network: everything it needs is in the
 * RawPlanInput.
 *
 * `analyzePlan` is the strict form used by the offline fixtures and golden
 * tests: a family without a structured parser throws instead of returning an
 * empty result. The host-facing UI calls `analyzeRawPlan` directly, because a
 * raw-only dialect is a supported outcome there, not a failure.
 *
 * @param {unknown} rawInput a RawPlanInput (see raw-plan-input.js)
 * @returns {{
 *   parsed: import("./postgres/parse-json-plan.js").ParsedPlan,
 *   normalized: import("./normalize/normalize-postgres.js").NormalizedPlan,
 *   metrics: import("./metrics/compute-metrics.js").PlanMetrics,
 *   findings: import("./findings/finding.js").Finding[],
 * }}
 * @throws {import("./errors.js").PlanInputError|import("./errors.js").PlanParseError}
 */
export function analyzePlan(rawInput) {
  const result = analyzeRawPlan(/** @type {import("./raw-plan-input.js").RawPlanInput} */ (rawInput));
  if (result.status !== "structured") {
    throw new PlanParseError(
      result.reasonCode ?? "PARSER_NOT_AVAILABLE",
      result.reason ?? "No structured parser is available for this plan.",
    );
  }

  return {
    parsed: result.parsed,
    normalized: result.normalized,
    metrics: result.metrics,
    findings: result.findings,
  };
}
