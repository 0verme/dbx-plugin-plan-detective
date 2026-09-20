/**
 * Public surface of Plan Core.
 *
 * Host adapters, the future UI and tests import from here instead of reaching
 * into internal modules.
 */

export { analyzePlan } from "./analyze.js";
export { adaptDbxEstimatedPlanResponse } from "./adapter/dbx-plan-response.js";
export { DbxPlanAdapterError, PlanInputError, PlanParseError } from "./errors.js";
export { createRawPlanInput, validateRawPlanInput, SUPPORTED_DATABASES, SUPPORTED_MODES, SUPPORTED_FORMATS } from "./raw-plan-input.js";
export { parsePostgresJsonPlan } from "./postgres/parse-json-plan.js";
export { normalizePostgresPlan } from "./normalize/normalize-postgres.js";
export { computeMetrics } from "./metrics/compute-metrics.js";
export { runRules, RULES } from "./rules/index.js";
export { LARGE_SEQUENTIAL_SCAN, EXPENSIVE_SORT, NESTED_LOOP_LARGE_INNER } from "./rules/thresholds.js";
export { createFinding, nodeEvidence, SEVERITIES } from "./findings/finding.js";
export { walkNodes, flattenNodes, depthOf, incrementalCostOf } from "./tree.js";
