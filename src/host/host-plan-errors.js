/**
 * Stable error contract for the DBX Plan Host API boundary.
 *
 * The host bridge rejects a plan call with a plain string (the bridge forwards
 * `error.message` from the DBX side), so this module is the single place that
 * turns those strings into stable machine-readable codes. UI copy and tests
 * branch on the code, never on the host message.
 *
 * Canonical upstream contract: t8y2/dbx#9675, implementation t8y2/dbx#9692.
 * The patterns below are copied from the messages that actually exist in:
 *   - crates/dbx-core/src/query/plugin_plan.rs
 *   - apps/desktop/src/lib/plugins/pluginHostBridge.ts
 * A message change upstream degrades to `HOST_ERROR`, it never crashes the UI.
 */

/** Every code this boundary can produce. */
export const HOST_PLAN_ERROR_CODES = Object.freeze([
  /** `window.dbxPlugin` has no plan methods (older DBX / host API < 1.2). */
  "PLAN_API_UNAVAILABLE",
  /** The manifest did not declare `host.plans:read`. */
  "PERMISSION_NOT_DECLARED",
  /** The connection is saved but DBX does not hold it open. */
  "CONNECTION_NOT_OPEN",
  /** The connection id is unknown to DBX. */
  "CONNECTION_NOT_FOUND",
  /** The dialect has no estimated plan path in DBX. */
  "UNSUPPORTED_DIALECT",
  /** The request did not carry the only served mode, `"estimated"`. */
  "UNSUPPORTED_MODE",
  /** The statement is empty. */
  "EMPTY_SQL",
  /** The statement exceeds the host's SQL size bound. */
  "SQL_TOO_LARGE",
  /** DBX's read-only plan gate rejected the statement. */
  "UNSAFE_SQL",
  /** The plan exceeds the host's payload bound. */
  "PLAN_TOO_LARGE",
  /** The server answered with an empty plan. */
  "EMPTY_PLAN",
  /** The plan call exceeded its time budget. */
  "TIMEOUT",
  /** The caller sent a request the host cannot accept. */
  "INVALID_REQUEST",
  /** The host answered with a shape this boundary cannot trust. */
  "INVALID_RESPONSE",
  /** Anything else the host reported. */
  "HOST_ERROR",
]);

/**
 * Error raised by the host boundary. `code` is stable; `message` is a neutral
 * description that never includes the plan payload or a credential.
 */
export class HostPlanError extends Error {
  /**
   * @param {string} code one of HOST_PLAN_ERROR_CODES
   * @param {string} message neutral description
   * @param {{ hostMessage?: string | null, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = "HostPlanError";
    this.code = code;
    this.hostMessage = options.hostMessage ?? null;
    this.cause = options.cause;
  }
}

/** Ordered matchers; the first match wins, so specific messages come first. */
const CLASSIFIERS = Object.freeze([
  { code: "PLAN_API_UNAVAILABLE", pattern: /host plan api is unavailable|unsupported plugin host method/i },
  { code: "PERMISSION_NOT_DECLARED", pattern: /not declared permission|missing plugin permission/i },
  { code: "CONNECTION_NOT_OPEN", pattern: /connection is not open/i },
  { code: "CONNECTION_NOT_FOUND", pattern: /connection config not found/i },
  { code: "UNSUPPORTED_DIALECT", pattern: /estimated execution plans are not available for/i },
  { code: "UNSUPPORTED_MODE", pattern: /serves mode "estimated" only|support mode 'estimated' only/i },
  { code: "SQL_TOO_LARGE", pattern: /sql exceeds|sql must be at most|sql is too long/i },
  { code: "EMPTY_SQL", pattern: /non-empty sql|requires sql|need a non-empty sql/i },
  { code: "UNSAFE_SQL", pattern: /not safe to plan/i },
  { code: "PLAN_TOO_LARGE", pattern: /exceeds the \d+ byte host limit|plan is too large/i },
  { code: "EMPTY_PLAN", pattern: /empty estimated plan/i },
  { code: "TIMEOUT", pattern: /timeout|timed out|deadline exceeded/i },
  { code: "INVALID_REQUEST", pattern: /valid connectionid|connectionid must|must be a string|must be an object/i },
]);

/**
 * Classify one host error message. Exported for tests: the mapping is the
 * contract, and it must not depend on a live host.
 *
 * @param {unknown} message
 * @returns {string} a code from HOST_PLAN_ERROR_CODES
 */
export function classifyHostMessage(message) {
  const text = typeof message === "string" ? message : String(message ?? "");
  for (const { code, pattern } of CLASSIFIERS) {
    if (pattern.test(text)) return code;
  }
  return "HOST_ERROR";
}

/**
 * Wrap any thrown value from the bridge into a HostPlanError.
 *
 * @param {unknown} error
 * @param {{ operation?: string }} [options]
 * @returns {HostPlanError}
 */
export function toHostPlanError(error, options = {}) {
  if (error instanceof HostPlanError) return error;

  const hostMessage = error instanceof Error ? error.message : String(error);
  const code = classifyHostMessage(hostMessage);
  const operation = options.operation === undefined ? "plan host call" : options.operation;
  return new HostPlanError(code, `${operation} failed: ${hostMessage}`, {
    hostMessage,
    cause: error,
  });
}
