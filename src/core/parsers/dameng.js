/**
 * Dameng DM8 estimated EXPLAIN text parser entry.
 *
 * DBX's Dameng native path returns the driver's text plan unchanged. This
 * parser claims only that estimated text contract; it does not execute SQL or
 * infer an actual/autotrace plan.
 */

import { normalizeDamengPlan } from "../normalize/normalize-dameng.js";
import { parseDamengTextPlan } from "../dameng/parse-text-plan.js";

export const damengParser = Object.freeze({
  id: "dameng",
  database: "dameng",
  formats: Object.freeze(["text"]),
  /** @param {import("../raw-plan-input.js").RawPlanInput} rawInput */
  parse: (rawInput) => parseDamengTextPlan(rawInput),
  /** @param {ReturnType<typeof parseDamengTextPlan>} parsed */
  normalize: (parsed) => normalizeDamengPlan(parsed),
});
