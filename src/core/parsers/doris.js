/** Doris Estimated EXPLAIN text parser entry. */

import { normalizeDorisPlan } from "../normalize/normalize-doris.js";
import { parseDorisTextPlan } from "../doris/parse-text-plan.js";

export const dorisParser = Object.freeze({
  id: "doris",
  database: "doris",
  formats: Object.freeze(["text"]),
  /** @param {import("../raw-plan-input.js").RawPlanInput} rawInput */
  parse: (rawInput) => parseDorisTextPlan(rawInput),
  /** @param {ReturnType<typeof parseDorisTextPlan>} parsed */
  normalize: (parsed) => normalizeDorisPlan(parsed),
});
