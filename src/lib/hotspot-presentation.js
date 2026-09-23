import { formatNumber, formatPercent } from "./format.js";
import { createTranslator, DEFAULT_LOCALE } from "./i18n/index.js";

/**
 * Hotspot presenters are deliberately outside Plan Core, exactly like
 * `finding-presentation.js`. They consume structured reason facts
 * (`reason.code` + `reason.evidence`) plus the node's relation / index context,
 * and select wording. They never parse the legacy English `reason.statement`,
 * never re-run a detection rule and never change a severity.
 *
 * A reason without a presenter degrades gracefully: the UI keeps rendering the
 * Core statement, code and source, and only the human-readable line is absent.
 * A new Core signal therefore never hides a hotspot from the user.
 */

/**
 * Human wording per reason code. Presenters receive the structured reason, the
 * node access context and the translator, and return `{ summary, caveat }`
 * (either may be `null`). Returning `null` means "no presenter output"; the
 * Core statement stays visible.
 */
const PRESENTERS = Object.freeze({
  "cost-concentration": presentPostgresCostConcentration,
  "large-sequential-scan": presentLargeSequentialScan,
  "nested-loop-amplification": presentNestedLoopAmplification,
  "mysql-rows-examined": presentMysqlRowsExamined,
  "mysql-filtered-out": presentMysqlFilteredOut,
  "mysql-cost-concentration": presentMysqlCostConcentration,
  "mysql-filesort": (reason, context, t) => presentMysqlOperationFlag(reason, context, t, "filesort"),
  "mysql-temporary-table": (reason, context, t) => presentMysqlOperationFlag(reason, context, t, "temporaryTable"),
  "mysql-join-buffer": (reason, context, t) => presentMysqlOperationFlag(reason, context, t, "joinBuffer"),
  "sqlserver-large-index-scan": presentSqlServerIndexScan,
  "sqlserver-sort": presentSqlServerSort,
});

/** `hotspots.cost.reason` -> message key. The UI never re-derives the reason. */
const COST_NOTE_KEYS = Object.freeze({
  NO_PLAN_COST: "hotspot.cost.NO_PLAN_COST",
  MISSING_NODE_COST: "hotspot.cost.MISSING_NODE_COST",
  PLAN_CONTAINS_SUBPLAN: "hotspot.cost.PLAN_CONTAINS_SUBPLAN",
  UNVERIFIED_COST_FLOW: "hotspot.cost.UNVERIFIED_COST_FLOW",
  NO_QUERY_COST: "hotspot.cost.NO_QUERY_COST",
  NOT_POSTGRES_COST_MODEL: "hotspot.cost.NOT_POSTGRES_COST_MODEL",
});

/**
 * `not-applicable` is shared by every engine that has no PostgreSQL cost model,
 * so the note names the engine's own estimate field. Keyed `<engine>:<reason>`;
 * engines without an entry use the shared reason copy.
 */
const ENGINE_COST_NOTE_KEYS = Object.freeze({
  "oceanbase-oracle:NOT_POSTGRES_COST_MODEL": "hotspot.cost.oceanbaseOracleCostModel",
  "oracle:NOT_POSTGRES_COST_MODEL": "hotspot.cost.oracleCostModel",
  "dameng:NOT_POSTGRES_COST_MODEL": "hotspot.cost.damengCostModel",
  "questdb:NOT_POSTGRES_COST_MODEL": "hotspot.cost.questdbCostModel",
  "doris:NOT_POSTGRES_COST_MODEL": "hotspot.cost.dorisCostModel",
});

