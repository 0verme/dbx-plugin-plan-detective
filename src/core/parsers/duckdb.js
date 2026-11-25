import { parseDuckDbTextPlan } from "../duckdb/parse-text-plan.js";
import { normalizeDuckDbPlan } from "../normalize/normalize-duckdb.js";

/**
 * DuckDB's DBX Host contract (t8y2/dbx#14899) is `dbType: "duckdb"`,
 * `format: "text"`, `mode: "estimated"`; the Host executes `EXPLAIN <sql>` and
 * returns the box-rendered physical plan text.
 */
export const duckdbParser = Object.freeze({
  id: "duckdb",
  database: "duckdb",
  formats: Object.freeze(["text"]),
  /** @param {import("../raw-plan-input.js").RawPlanInput} rawInput */
  parse: (rawInput) => parseDuckDbTextPlan(rawInput),
  /** @param {ReturnType<typeof parseDuckDbTextPlan>} parsed */
  normalize: (parsed) => normalizeDuckDbPlan(parsed),
});
