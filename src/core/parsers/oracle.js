/**
 * Oracle DBMS_XPLAN structured parser entry.
 *
 * DBX's Oracle driver runs `EXPLAIN PLAN` and then asks
 * `DBMS_XPLAN.DISPLAY('PLAN_TABLE', statementId, 'TYPICAL +PREDICATE')` for
 * text. This parser claims only that estimated text contract; other Oracle
 * display formats remain raw-only instead of being guessed at.
 */

import { normalizeOraclePlan } from "../normalize/normalize-oracle.js";
import { parseOracleTextPlan } from "../oracle/parse-text-plan.js";

export const oracleParser = Object.freeze({
  id: "oracle",
  database: "oracle",
  formats: Object.freeze(["text"]),
  /** @param {import("../raw-plan-input.js").RawPlanInput} rawInput */
  parse: (rawInput) => parseOracleTextPlan(rawInput),
  /** @param {ReturnType<typeof parseOracleTextPlan>} parsed */
  normalize: (parsed) => normalizeOraclePlan(parsed),
});
