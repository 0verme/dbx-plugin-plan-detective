import { normalizeQuestDbPlan } from "../normalize/normalize-questdb.js";
import { parseQuestDbTextPlan } from "../questdb/parse-text-plan.js";

/**
 * QuestDB's DBX Host contract is `dbType: "questdb"`, `format: "text"`,
 * `mode: "estimated"`; the Host builds `EXPLAIN <source SQL>` and returns its
 * line-oriented result as one raw text string.
 */
export const questDbParser = Object.freeze({
  id: "questdb",
  database: "questdb",
  formats: Object.freeze(["text"]),
  /** @param {import("../raw-plan-input.js").RawPlanInput} rawInput */
  parse: (rawInput) => parseQuestDbTextPlan(rawInput),
  /** @param {ReturnType<typeof parseQuestDbTextPlan>} parsed */
  normalize: (parsed) => normalizeQuestDbPlan(parsed),
});