/**
 * Present one whole Hotspot: every reason gets its own human line, and the
 * per-reason summaries are joined into one attention sentence.
 *
 * @param {{
 *   nodeType?: string, kind?: string, relation?: string|null,
 *   reasons?: Array<{ code?: string, evidence?: Record<string, unknown> }>,
 * }|null|undefined} hotspot
 * @param {unknown} [locale]
 * @param {{ relation?: string|null, alias?: string|null, indexName?: string|null, accessType?: string|null, nodeType?: string|null, kind?: string|null }|null} [nodeContext]
 * @returns {{
 *   structured: boolean,
 *   locale: "zh-CN"|"en",
 *   summary: string|null,
 *   reasons: Array<{ code: string|null, structured: boolean, summary: string|null, caveat: string|null }>,
 * }}
 */
export function presentHotspot(hotspot, locale = DEFAULT_LOCALE, nodeContext = null) {
  const translator = createTranslator(locale);
  const context = normalizeContext(hotspot, nodeContext);
  const reasons = (Array.isArray(hotspot?.reasons) ? hotspot.reasons : []).map((reason) =>
    presentReason(reason, context, translator.t),
  );
  const summary = joinSummaries(reasons);

  return {
    structured: reasons.some((reason) => reason.structured),
    locale: translator.locale,
    summary,
    reasons,
  };
}

/**
 * Present one Hotspot reason in isolation (used by the view model, which keeps
 * every original field next to the human line).
 *
 * @param {{ code?: string, evidence?: Record<string, unknown> }|null|undefined} reason
 * @param {unknown} [locale]
 * @param {{ relation?: string|null, alias?: string|null, indexName?: string|null, accessType?: string|null, nodeType?: string|null, kind?: string|null }|null} [nodeContext]
 * @returns {{ code: string|null, structured: boolean, summary: string|null, caveat: string|null, locale: "zh-CN"|"en" }}
 */
export function presentHotspotReason(reason, locale = DEFAULT_LOCALE, nodeContext = null) {
  const translator = createTranslator(locale);
  const context = normalizeContext(null, nodeContext);
  return { ...presentReason(reason, context, translator.t), locale: translator.locale };
}

/**
 * Human note for an unavailable cost attribution (`withheld` /
 * `not-applicable`). The Core owns the status and the reason code; this is
 * display copy only, and returns `null` when cost signals are available.
 *
 * @param {{ status: string, reason: string|null, engine?: string|null }|null|undefined} cost
 * @param {unknown} [locale]
 * @returns {string|null}
 */
export function presentHotspotCostNote(cost, locale = DEFAULT_LOCALE) {
  if (cost === null || cost === undefined) return null;
  const { t } = createTranslator(locale);
  const key = ENGINE_COST_NOTE_KEYS[`${cost.engine}:${cost.reason}`] ?? COST_NOTE_KEYS[cost.reason];

  if (cost.status === "not-applicable") {
    return t(key ?? "hotspot.cost.unknownNotApplicable");
  }
  if (cost.status !== "withheld") return null;
  return t(key ?? "hotspot.cost.unknownWithheld");
}

/* -------------------------------------------------------------- reasons -- */

/**
 * @param {{ code?: string, evidence?: Record<string, unknown> }|null|undefined} reason
 * @param {{ relation: string|null, alias: string|null, indexName: string|null, accessType: string|null, nodeType: string|null, kind: string|null }} context
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 */
function presentReason(reason, context, t) {
  const presenter = PRESENTERS[reason?.code];
  const presented = typeof presenter === "function" ? presenter(reason, context, t) : null;

  if (presented === null || presented === undefined || typeof presented.summary !== "string" || presented.summary.length === 0) {
    return { code: reason?.code ?? null, structured: false, summary: null, caveat: null };
  }

  return {
    code: reason.code,
    structured: true,
    summary: presented.summary,
    caveat: typeof presented.caveat === "string" && presented.caveat.length > 0 ? presented.caveat : null,
  };
}

