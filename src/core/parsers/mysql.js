/**
 * MySQL structured parser entry.
 *
 * Wraps the MySQL stages behind the parser registry shape:
 *
 *     RawPlanInput -> parseMySqlJsonPlan -> normalizeMySqlPlan -> NormalizedPlan
 *
 * The stages are unchanged; this file only declares which database family and
 * format the registry may route here.
 */

import { parseMySqlJsonPlan } from "../mysql/parse-json-plan.js";
import { normalizeMySqlPlan } from "../normalize/normalize-mysql.js";

export const mysqlParser = Object.freeze({
  id: "mysql",
  database: "mysql",
  /** Formats this parser accepts. DBX asks MySQL for `EXPLAIN FORMAT=JSON`. */
  formats: Object.freeze(["json"]),
  /** @param {import("../raw-plan-input.js").RawPlanInput} rawInput */
  parse: (rawInput) => parseMySqlJsonPlan(rawInput),
  /** @param {ReturnType<typeof parseMySqlJsonPlan>} parsed */
  normalize: (parsed) => normalizeMySqlPlan(parsed),
});
