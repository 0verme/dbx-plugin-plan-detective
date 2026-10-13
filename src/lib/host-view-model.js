/**
 * Pure view-model mapping for the DBX Host analysis mode.
 *
 * The components render these values verbatim. Nothing here calls the host,
 * parses a plan or recomputes analysis: the session already produced the
 * capabilities, the host result and the analysis, and this module only turns
 * them into display strings and stable copy.
 */

import { formatNumber } from "./format.js";
import { createTranslator, DEFAULT_LOCALE } from "./i18n/index.js";

/** Character budget for the inline Raw Plan preview; the payload itself is untouched. */
export const RAW_PLAN_PREVIEW_CHARS = 200_000;

/**
 * Describe the DBX workbench context the plugin was opened with.
 *
 * A `result-view` open carries `connectionId`, `database` and `sql`; a
 * standalone workbench opened from the sidebar carries none of them. The UI
 * must not invent a connection, so "no context" is an explicit state.
 *
 * @param {Record<string, unknown> | null | undefined} context
 * @returns {{
 *   connectionId: string | null, database: string | null, schema: string | null,
 *   contextSql: string | null, hasConnection: boolean,
 *   source: "result-view" | "workbench" | "none",
 * }}
 */
export function describeConnectionContext(context) {
  const record = isPlainObject(context) ? context : {};
  const connectionId = nonEmptyString(record.connectionId);
  const database = nonEmptyString(record.database);
  const schema = nonEmptyString(record.schema);
  const contextSql = nonEmptyString(record.sql);
  const hasResultSnapshot = isPlainObject(record.result);

  let source = "none";
  if (connectionId !== null) source = hasResultSnapshot || contextSql !== null ? "result-view" : "workbench";

  return { connectionId, database, schema, contextSql, hasConnection: connectionId !== null, source };
}

/**
 * Turn `PluginPlanCapabilities` into display rows. The values come straight
 * from the host; the UI does not reinterpret "supported".
 *
 * @param {{ dbType: string, dbVersion?: string, supports: { estimatedPlan: boolean }, limits: { maxTimeoutMs: number, maxPlanBytes: number } } | null | undefined} capabilities
 */
export function describeCapabilities(capabilities) {
  if (capabilities === null || capabilities === undefined) return null;
  return {
    dbType: capabilities.dbType,
    dbVersion: capabilities.dbVersion ?? null,
    estimatedPlan: capabilities.supports.estimatedPlan === true,
    maxTimeoutMs: formatNumber(capabilities.limits.maxTimeoutMs),
    maxPlanBytes: formatBytes(capabilities.limits.maxPlanBytes),
    maxPlanBytesRaw: capabilities.limits.maxPlanBytes,
  };
}

/**
 * Map the runtime host gate (`describePlanApi`) onto the copy the Host view
 * shows. `initializing` is a first-class state: the bridge exists, but the host
 * init message has not arrived, so the UI must neither call the Plan API nor
 * claim it is unavailable.
 *
 * @param {{ state?: string, available?: boolean, reason?: string | null } | null | undefined} api
 * @returns {{
 *   state: "initializing" | "available" | "unavailable",
 *   badgeLabel: string,
 *   tone: "info" | "warning",
 *   message: string | null,
 * }}
 */
export function describeHostGate(api, locale = DEFAULT_LOCALE) {
  const { t } = createTranslator(locale);
  if (api?.state === "initializing") {
    return {
      state: "initializing",
      badgeLabel: t("host.gate.initializing"),
      tone: "warning",
      message: t("app.host.initializingHint"),
    };
  }

  if (api?.state === "available" && api?.available === true) {
    return { state: "available", badgeLabel: t("host.gate.available"), tone: "info", message: null };
  }

  let message = api?.reason ?? null;
  if (api?.advertised === true && Array.isArray(api?.missing) && api.missing.length > 0) {
    message = t("host.gate.missingMethods", { methods: api.missing.join(", ") });
  } else if (typeof api?.reason === "string" && api.reason.includes("window.dbxPlugin")) {
    message = t("host.gate.noBridge");
  } else if (api?.advertised === false && typeof api?.reason === "string" && api.reason.includes("capabilities.planApi")) {
    message = t("host.gate.notDeclared");
  }

  return {
    state: "unavailable",
    badgeLabel: t("host.gate.unavailable"),
    tone: "warning",
    message,
  };
}

/**
 * Localized plugin-owned copy for every failure code the host boundary can
 * produce. The original Host message stays separate and is never rewritten.
 *
 * @param {string} code
 * @returns {{ title: string, hint: string }}
 */
export function describeAnalysisError(code, locale = DEFAULT_LOCALE) {
  const { t } = createTranslator(locale);
  const key = ERROR_CODES.has(code) ? code : "HOST_ERROR";
  return { title: t(`error.${key}.title`), hint: t(`error.${key}.hint`) };
}

const ERROR_CODES = new Set([
  "PLAN_API_UNAVAILABLE", "PERMISSION_NOT_DECLARED", "CONNECTION_NOT_OPEN", "CONNECTION_NOT_FOUND",
  "UNSUPPORTED_DIALECT", "UNSUPPORTED_MODE", "EMPTY_SQL", "SQL_TOO_LARGE", "UNSAFE_SQL", "PLAN_TOO_LARGE",
  "EMPTY_PLAN", "TIMEOUT", "INVALID_REQUEST", "INVALID_RESPONSE", "UNSUPPORTED_DB_TYPE",
  "UNSUPPORTED_PLAN_FORMAT", "INVALID_DBX_PLAN_RESPONSE", "PLAN_TRUNCATED", "INVALID_RAW_PLAN_INPUT",
  "PLAN_PARSE_FAILED", "HOST_ERROR",
]);

