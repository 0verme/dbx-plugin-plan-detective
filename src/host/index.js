/**
 * Public surface of the DBX Host boundary.
 *
 * The UI imports from here; Plan Core (`src/core/**`) must never import it.
 * See `tests/core-isolation.test.js`.
 */

export {
  HostPlanError,
  HOST_PLAN_ERROR_CODES,
  classifyHostMessage,
  toHostPlanError,
} from "./host-plan-errors.js";

export {
  MAX_PLUGIN_PLAN_TIMEOUT_MS,
  MAX_PLUGIN_PLAN_BYTES,
  MAX_PLUGIN_PLAN_SQL_CHARS,
  PLAN_API_PERMISSION,
  ESTIMATED_PLAN_MODE,
  PLAN_FORMATS,
  PLAN_WARNING_CODES,
  resolvePlanBridge,
  describePlanApi,
  getPlanCapabilities,
  explainEstimatedPlan,
} from "./dbx-plan-host.js";
