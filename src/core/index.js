/**
 * Public surface of Plan Core.
 *
 * Host adapters, the future UI and tests import from here instead of reaching
 * into internal modules.
 */

export { analyzePlan } from "./analyze.js";
export { adaptDbxEstimatedPlanResponse } from "./adapter/dbx-plan-response.js";
export { DbxPlanAdapterError, PlanInputError, PlanParseError } from "./errors.js";
export {
  createRawPlanInput,
  validateRawPlanInput,
  STRUCTURED_DATABASES,
  SUPPORTED_DATABASES,
  SUPPORTED_MODES,
  SUPPORTED_FORMATS,
} from "./raw-plan-input.js";
export { analyzeRawPlan, describeParserSupport, getParser } from "./parsers/index.js";
export { parsePostgresJsonPlan } from "./postgres/parse-json-plan.js";
export { normalizePostgresPlan } from "./normalize/normalize-postgres.js";
export { parseMySqlJsonPlan } from "./mysql/parse-json-plan.js";
export { normalizeMySqlPlan } from "./normalize/normalize-mysql.js";
export { parseSqlServerShowPlanXml } from "./sqlserver/parse-showplan-xml.js";
export { normalizeSqlServerPlan } from "./normalize/normalize-sqlserver.js";
export { parseOceanBaseJsonPlan } from "./oceanbase/parse-json-plan.js";
export { normalizeOceanBasePlan } from "./normalize/normalize-oceanbase.js";
export { parseOracleTextPlan } from "./oracle/parse-text-plan.js";
export { normalizeOraclePlan } from "./normalize/normalize-oracle.js";
export { parseDamengTextPlan } from "./dameng/parse-text-plan.js";
export { normalizeDamengPlan } from "./normalize/normalize-dameng.js";
export { computeMetrics } from "./metrics/compute-metrics.js";
export { computeHotspots } from "./hotspots/compute-hotspots.js";
export { HOTSPOT } from "./hotspots/thresholds.js";
export { runRules, RULES } from "./rules/index.js";
export { LARGE_SEQUENTIAL_SCAN, EXPENSIVE_SORT, NESTED_LOOP_LARGE_INNER } from "./rules/thresholds.js";
export { createFinding, nodeEvidence, SEVERITIES } from "./findings/finding.js";
export { walkNodes, flattenNodes, depthOf, incrementalCostOf } from "./tree.js";
