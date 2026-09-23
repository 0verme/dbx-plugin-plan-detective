import { normalizeOceanBasePlan } from "../normalize/normalize-oceanbase.js";
import { parseOceanBaseJsonPlan } from "../oceanbase/parse-json-plan.js";

/**
 * Shared registry entry factory for OceanBase compatibility modes.
 *
 * Oracle and MySQL mode keep distinct Plan Core database families, but both
 * use the same OceanBase-native JSON parser and normalizer.
 *
 * @param {"oceanbase-oracle"|"oceanbase-mysql"} database
 */
export function createOceanBaseJsonParser(database) {
  return Object.freeze({
    id: database,
    database,
    formats: Object.freeze(["json"]),
    /** @param {import("../raw-plan-input.js").RawPlanInput} rawInput */
    parse: parseOceanBaseJsonPlan,
    /** @param {ReturnType<typeof parseOceanBaseJsonPlan>} parsed */
    normalize: normalizeOceanBasePlan,
  });
}
