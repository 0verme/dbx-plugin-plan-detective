import { PlanInputError, PlanParseError } from "../errors.js";
import { validateRawPlanInput } from "../raw-plan-input.js";
import { parsePostgresFamilyJsonPlan } from "../postgres/parse-json-plan.js";

const MAX_DWS_PLAN_NODES = 20_000;
const MAX_DWS_PLAN_DEPTH = 512;

/**
 * Parse a GaussDB / Huawei DWS Estimated JSON plan. The shared PostgreSQL-family
 * walker handles the common envelope / fields; this boundary keeps the family
 * explicit, limits hostile tree sizes and rejects actual-plan input.
 *
 * @param {import("../raw-plan-input.js").RawPlanInput} input
 */
export function parseGaussdbJsonPlan(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }
  if (input.database !== "gaussdb") {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Expected database "gaussdb"; got ${JSON.stringify(input.database)}.`);
  }
  if (input.mode !== "estimated") {
    throw new PlanParseError("MODE_MISMATCH", 'GaussDB/DWS parser only supports mode "estimated".');
  }

  assertPlanTreeBounds(input.plan);
  return parsePostgresFamilyJsonPlan(input, "gaussdb");
}

/**
 * Guard recursion / memory use before the shared recursive tree walker runs.
 * Malformed envelopes are left to that walker so they keep its specific shape
 * errors; only a well-formed envelope is traversed here.
 * @param {unknown} plan
 */
function assertPlanTreeBounds(plan) {
  if (!Array.isArray(plan) || plan.length !== 1 || !isPlainObject(plan[0]) || !isPlainObject(plan[0].Plan)) return;

  /** @type {Array<{ node: Record<string, unknown>, depth: number }>} */
  const pending = [{ node: plan[0].Plan, depth: 1 }];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    count += 1;
    if (count > MAX_DWS_PLAN_NODES) {
      throw new PlanParseError("PLAN_TOO_LARGE", `GaussDB/DWS plan exceeds the ${MAX_DWS_PLAN_NODES}-node parser limit.`);
    }
    if (current.depth > MAX_DWS_PLAN_DEPTH) {
      throw new PlanParseError("PLAN_TOO_DEEP", `GaussDB/DWS plan exceeds the ${MAX_DWS_PLAN_DEPTH}-level parser limit.`);
    }
    const children = current.node.Plans;
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (isPlainObject(child)) pending.push({ node: child, depth: current.depth + 1 });
    }
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
