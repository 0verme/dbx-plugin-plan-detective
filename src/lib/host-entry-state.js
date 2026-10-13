/**
 * Entry-page states for the DBX Host view. Context presence, Host initialization,
 * API support and manual mode are deliberately kept distinct so an incomplete
 * context never collapses into the first-use empty state.
 */
export const HOST_ENTRY_STATES = Object.freeze({
  loading: "loading",
  unavailable: "unavailable",
  empty: "empty",
  manual: "manual",
  needsConnection: "needs-connection",
  needsSql: "needs-sql",
  ready: "ready",
});

/**
 * Resolve which Host-mode entry surface to show without changing input or
 * analysis state.
 *
 * @param {{
 *   contextReady?: boolean,
 *   planApiState?: string,
 *   planApiAvailable?: boolean,
 *   hasContext?: boolean,
 *   manualMode?: boolean,
 *   connectionId?: unknown,
 *   sql?: unknown,
 * }} [options]
 * @returns {string}
 */
export function describeHostEntryState({
  contextReady = false,
  planApiState = "unavailable",
  planApiAvailable = false,
  hasContext = false,
  manualMode = false,
  connectionId = null,
  sql = "",
} = {}) {
  if (contextReady !== true || planApiState === "initializing") return HOST_ENTRY_STATES.loading;
  if (planApiAvailable !== true) return HOST_ENTRY_STATES.unavailable;

  // Manual values are intentionally not treated as DBX-provided context. If
  // users return to the guide, those values remain in memory for later reuse.
  if (hasContext !== true && manualMode !== true) return HOST_ENTRY_STATES.empty;

  const hasConnection = typeof connectionId === "string" && connectionId.trim().length > 0;
  const hasSql = typeof sql === "string" && sql.trim().length > 0;

  if (!hasConnection && !hasSql && manualMode === true) return HOST_ENTRY_STATES.manual;
  if (!hasConnection) return HOST_ENTRY_STATES.needsConnection;
  if (!hasSql) return HOST_ENTRY_STATES.needsSql;
  return HOST_ENTRY_STATES.ready;
}
