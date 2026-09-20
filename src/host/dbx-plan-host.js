/**
 * DBX Host Plan API adapter — the only module that talks to `window.dbxPlugin`
 * for plan acquisition.
 *
 * Canonical upstream contract (merged):
 *   - t8y2/dbx#9675 (issue) / t8y2/dbx#9692 (implementation)
 *   - Host API 1.2, permission `host.plans:read`
 *   - `dbxPlugin.capabilities.planApi` is the runtime advertisement
 *   - `getPlanCapabilities(connectionId)`
 *   - `explainPlan({ connectionId, database?, schema?, sql, mode, timeoutMs? })`
 *
 * This module owns exactly one job: call those two methods, enforce the
 * documented request/response shape, and turn failures into `HostPlanError`.
 * It does not parse a plan, run a rule, build a RawPlanInput, or touch the DOM.
 * The parser layer and the UI never see a raw bridge error.
 *
 * The bridge is injected instead of read from `globalThis` so every behavior
 * below is testable in Node without a DBX host.
 */

import { HostPlanError, toHostPlanError } from "./host-plan-errors.js";

/** Host-wide ceiling for `timeoutMs`, mirrored from `MAX_PLUGIN_PLAN_TIMEOUT_MS`. */
export const MAX_PLUGIN_PLAN_TIMEOUT_MS = 60_000;
/** Host-wide ceiling for `rawPlan`, mirrored from `MAX_PLUGIN_PLAN_BYTES`. */
export const MAX_PLUGIN_PLAN_BYTES = 4 * 1024 * 1024;
/** Host-wide ceiling for the submitted `sql`, mirrored from `MAX_PLUGIN_PLAN_SQL_CHARS`. */
export const MAX_PLUGIN_PLAN_SQL_CHARS = 200_000;
/** Permission the manifest must declare to reach either plan method. */
export const PLAN_API_PERMISSION = "host.plans:read";
/** The only plan mode the host serves; the caller cannot choose another. */
export const ESTIMATED_PLAN_MODE = "estimated";
/** Plan formats the merged contract can return. */
export const PLAN_FORMATS = Object.freeze(["json", "xml", "text"]);
/** Warning codes the merged contract defines. */
export const PLAN_WARNING_CODES = Object.freeze({
  notJson: "plan_not_json",
  truncated: "plan_truncated",
  rowsTruncated: "plan_rows_truncated",
});

/** Extra UI-side grace on top of the host-enforced timeout. */
const DEFAULT_GUARD_MARGIN_MS = 10_000;
/** Guard used when the caller requested no explicit timeout. */
const DEFAULT_GUARD_MS = MAX_PLUGIN_PLAN_TIMEOUT_MS + DEFAULT_GUARD_MARGIN_MS;

/**
 * Read the bridge the DBX host injected into the plugin iframe.
 *
 * @param {unknown} [target] defaults to `globalThis`; injectable for tests
 * @returns {Record<string, unknown> | null}
 */
export function resolvePlanBridge(target = globalThis) {
  const candidate = target?.dbxPlugin;
  return candidate !== null && typeof candidate === "object" ? candidate : null;
}

/**
 * Runtime states of the plan API gate.
 *
 *   initializing - the bridge object exists, but the host `init` message that
 *                  fills `capabilities` has not been observed yet
 *   available    - the host advertised `capabilities.planApi === true` and both
 *                  methods are present
 *   unavailable  - no bridge, no `planApi` advertisement after init, or an
 *                  advertisement that disagrees with the method surface
 */
export const PLAN_API_STATES = Object.freeze({
  initializing: "initializing",
  available: "available",
  unavailable: "unavailable",
});

/**
 * Describe the plan API surface of one bridge without calling anything.
 *
 * The merged contract is capability-first: `capabilities.planApi` is the host's
 * init-time advertisement, and `planApi !== true` fails closed even when both
 * methods exist. Method presence alone is not a capability probe.
 *
 * The DBX SDK installs `window.dbxPlugin` (with both methods) before the init
 * message fills `capabilities`, so a pre-init bridge is `initializing`, not
 * `unavailable`. A caller that observed the init message passes
 * `{ initialized: true }`; a missing `planApi` then becomes a hard
 * `unavailable` instead of waiting forever.
 *
 * @param {unknown} bridge
 * @param {{ initialized?: boolean }} [options]
 * @returns {{
 *   state: "initializing" | "available" | "unavailable",
 *   available: boolean,
 *   advertised: boolean,
 *   missing: string[],
 *   reason: string | null,
 * }}
 */
