import { normalizeGaussdbPlan } from "../normalize/normalize-gaussdb.js";
import { parseGaussdbJsonPlan } from "../gaussdb/parse-json-plan.js";

/** Explicit GaussDB/DWS estimated JSON path; it shares only the PG-family tree walker. */
export const gaussdbParser = Object.freeze({
  id: "gaussdb-dws-json",
  database: "gaussdb",
  formats: Object.freeze(["json"]),
  /** @param {import("../raw-plan-input.js").RawPlanInput} rawInput */
  parse: (rawInput) => parseGaussdbJsonPlan(rawInput),
  /** @param {ReturnType<typeof parseGaussdbJsonPlan>} parsed */
  normalize: (parsed) => normalizeGaussdbPlan(parsed),
});
