/**
 * Pure view-model mapping for the DBX Host analysis mode.
 *
 * The components render these values verbatim. Nothing here calls the host,
 * parses a plan or recomputes analysis: the session already produced the
 * capabilities, the host result and the analysis, and this module only turns
 * them into display strings and stable copy.
 */

import { formatNumber } from "./format.js";

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
export function describeHostGate(api) {
  if (api?.state === "initializing") {
    return {
      state: "initializing",
      badgeLabel: "正在初始化 DBX Host 能力…",
      tone: "warning",
      message: "已发现 DBX 插件桥，正在等待宿主 init message 与 capabilities.planApi 声明；初始化完成前不会调用任何 Host Plan API。",
    };
  }

  if (api?.state === "available" && api?.available === true) {
    return { state: "available", badgeLabel: "DBX Host Mode · Estimated Plan", tone: "info", message: null };
  }

  return {
    state: "unavailable",
    badgeLabel: "Host API unavailable",
    tone: "warning",
    message: api?.reason ?? null,
  };
}

/**
 * Stable Chinese copy for every failure code the host boundary can produce.
 * The host message is always kept as a separate detail line; this table is the
 * part the plugin owns.
 *
 * @param {string} code
 * @returns {{ title: string, hint: string }}
 */
export function describeAnalysisError(code) {
  return ERROR_COPY[code] ?? ERROR_COPY.HOST_ERROR;
}

const ERROR_COPY = Object.freeze({
  PLAN_API_UNAVAILABLE: {
    title: "宿主 Plan API 不可用",
    hint: "当前 DBX 版本不提供 Estimated Plan Host API（需要 Host API 1.2 / t8y2/dbx#9692 及以上）。请升级 DBX 后重试。",
  },
  PERMISSION_NOT_DECLARED: {
    title: "缺少 host.plans:read 权限",
    hint: "插件 manifest 未声明 host.plans:read，宿主拒绝了两处计划调用。请更新插件到最新版本。",
  },
  CONNECTION_NOT_OPEN: {
    title: "连接未打开",
    hint: "DBX 不会代替插件建立连接。请先在 DBX 中打开该数据库连接，再执行 Analyze Plan。",
  },
  CONNECTION_NOT_FOUND: {
    title: "连接不存在",
    hint: "宿主找不到该 connectionId。请从已打开连接的查询结果页打开 Plan Detective，或核对 connectionId。",
  },
  UNSUPPORTED_DIALECT: {
    title: "该方言不支持 Estimated Plan",
    hint: "DBX 没有为该连接方言提供 Estimated Plan 路径。可改用支持的方向（PostgreSQL / MySQL / SQL Server / Oracle / Dameng / Doris / QuestDB / OceanBase Oracle）。",
  },
  UNSUPPORTED_MODE: {
    title: "不支持的计划模式",
    hint: "Host API 只服务 mode: \"estimated\"。Actual Plan / EXPLAIN ANALYZE 不在本插件范围内。",
  },
  EMPTY_SQL: {
    title: "SQL 为空",
    hint: "请输入要分析的 SQL 语句。",
  },
  SQL_TOO_LARGE: {
    title: "SQL 过大",
    hint: "宿主限制单条 SQL 最多 200,000 字符，请缩短后重试。",
  },
  UNSAFE_SQL: {
    title: "SQL 未通过宿主只读检查",
    hint: "DBX 会拒绝多语句、DDL、DML 与危险关键字。请提交单条只读查询。",
  },
  PLAN_TOO_LARGE: {
    title: "计划超出宿主大小上限",
    hint: "宿主限制计划载荷最大 4 MiB。请缩小查询范围（例如减少 UNION / CTE 分支）后重试。",
  },
  EMPTY_PLAN: {
    title: "数据库返回空计划",
    hint: "服务器没有返回可解析的计划内容。可尝试更换 SQL 或确认连接目标是否正确。",
  },
  TIMEOUT: {
    title: "计划获取超时",
    hint: "宿主在超时时间内没有返回计划。可降低查询复杂度，或在连接配置中调整 query timeout 后重试。",
  },
  INVALID_REQUEST: {
    title: "请求参数无效",
    hint: "插件构造的计划请求未通过宿主校验。请刷新插件后重试；若持续出现请提交 Issue。",
  },
  INVALID_RESPONSE: {
    title: "宿主返回了无法识别的响应",
    hint: "Plan API 响应结构不符合 Host API 1.2 契约，插件已拒绝解析以避免误导。",
  },
  UNSUPPORTED_DB_TYPE: {
    title: "未知的数据库类型",
    hint: "宿主返回了插件尚未映射的 dbType。请提交 Issue 并附上该 dbType。",
  },
  UNSUPPORTED_PLAN_FORMAT: {
    title: "未知的计划格式",
    hint: "宿主返回了 json / xml / text 之外的格式，插件无法展示。",
  },
  INVALID_DBX_PLAN_RESPONSE: {
    title: "宿主响应结构不完整",
    hint: "计划响应缺少契约字段或字段类型不符，插件已拒绝解析。",
  },
  PLAN_TRUNCATED: {
    title: "计划被截断",
    hint: "宿主返回的计划不完整，结构化解析会得出不可信的结论；此处仅展示 Raw Plan。",
  },
  INVALID_RAW_PLAN_INPUT: {
    title: "计划无法进入分析内核",
    hint: "适配后的 RawPlanInput 未通过内核校验。请提交 Issue。",
  },
  PLAN_PARSE_FAILED: {
    title: "计划解析失败",
    hint: "原始计划结构与声明不符。可展开 Raw Plan 核对，并提交 Issue 附上样例。",
  },
  HOST_ERROR: {
    title: "计划获取失败",
    hint: "宿主返回了未分类错误。详情见下方宿主消息；可重试或提交 Issue。",
  },
});

/**
 * Status banner copy for the non-error session states.
 *
 * @param {{ status: string, analysis?: { reason?: string | null } | null, capabilities?: { dbType?: string } | null }} session
 * @returns {{ tone: "info" | "warning" | "success", title: string, detail: string | null } | null}
 */
export function describeAnalysisNotice(session) {
  if (session === null || session === undefined) return null;

  switch (session.status) {
    case "loading":
      return { tone: "info", title: "正在通过 DBX Host API 获取 Estimated Plan…", detail: null };
    case "unsupported":
      return {
        tone: "warning",
        title: "该连接不支持 Estimated Plan",
        detail: session.message ?? null,
      };
    case "truncated":
      return { tone: "warning", title: "计划被截断，仅展示 Raw Plan", detail: session.message ?? null };
    case "raw-only":
      return {
        tone: "info",
        title: "已获取真实计划，但该方言的结构化解析尚未实现",
        detail: session.analysis?.reason ?? null,
      };
    case "structured":
      return { tone: "success", title: "已获取并解析 Estimated Plan", detail: null };
    default:
      return null;
  }
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
export function describePlanWarning(warning) {
  return PLAN_WARNING_COPY[warning] ?? warning;
}

const PLAN_WARNING_COPY = Object.freeze({
  plan_not_json: "服务器返回的内容不是 JSON，宿主已按 text 处理。",
  plan_truncated: "宿主为遵守 maxPlanBytes 截断了计划。",
  plan_rows_truncated: "驱动在收集计划行时达到行数上限。",
});

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {string | null} */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