/** @param {{ summary: string|null }[]} reasons */
function joinSummaries(reasons) {
  const parts = reasons.map((reason) => reason.summary).filter((summary) => typeof summary === "string" && summary.length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * PostgreSQL cost concentration: a node's own (incremental) cost share of the
 * root Total Cost. PostgreSQL cost units only — never reused for MySQL or
 * SQL Server.
 */
function presentPostgresCostConcentration(reason, context, t) {
  const share = formatPercent(reason?.evidence?.selfCostShare);
  if (share === null) return null;
  return { summary: t("hotspot.costConcentration.summary", { target: describeTarget(context, t), share }), caveat: null };
}

/**
 * Large sequential scan. The same reason code is emitted by several engines
 * with different native fields, so the source decides the wording; the
 * presenter never invents another engine's semantics.
 */
function presentLargeSequentialScan(reason, context, t) {
  const rows = formatNumber(reason?.evidence?.estimatedRows);
  if (rows === null) return null;

  const key =
    reason?.source === "table.rows_examined_per_scan"
      ? "hotspot.largeSeqScan.summary.mysql"
      : reason?.source === "RelOp@EstimateRows"
        ? "hotspot.largeSeqScan.summary.sqlserver"
        : reason?.source === "Rows"
          ? "hotspot.largeSeqScan.summary.oracle"
          : reason?.source === "[cost, rows, bytes-per-row]"
            ? "hotspot.largeSeqScan.summary.dameng"
            : "hotspot.largeSeqScan.summary.postgres";

  return {
    summary: t(key, { target: describeTarget(context, t), rows }),
    caveat: t("hotspot.largeSeqScan.caveat"),
  };
}

/** Nested-loop amplification: outer rows multiplied by inner rows. Engine-neutral. */
function presentNestedLoopAmplification(reason, context, t) {
  void context;
  const evidence = reason?.evidence ?? {};
  const outerRows = formatNumber(evidence.outerEstimatedRows);
  const innerRows = formatNumber(evidence.innerEstimatedRows);
  const comparisons = formatNumber(evidence.estimatedRowComparisons);
  if (outerRows === null || innerRows === null || comparisons === null) return null;

  return {
    summary: t("hotspot.nestedLoopAmplification.summary", { outerRows, innerRows, comparisons }),
    caveat: t("hotspot.nestedLoopAmplification.caveat"),
  };
}

/** MySQL index access that examines many rows without a full table scan. */
function presentMysqlRowsExamined(reason, context, t) {
  const rows = formatNumber(reason?.evidence?.rowsExaminedPerScan);
  if (rows === null) return null;

  return {
    summary: t("hotspot.mysqlRowsExamined.summary", {
      target: describeTarget(context, t),
      accessClause: describeAccessClause(reason, context, t),
      rows,
    }),
    caveat: t("hotspot.mysqlRowsExamined.caveat"),
  };
}

/** MySQL `filtered`: most examined rows are expected to be discarded. */
function presentMysqlFilteredOut(reason, context, t) {
  void context;
  const rows = formatNumber(reason?.evidence?.rowsExaminedPerScan);
  const filtered = formatNumber(reason?.evidence?.filteredPercent);
  if (rows === null || filtered === null) return null;

  return {
    summary: t("hotspot.mysqlFiltered.summary", { rows, filtered }),
    caveat: t("hotspot.mysqlFiltered.caveat"),
  };
}

/** MySQL query-block cost concentration. MySQL cost units only. */
function presentMysqlCostConcentration(reason, context, t) {
  const share = formatPercent(reason?.evidence?.costShare);
  if (share === null) return null;

  return {
    summary: t("hotspot.mysqlCostConcentration.summary", {
      target: describeTarget(context, t),
      accessClause: describeAccessClause(reason, context, t),
      share,
    }),
    caveat: null,
  };
}

/** MySQL operation flag (`using_filesort` / `using_temporary_table` / `using_join_buffer`). */
function presentMysqlOperationFlag(reason, context, t, flag) {
  void context;
  const rows = formatNumber(reason?.evidence?.subtreeMaxEstimatedRows);
  if (rows === null) return null;

  const messageKey = {
    filesort: "hotspot.mysqlFilesort",
    temporaryTable: "hotspot.mysqlTemporaryTable",
    joinBuffer: "hotspot.mysqlJoinBuffer",
  }[flag];
  if (messageKey === undefined) return null;

  if (flag === "joinBuffer") {
    const buffer = typeof reason?.evidence?.usingJoinBuffer === "string" ? reason.evidence.usingJoinBuffer : "?";
    return { summary: t(`${messageKey}.summary`, { buffer, rows }), caveat: t(`${messageKey}.caveat`) };
  }

  return { summary: t(`${messageKey}.summary`, { rows }), caveat: t(`${messageKey}.caveat`) };
}

/** SQL Server full index scan: a scan, never a seek and never a cost signal. */
function presentSqlServerIndexScan(reason, context, t) {
  const rows = formatNumber(reason?.evidence?.estimatedRows);
  if (rows === null) return null;
  const physicalOp = typeof reason?.evidence?.physicalOp === "string" ? reason.evidence.physicalOp : context.nodeType;

  return {
    summary: t("hotspot.sqlserverIndexScan.summary", { target: describeTarget(context, t), physicalOp: physicalOp ?? "scan", rows }),
    caveat: t("hotspot.sqlserverIndexScan.caveat"),
  };
}

/** SQL Server sort with a large estimated row count. */
function presentSqlServerSort(reason, context, t) {
  void context;
  const rows = formatNumber(reason?.evidence?.estimatedRows);
  if (rows === null) return null;

  return {
    summary: t("hotspot.sqlserverSort.summary", { rows }),
    caveat: t("hotspot.sqlserverSort.caveat"),
  };
}

/* -------------------------------------------------------------- helpers -- */

/**
 * @param {{ relation?: string|null, nodeType?: string|null, kind?: string|null }|null|undefined} hotspot
 * @param {{ relation?: string|null, alias?: string|null, indexName?: string|null, accessType?: string|null, nodeType?: string|null, kind?: string|null }|null|undefined} nodeContext
 */
function normalizeContext(hotspot, nodeContext) {
  const source = isPlainObject(nodeContext) ? nodeContext : {};
  return {
    relation: stringOrNull(source.relation) ?? stringOrNull(hotspot?.relation),
    alias: stringOrNull(source.alias),
    indexName: stringOrNull(source.indexName),
    accessType: stringOrNull(source.accessType),
    nodeType: stringOrNull(source.nodeType) ?? stringOrNull(hotspot?.nodeType),
    kind: stringOrNull(source.kind) ?? stringOrNull(hotspot?.kind),
  };
}

/**
 * Relation (or alias) the sentence is about. The display wrapper is added here
 * so the message catalog stays wording-only.
 *
 * @param {{ relation: string|null, alias: string|null }} context
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 */
function describeTarget(context, t) {
  const name = context.relation ?? context.alias;
  if (name === null) return t("hotspot.target.node");
  return `\`${name}\``;
}

/**
 * How the node reaches its rows, as a full clause that fits the MySQL
 * sentences: the index it uses when the plan reported one, otherwise the native
 * access type (a full table scan must never be described as index access).
 *
 * @param {{ evidence?: Record<string, unknown> }|null|undefined} reason
 * @param {{ indexName: string|null, accessType: string|null }} context
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 */
function describeAccessClause(reason, context, t) {
  if (context.indexName !== null) {
    return context.indexName === "PRIMARY"
      ? t("hotspot.access.primaryKey.clause", { index: context.indexName })
      : t("hotspot.access.index.clause", { index: context.indexName });
  }

  const accessType = context.accessType ?? (typeof reason?.evidence?.accessType === "string" ? reason.evidence.accessType : null);
  if (accessType === "ALL") return t("hotspot.access.fullTableScan.clause");
  if (accessType !== null && accessType.length > 0) return t("hotspot.access.accessType.clause", { accessType });
  return t("hotspot.access.generic.clause");
}

/** @param {unknown} value */
function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
