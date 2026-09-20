import { computeMetrics } from "./metrics/compute-metrics.js";
import { normalizePostgresPlan } from "./normalize/normalize-postgres.js";
import { parsePostgresJsonPlan } from "./postgres/parse-json-plan.js";
import { runRules } from "./rules/index.js";

/**
 * Offline analysis pipeline:
 *
 *     RawPlanInput -> parse -> NormalizedPlan -> metrics -> rules -> findings
 *
 * This is the single entry point the future adapter and UI should call. It
 * never touches a database, a host bridge or the network: everything it needs
 * is in the RawPlanInput.
 *
 * @param {unknown} rawInput a RawPlanInput (see raw-plan-input.js)
 * @returns {{
 *   parsed: import("./postgres/parse-json-plan.js").ParsedPlan,
 *   normalized: import("./normalize/normalize-postgres.js").NormalizedPlan,
 *   metrics: import("./metrics/compute-metrics.js").PlanMetrics,
 *   findings: import("./findings/finding.js").Finding[],
 * }}
 */
export function analyzePlan(rawInput) {
  const parsed = parsePostgresJsonPlan(rawInput);
  const normalized = normalizePostgresPlan(parsed);
  const metrics = computeMetrics(normalized);
  const findings = runRules(normalized, metrics);

  return { parsed, normalized, metrics, findings };
}