export function describePlanApi(bridge, options = {}) {
  if (bridge === null || typeof bridge !== "object") {
    return {
      state: PLAN_API_STATES.unavailable,
      available: false,
      advertised: false,
      missing: ["getPlanCapabilities", "explainPlan"],
      reason: "当前不在 DBX 宿主中：window.dbxPlugin 不存在。",
    };
  }

  const missing = [];
  if (typeof bridge.getPlanCapabilities !== "function") missing.push("getPlanCapabilities");
  if (typeof bridge.explainPlan !== "function") missing.push("explainPlan");

  const advertised = bridge.capabilities?.planApi === true;

  if (advertised && missing.length === 0) {
    return { state: PLAN_API_STATES.available, available: true, advertised: true, missing: [], reason: null };
  }

  if (advertised) {
    return {
      state: PLAN_API_STATES.unavailable,
      available: false,
      advertised: true,
      missing,
      reason: `宿主声明 planApi，但缺少方法：${missing.join(", ")}。`,
    };
  }

  if (options.initialized !== true && canStillInitialize(bridge)) {
    return {
      state: PLAN_API_STATES.initializing,
      available: false,
      advertised: false,
      missing,
      reason: "DBX 宿主尚未完成初始化，暂时无法确认 planApi 能力；不会调用 Host Plan API 探测。",
    };
  }

  return {
    state: PLAN_API_STATES.unavailable,
    available: false,
    advertised: false,
    missing,
    reason: "宿主未声明 capabilities.planApi（需要 DBX Host API 1.2 / t8y2/dbx#9692 及以上）；不会调用 Host Plan API 探测。",
  };
}

/**
 * Whether the bridge still has a documented way to deliver its init message:
 * the SDK `ready` promise and/or the `onInit` listener. A bridge without either
 * cannot leave `initializing`, so the gate fails closed instead of waiting.
 *
 * @param {Record<string, unknown>} bridge
 * @returns {boolean}
 */
function canStillInitialize(bridge) {
  const ready = bridge.ready;
  const hasReady =
    ready !== null && (typeof ready === "object" || typeof ready === "function") && typeof ready.then === "function";
  return hasReady || typeof bridge.onInit === "function";
}

/**
 * Ask the host what this connection can plan. The host only reads the stored
 * connection config, but the connection must already be open; a closed
 * connection is rejected here instead of dialled on the plugin's behalf.
 *
 * @param {Record<string, unknown>} bridge
 * @param {string} connectionId
 * @returns {Promise<{
 *   dbType: string, dbVersion?: string,
 *   supports: { estimatedPlan: boolean },
 *   limits: { maxTimeoutMs: number, maxPlanBytes: number },
 * }>}
 * @throws {HostPlanError}
 */
export async function getPlanCapabilities(bridge, connectionId) {
  assertPlanApi(bridge);
  const id = requireConnectionId(connectionId);

  let raw;
  try {
    raw = await bridge.getPlanCapabilities(id);
  } catch (error) {
    throw toHostPlanError(error, { operation: "host.getPlanCapabilities" });
  }

  return validateCapabilities(raw);
}

/**
 * Acquire one estimated plan through the host.
 *
 * `mode` is not a parameter: this function always sends `"estimated"`, and a
 * caller that tries to pass another mode is rejected before the bridge sees it.
 * The host builds the EXPLAIN statement, owns the connection and the timeout,
 * and returns the raw plan only.
 *
 * @param {Record<string, unknown>} bridge
 * @param {{ connectionId: string, sql: string, database?: string | null, schema?: string | null, timeoutMs?: number | null, mode?: string }} request
 * @param {{ guardMs?: number | null }} [options] UI-side guard; `null` disables it
 * @returns {Promise<{
 *   dbType: string, dbVersion?: string,
 *   format: "json" | "xml" | "text",
 *   rawPlan: unknown, truncated: boolean, warnings: string[],
 * }>}
 * @throws {HostPlanError}
 */
export async function explainEstimatedPlan(bridge, request, options = {}) {
  assertPlanApi(bridge);
  const normalized = normalizePlanRequest(request);
  const guardMs = resolveGuardMs(options, normalized.timeoutMs);

  let raw;
  try {
    raw = await withGuard(bridge.explainPlan(normalized), guardMs);
  } catch (error) {
    throw toHostPlanError(error, { operation: "host.explainPlan" });
  }

  return validatePlanResult(raw);
}

/**
 * @param {unknown} bridge
 * @throws {HostPlanError}
 */
