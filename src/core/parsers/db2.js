import { parseDb2JsonPlan } from "../db2/parse-json-plan.js";
import { normalizeDb2Plan } from "../normalize/normalize-db2.js";

/** DB2 LUW Estimated JSON v1 parser. Db2 for z/OS and Db2 for i are not inferred. */
export const db2Parser = Object.freeze({
  id: "db2-luw-json-v1",
  database: "db2",
  formats: Object.freeze(["json"]),
  /** @param {import("../raw-plan-input.js").RawPlanInput} rawInput */
  parse: (rawInput) => parseDb2JsonPlan(rawInput),
  /** @param {ReturnType<typeof parseDb2JsonPlan>} parsed */
  normalize: (parsed) => normalizeDb2Plan(parsed),
});
