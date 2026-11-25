import { normalizeSqlitePlan } from "../normalize/normalize-sqlite.js";
import { parseSqliteJsonPlan } from "../sqlite/parse-json-plan.js";

/**
 * SQLite's DBX Host contract (t8y2/dbx#14885) is `dbType: "sqlite"`,
 * `format: "json"`, `mode: "estimated"`; the Host executes `EXPLAIN QUERY PLAN`
 * and returns a structured array of `{ id, parent, notused, detail }` objects.
 */
export const sqliteParser = Object.freeze({
  id: "sqlite",
  database: "sqlite",
  formats: Object.freeze(["json"]),
  /** @param {import("../raw-plan-input.js").RawPlanInput} rawInput */
  parse: (rawInput) => parseSqliteJsonPlan(rawInput),
  /** @param {ReturnType<typeof parseSqliteJsonPlan>} parsed */
  normalize: (parsed) => normalizeSqlitePlan(parsed),
});