function assertPlanApi(bridge) {
  const api = describePlanApi(bridge);
  if (api.available) return;
  throw new HostPlanError("PLAN_API_UNAVAILABLE", api.reason ?? "DBX Plan API is unavailable.", {
    hostMessage: api.reason,
  });
}

/**
 * @param {unknown} connectionId
 * @returns {string}
 */
function requireConnectionId(connectionId) {
  if (typeof connectionId !== "string") {
    throw new HostPlanError("INVALID_REQUEST", "connectionId must be a string.");
  }
  const trimmed = connectionId.trim();
  if (trimmed.length === 0) {
    throw new HostPlanError("INVALID_REQUEST", "connectionId must not be empty.");
  }
  if (trimmed.length > 256) {
    throw new HostPlanError("INVALID_REQUEST", "connectionId must be at most 256 characters.");
  }
  return trimmed;
}

/**
 * Validate and normalize one plan request. Mirrors the bridge and core bounds
 * so an obviously invalid request never reaches the host.
 *
 * @param {{
 *   connectionId: string, sql: string,
 *   database?: string | null, schema?: string | null,
 *   timeoutMs?: number | null, mode?: string,
 * }} request
 */
function normalizePlanRequest(request) {
  if (request === null || typeof request !== "object") {
    throw new HostPlanError("INVALID_REQUEST", "Plan request must be an object.");
  }
  if (request.mode !== undefined && request.mode !== ESTIMATED_PLAN_MODE) {
    throw new HostPlanError(
      "UNSUPPORTED_MODE",
      `This adapter only sends mode "${ESTIMATED_PLAN_MODE}"; got ${JSON.stringify(request.mode)}.`,
    );
  }

  const connectionId = requireConnectionId(request.connectionId);

  if (typeof request.sql !== "string") {
    throw new HostPlanError("INVALID_REQUEST", "sql must be a string.");
  }
  const sql = request.sql.trim();
  if (sql.length === 0) {
    throw new HostPlanError("EMPTY_SQL", "Plan requests need a non-empty sql.");
  }
  if (sql.length > MAX_PLUGIN_PLAN_SQL_CHARS) {
    throw new HostPlanError("SQL_TOO_LARGE", `sql exceeds ${MAX_PLUGIN_PLAN_SQL_CHARS} characters.`);
  }

  const database = optionalScope(request.database, "database");
  const schema = optionalScope(request.schema, "schema");
  const timeoutMs = request.timeoutMs === undefined || request.timeoutMs === null ? null : clampTimeout(request.timeoutMs);

  return {
    connectionId,
    sql,
    mode: ESTIMATED_PLAN_MODE,
    ...(database === undefined ? {} : { database }),
    ...(schema === undefined ? {} : { schema }),
    ...(timeoutMs === null ? {} : { timeoutMs }),
  };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string | undefined}
 */
