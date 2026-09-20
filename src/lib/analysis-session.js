/**
 * Host analysis session: the single orchestration path from a DBX connection
 * and a SQL string to a renderable analysis result.
 *
 *     Host bridge -> getPlanCapabilities -> explainPlan(mode: "estimated")
 *       -> RawPlanInput (adapter) -> analyzeRawPlan (parser registry) -> view data
 *
 * It is pure with respect to the environment: the bridge is injected, nothing
 * touches the DOM, and every expected failure is returned as a state instead of
 * being thrown at the component. That keeps the component a renderer and makes
 * the whole state machine testable in Node with a fake bridge.
 *
 * The session never opens a connection, never sends credentials and never asks
 * for a mode other than `"estimated"`.
 */

import { analyzeRawPlan } from "../core/parsers/index.js";
import { adaptDbxEstimatedPlanResponse } from "../core/adapter/dbx-plan-response.js";
import { DbxPlanAdapterError, PlanInputError, PlanParseError } from "../core/errors.js";
import { HostPlanError, describePlanApi, explainEstimatedPlan, getPlanCapabilities } from "../host/index.js";

/** Every status the UI has to render. */
export const ANALYSIS_STATUS = Object.freeze({
  idle: "idle",
  loading: "loading",
  structured: "structured",
  rawOnly: "raw-only",
  truncated: "truncated",
  unsupported: "unsupported",
  error: "error",
});

/** The only request mode the merged host contract serves. */
const MODE_ESTIMATED = "estimated";

/**
 * @returns {{ status: "idle" }}
 */
export function idleAnalysis() {
  return { status: ANALYSIS_STATUS.idle };
}

/**
 * @returns {{ status: "loading" }}
 */
export function loadingAnalysis() {
  return { status: ANALYSIS_STATUS.loading };
}

/**
 * Load per-connection plan capabilities for display. Does not acquire a plan.
 *
 * @param {{ bridge: unknown, connectionId: string }} input
 * @returns {Promise<
 *   | { status: "ready", capabilities: object }
 *   | { status: "error", error: { code: string, message: string, hostMessage: string | null, name: string } }
 * >}
 */
export async function loadPlanCapabilities({ bridge, connectionId }) {
  const api = describePlanApi(bridge);
  if (!api.available) {
    return errorState(new HostPlanError("PLAN_API_UNAVAILABLE", api.reason ?? "DBX Plan API is unavailable."));
  }

  try {
    const capabilities = await getPlanCapabilities(bridge, connectionId);
    return { status: "ready", capabilities };
  } catch (error) {
    return errorState(error);
  }
}

/**
 * Run the full host acquisition + analysis path.
 *
 * @param {{
 *   bridge: unknown,
 *   connectionId: string,
 *   sql: string,
 *   database?: string | null,
 *   schema?: string | null,
 *   timeoutMs?: number | null,
 *   guardMs?: number | null,
 * }} input
 * @returns {Promise<object>} one of the ANALYSIS_STATUS results
 */
