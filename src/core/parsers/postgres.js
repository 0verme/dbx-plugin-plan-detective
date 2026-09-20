/**
 * PostgreSQL structured parser entry.
 *
 * Wraps the existing PostgreSQL stages behind the parser registry shape:
 *
 *     RawPlanInput -> parsePostgresJsonPlan -> normalizePostgresPlan -> NormalizedPlan
 *
 * The stages themselves are unchanged; this file only declares which database
 * family and format the registry may route here.
 */

import { normalizePostgresPlan } from "../normalize/normalize-postgres.js";
import { parsePostgresJsonPlan } from "../postgres/parse-json-plan.js";

export const postgresParser = Object.freeze({
  id: "postgres",
  database: "postgresql",
  /** Formats this parser accepts. PostgreSQL plans are `EXPLAIN (FORMAT JSON)`. */
  formats: Object.freeze(["json"]),
  /** @param {import("../raw-plan-input.js").RawPlanInput} rawInput */
  parse: (rawInput) => parsePostgresJsonPlan(rawInput),
  /** @param {ReturnType<typeof parsePostgresJsonPlan>} parsed */
  normalize: (parsed) => normalizePostgresPlan(parsed),
});