function optionalScope(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HostPlanError("INVALID_REQUEST", `${label} must be a string when present.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 256) {
    throw new HostPlanError("INVALID_REQUEST", `${label} must be at most 256 characters.`);
  }
  return trimmed;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function clampTimeout(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HostPlanError("INVALID_REQUEST", "timeoutMs must be a finite number.");
  }
  return Math.min(MAX_PLUGIN_PLAN_TIMEOUT_MS, Math.max(1, Math.round(value)));
}

/**
 * The host enforces its own timeout from the request; this guard exists only so
 * a host-side bug cannot leave the UI spinning forever. It never shortens a
 * request the host accepted.
 *
 * @param {{ guardMs?: number | null } | undefined} options
 * @param {number | null} timeoutMs
 * @returns {number | null}
 */
function resolveGuardMs(options, timeoutMs) {
  if (options?.guardMs === null) return null;
  if (typeof options?.guardMs === "number" && Number.isFinite(options.guardMs)) {
    return Math.max(1, Math.round(options.guardMs));
  }
  return timeoutMs === null ? DEFAULT_GUARD_MS : timeoutMs + DEFAULT_GUARD_MARGIN_MS;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number | null} guardMs
 * @returns {Promise<T>}
 */
function withGuard(promise, guardMs) {
  if (guardMs === null) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HostPlanError("TIMEOUT", `host plan call did not answer within ${guardMs} ms.`));
    }, guardMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Structural gate for `PluginPlanCapabilities`. Every field is part of the
 * merged contract, so a missing or mistyped one means the host did not answer
 * that contract and the UI must not guess.
 *
 * @param {unknown} raw
 */
function validateCapabilities(raw) {
  if (!isPlainObject(raw)) {
    throw invalidResponse(`capabilities must be a plain object; got ${describeValue(raw)}.`);
  }
  if (typeof raw.dbType !== "string" || raw.dbType.length === 0) {
    throw invalidResponse(`capabilities.dbType must be a non-empty string; got ${describeValue(raw.dbType)}.`);
  }
  if (raw.dbVersion !== undefined && typeof raw.dbVersion !== "string") {
    throw invalidResponse(`capabilities.dbVersion must be a string when present; got ${describeValue(raw.dbVersion)}.`);
  }
  if (!isPlainObject(raw.supports) || typeof raw.supports.estimatedPlan !== "boolean") {
    throw invalidResponse("capabilities.supports.estimatedPlan must be a boolean.");
  }
  if (!isPlainObject(raw.limits)) {
    throw invalidResponse("capabilities.limits must be an object.");
  }
  if (!isPositiveNumber(raw.limits.maxTimeoutMs)) {
    throw invalidResponse("capabilities.limits.maxTimeoutMs must be a positive number.");
  }
  if (!isPositiveNumber(raw.limits.maxPlanBytes)) {
    throw invalidResponse("capabilities.limits.maxPlanBytes must be a positive number.");
  }

  return {
    dbType: raw.dbType,
    ...(raw.dbVersion === undefined ? {} : { dbVersion: raw.dbVersion }),
    supports: { estimatedPlan: raw.supports.estimatedPlan },
    limits: { maxTimeoutMs: raw.limits.maxTimeoutMs, maxPlanBytes: raw.limits.maxPlanBytes },
  };
}

/**
 * Structural gate for `PluginPlanResult`. `rawPlan` is returned untouched: the
 * UI and the Raw Plan viewer must show exactly what the host produced.
 *
 * @param {unknown} raw
 */
function validatePlanResult(raw) {
  if (!isPlainObject(raw)) {
    throw invalidResponse(`plan result must be a plain object; got ${describeValue(raw)}.`);
  }
  if (typeof raw.dbType !== "string" || raw.dbType.length === 0) {
    throw invalidResponse(`plan result dbType must be a non-empty string; got ${describeValue(raw.dbType)}.`);
  }
  if (raw.dbVersion !== undefined && typeof raw.dbVersion !== "string") {
    throw invalidResponse(`plan result dbVersion must be a string when present; got ${describeValue(raw.dbVersion)}.`);
  }
  if (!PLAN_FORMATS.includes(raw.format)) {
    throw invalidResponse(`plan result format must be one of ${PLAN_FORMATS.join(", ")}; got ${describeValue(raw.format)}.`);
  }
  if (!Object.hasOwn(raw, "rawPlan") || raw.rawPlan === undefined || raw.rawPlan === null) {
    throw invalidResponse("plan result rawPlan is required and must not be null.");
  }
  if (raw.format === "json" && typeof raw.rawPlan === "string") {
    throw invalidResponse("plan result format is json but rawPlan is a string.");
  }
  if (raw.format !== "json" && typeof raw.rawPlan !== "string") {
    throw invalidResponse(`plan result format is ${raw.format} but rawPlan is not a string.`);
  }
  if (typeof raw.truncated !== "boolean") {
    throw invalidResponse(`plan result truncated must be a boolean; got ${describeValue(raw.truncated)}.`);
  }
  if (!Array.isArray(raw.warnings) || raw.warnings.some((warning) => typeof warning !== "string")) {
    throw invalidResponse(`plan result warnings must be an array of strings; got ${describeValue(raw.warnings)}.`);
  }
  if (raw.warnings.includes(PLAN_WARNING_CODES.notJson) && raw.format !== "text") {
    throw invalidResponse("plan result carries plan_not_json but format is not text.");
  }

  return {
    dbType: raw.dbType,
    ...(raw.dbVersion === undefined ? {} : { dbVersion: raw.dbVersion }),
    format: raw.format,
    rawPlan: raw.rawPlan,
    truncated: raw.truncated,
    warnings: [...raw.warnings],
  };
}

/** @param {string} message */
function invalidResponse(message) {
  return new HostPlanError("INVALID_RESPONSE", message);
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Describe an unexpected value for an error message without dumping a payload.
 *
 * @param {unknown} value
 */
function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length ${value.length})`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") {
    const shown = value.length > 40 ? `${value.slice(0, 37)}...` : value;
    return `string(${JSON.stringify(shown)})`;
  }
  return `${typeof value}(${String(value)})`;
}
