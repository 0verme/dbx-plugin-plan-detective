import { formatNumber } from "./format.js";
import { createTranslator, DEFAULT_LOCALE } from "./i18n/index.js";

/**
 * Presenters are deliberately outside Plan Core. They consume structured rule
 * facts and select wording; they never parse legacy English copy or rerun a
 * detection threshold.
 */
const PRESENTERS = Object.freeze({
  "large-sequential-scan": presentLargeSequentialScan,
});

/**
 * Convert one Finding into localized, progressively-disclosed explanation.
 * Findings without a migrated presenter use their legacy title / summary.
 *
 * @param {import("../core/findings/finding.js").Finding|Record<string, unknown>} finding
 * @param {unknown} locale
 * @returns {{
 *   structured: boolean,
 *   locale: "zh-CN"|"en",
 *   title: string,
 *   summary: string,
 *   reasons: string[],
 *   actions: string[],
 *   caveats: string[],
 *   labels: { summary: string, reasons: string, actions: string, caveats: string, technicalDetails: string },
 * }}
 */
export function presentFinding(finding, locale = DEFAULT_LOCALE) {
  const translator = createTranslator(locale);
  const labels = sectionLabels(translator.t);
  const presenter = PRESENTERS[finding?.ruleId];

  if (typeof presenter !== "function" || !isPlainObject(finding?.facts)) {
    return legacyPresentation(finding, translator.locale, labels);
  }

  return {
    structured: true,
    locale: translator.locale,
    labels,
    ...presenter(finding, translator.t, translator.locale),
  };
}

/**
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 */
function sectionLabels(t) {
  return {
    summary: t("diagnosis.section.summary"),
    reasons: t("diagnosis.section.reasons"),
    actions: t("diagnosis.section.actions"),
    caveats: t("diagnosis.section.caveats"),
    technicalDetails: t("diagnosis.section.technicalDetails"),
  };
}

/**
 * @param {Record<string, unknown>|undefined|null} finding
 * @param {"zh-CN"|"en"} locale
 * @param {{ summary: string, reasons: string, actions: string, caveats: string, technicalDetails: string }} labels
 */
function legacyPresentation(finding, locale, labels) {
  return {
    structured: false,
    locale,
    title: typeof finding?.title === "string" && finding.title.length > 0 ? finding.title : "Finding",
    summary: typeof finding?.summary === "string" ? finding.summary : "",
    reasons: [],
    actions: [],
    caveats: [],
    labels,
  };
}

/**
 * First Golden Sample: the large-sequential-scan rule exposes facts from both
 * PostgreSQL Seq Scan and MySQL access_type = ALL without changing detection.
 *
 * @param {{ severity: string, facts: Record<string, unknown> }} finding
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 * @param {"zh-CN"|"en"} locale
 */
function presentLargeSequentialScan(finding, t, locale) {
  const facts = finding.facts;
  const relation = displayText(facts.relation, locale === "en" ? "this node" : "该节点");
  const estimatedRows = displayNumber(facts.estimatedRows, locale);
  const nodeType = displayText(facts.nodeType, locale === "en" ? "sequential scan" : "顺序扫描");
  const accessType = displayText(facts.accessType, "");
  const reasons = [];

  if (facts.database === "mysql" && accessType === "ALL") {
    reasons.push(t("finding.largeSequentialScan.reason.accessType", { accessType }));
  } else {
    reasons.push(t("finding.largeSequentialScan.reason.scan", { nodeType }));
  }

  if (facts.hasFilter === false) {
    reasons.push(t("finding.largeSequentialScan.reason.noFilter"));
  } else if (facts.hasFilter === true) {
    reasons.push(t("finding.largeSequentialScan.reason.filterReported"));
  }

  if (typeof facts.estimatedRows === "number" && Number.isFinite(facts.estimatedRows)) {
    reasons.push(t("finding.largeSequentialScan.reason.estimatedRows", { estimatedRows }));
  }

  const caveats = [];
  if (facts.runtimeVerified !== true) {
    caveats.push(t("finding.caveat.estimatedPlan"));
  }
  caveats.push(t("finding.caveat.severity", { severity: finding.severity }));

  const isFullTableScan = facts.database === "mysql" && accessType === "ALL";

  return {
    title: t(`finding.largeSequentialScan.title.${isFullTableScan ? "fullTable" : "sequential"}`),
    summary: t("finding.largeSequentialScan.summary", { relation, estimatedRows }),
    reasons,
    actions: [
      t("finding.largeSequentialScan.action.where"),
      t("finding.largeSequentialScan.action.index"),
      t("finding.largeSequentialScan.action.intent"),
    ],
    caveats,
  };
}

/** @param {unknown} value @param {"zh-CN"|"en"} locale */
function displayNumber(value, locale) {
  return formatNumber(value, locale === "en" ? "en-US" : locale) ?? (locale === "en" ? "an unknown number of" : "未知");
}

/** @param {unknown} value @param {string} fallback */
function displayText(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