export async function runHostAnalysis(input) {
  const api = describePlanApi(input?.bridge);
  if (!api.available) {
    return errorState(new HostPlanError("PLAN_API_UNAVAILABLE", api.reason ?? "DBX Plan API is unavailable."));
  }

  /** @type {object | null} */
  let capabilities = null;
  try {
    // 1. Capability first: never probe the host with a real plan request.
    capabilities = await getPlanCapabilities(input.bridge, input.connectionId);
    if (capabilities.supports.estimatedPlan !== true) {
      return {
        status: ANALYSIS_STATUS.unsupported,
        capabilities,
        hostResult: null,
        rawInput: null,
        analysis: null,
        message: `DBX 报告该连接的方言（${capabilities.dbType}）没有 Estimated Plan 获取能力。`,
      };
    }

    // 2. One estimated plan. `mode` is owned by the host adapter, not the UI.
    const hostResult = await explainEstimatedPlan(
      input.bridge,
      {
        connectionId: input.connectionId,
        sql: input.sql,
        database: input.database,
        schema: input.schema,
        timeoutMs: input.timeoutMs,
        mode: MODE_ESTIMATED,
      },
      { guardMs: input.guardMs },
    );

    // 3. A truncated payload is shown raw; parsing it would fabricate findings.
    if (hostResult.truncated) {
      return {
        status: ANALYSIS_STATUS.truncated,
        capabilities,
        hostResult,
        rawInput: null,
        analysis: null,
        message: "宿主返回的计划被截断，无法进行结构化解析；仅展示 Raw Plan 与宿主警告。",
      };
    }

    // 4. Map the host response into the Plan Core contract.
    let rawInput;
    try {
      rawInput = adaptDbxEstimatedPlanResponse(hostResult, { sql: input.sql });
    } catch (error) {
      if (error instanceof DbxPlanAdapterError && error.code === "PLAN_TRUNCATED") {
        return {
          status: ANALYSIS_STATUS.truncated,
          capabilities,
          hostResult,
          rawInput: null,
          analysis: null,
          message: "宿主返回的计划被截断，无法进行结构化解析；仅展示 Raw Plan 与宿主警告。",
        };
      }
      return { ...errorState(error), capabilities, hostResult };
    }

    // 5. Structured when the dialect has a parser; raw-only otherwise.
    let analysis;
    try {
      analysis = analyzeRawPlan(rawInput);
    } catch (error) {
      return { ...errorState(error), capabilities, hostResult, rawInput };
    }

    return {
      status: analysis.status === "structured" ? ANALYSIS_STATUS.structured : ANALYSIS_STATUS.rawOnly,
      capabilities,
      hostResult,
      rawInput,
      analysis,
      message: null,
    };
  } catch (error) {
    return { ...errorState(error), capabilities };
  }
}

/**
 * Normalize any expected failure into the session error state. Unknown errors
 * are wrapped as `HOST_ERROR` instead of being rethrown at the component.
 *
 * @param {unknown} error
 * @returns {{ status: "error", error: { code: string, message: string, hostMessage: string | null, name: string } }}
 */
function errorState(error) {
  if (error instanceof HostPlanError) {
    return { status: ANALYSIS_STATUS.error, error: describeError(error, "HOST_ERROR") };
  }
  if (error instanceof DbxPlanAdapterError) {
    return { status: ANALYSIS_STATUS.error, error: describeError(error, "INVALID_RESPONSE") };
  }
  if (error instanceof PlanInputError) {
    return { status: ANALYSIS_STATUS.error, error: describeError(error, "INVALID_RAW_PLAN_INPUT", "INVALID_RAW_PLAN_INPUT") };
  }
  if (error instanceof PlanParseError) {
    // Parse errors have many specific codes (MALFORMED_NODE, MODE_MISMATCH, ...);
    // the UI shows one parse-failure state and keeps the specific code for
    // debugging instead of growing a copy table per parser detail.
    return { status: ANALYSIS_STATUS.error, error: describeError(error, "PLAN_PARSE_FAILED", "PLAN_PARSE_FAILED") };
  }
  return {
    status: ANALYSIS_STATUS.error,
    error: {
      code: "HOST_ERROR",
      causeCode: "HOST_ERROR",
      message: error instanceof Error ? error.message : String(error),
      hostMessage: null,
      name: error instanceof Error ? error.name : "Error",
    },
  };
}

/**
 * @param {{ code?: string, message?: string, hostMessage?: string | null, name?: string }} error
 * @param {string} fallbackCode
 * @param {string} [overrideCode] stable UI code that replaces a detailed one
 */
function describeError(error, fallbackCode, overrideCode) {
  const causeCode = typeof error.code === "string" && error.code.length > 0 ? error.code : fallbackCode;
  return {
    code: overrideCode ?? causeCode,
    causeCode,
    message: error.message ?? "Unknown plan analysis failure.",
    hostMessage: error.hostMessage ?? null,
    name: error.name ?? "Error",
  };
}