/**
 * Status banner copy for the non-error session states.
 *
 * @param {{ status: string, analysis?: { reason?: string | null } | null, capabilities?: { dbType?: string } | null }} session
 * @returns {{ tone: "info" | "warning" | "success", title: string, detail: string | null } | null}
 */
export function describeAnalysisNotice(session, locale = DEFAULT_LOCALE) {
  if (session === null || session === undefined) return null;
  const { t } = createTranslator(locale);

  switch (session.status) {
    case "loading":
      return { tone: "info", title: t("analysis.notice.loading"), detail: null };
    case "unsupported":
      return {
        tone: "warning",
        title: t("analysis.notice.unsupported"),
        detail: session.capabilities?.dbType ? t("analysis.notice.unsupportedDetail", { database: session.capabilities.dbType }) : session.message ?? null,
      };
    case "truncated":
      return { tone: "warning", title: t("analysis.notice.truncated"), detail: t("analysis.notice.truncatedDetail") };
    case "raw-only": {
      const analysis = session.analysis;
      const reasonKey = analysis?.reasonCode === "UNSUPPORTED_FORMAT"
        ? "analysis.rawOnly.unsupportedFormat"
        : analysis?.reasonCode === "UNKNOWN_DATABASE"
          ? "analysis.rawOnly.unknownDatabase"
          : analysis?.reasonCode
            ? "analysis.rawOnly.noParser"
            : null;
      const detail = reasonKey
        ? t(reasonKey, { database: session.rawInput?.database ?? "unknown", format: session.rawInput?.format ?? "unknown" })
        : analysis?.reason ?? null;
      return { tone: "info", title: t("analysis.notice.rawOnly"), detail };
    }
    case "structured":
      return { tone: "success", title: t("analysis.notice.structured"), detail: null };
    default:
      return null;
  }
}

/**
 * Copy-action states the AnalysisNotice button can render.
 *
 *   idle    - the button is ready to copy the local AI prompt
 *   copying - the host / clipboard call is in flight; the button is disabled
 *   copied  - success feedback is shown next to the button
 *   failed  - both channels failed; the user must see an explicit error
 */
export const COPY_PROMPT_STATES = Object.freeze({
  idle: "idle",
  copying: "copying",
  copied: "copied",
  failed: "failed",
});

/**
 * Map the copy-action state onto the labels AnalysisNotice renders. The copy
 * feedback is localized through the shared catalog; the component stays dumb.
 *
 * @param {string} state one of COPY_PROMPT_STATES
 * @param {unknown} [locale]
 * @returns {{ label: string, feedback: string|null, tone: "success"|"error", disabled: boolean }}
 */
export function describeCopyPromptAction(state, locale = DEFAULT_LOCALE) {
  const { t } = createTranslator(locale);
  return {
    label: state === COPY_PROMPT_STATES.copying ? t("copy.copying") : t("copy.button"),
    feedback:
      state === COPY_PROMPT_STATES.copied
        ? t("copy.success")
        : state === COPY_PROMPT_STATES.failed
          ? t("copy.failure")
          : null,
    tone: state === COPY_PROMPT_STATES.failed ? "error" : "success",
    disabled: state === COPY_PROMPT_STATES.copying,
  };
}

/**
 * Format the Raw Plan for the viewer without modifying it.
 *
 * JSON documents are pretty-printed for readability; text and XML stay exactly
 * as the host returned them. A display-only preview cap keeps a 4 MiB payload
 * from freezing the DOM; `truncatedForDisplay` says so explicitly.
 *
 * @param {{ format: string, rawPlan: unknown } | null | undefined} hostResult
 * @param {{ maxChars?: number }} [options]
 * @returns {{ text: string, truncatedForDisplay: boolean, totalChars: number } | null}
 */
export function formatRawPlan(hostResult, options = {}) {
  if (hostResult === null || hostResult === undefined) return null;
  const maxChars = options.maxChars ?? RAW_PLAN_PREVIEW_CHARS;

  let text;
  if (hostResult.format === "json") {
    try {
      text = JSON.stringify(hostResult.rawPlan, null, 2);
    } catch {
      text = String(hostResult.rawPlan);
    }
  } else {
    text = typeof hostResult.rawPlan === "string" ? hostResult.rawPlan : String(hostResult.rawPlan);
  }

  const truncatedForDisplay = text.length > maxChars;
  return {
    text: truncatedForDisplay ? text.slice(0, maxChars) : text,
    truncatedForDisplay,
    totalChars: text.length,
  };
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Human labels for host warning codes.
 *
 * @param {string} warning
 * @returns {string}
 */
export function describePlanWarning(warning, locale = DEFAULT_LOCALE) {
  const { t } = createTranslator(locale);
  return PLAN_WARNING_CODES.has(warning) ? t(`host.warning.${warning}`) : warning;
}

const PLAN_WARNING_CODES = new Set(["plan_not_json", "plan_truncated", "plan_rows_truncated"]);

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {string | null} */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
