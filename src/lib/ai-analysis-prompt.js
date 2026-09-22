import { flattenNodes } from "../core/tree.js";
import { presentFinding } from "./finding-presentation.js";
import { presentHotspot, presentHotspotCostNote } from "./hotspot-presentation.js";
import { createTranslator, DEFAULT_LOCALE } from "./i18n/index.js";
import { formatNumber, formatPercent } from "./format.js";
import { flattenEvidence } from "./view-model.js";

/**
 * Local AI analysis prompt builder.
 *
 * This module is a pure string generator: no network, no clipboard, no DOM, no
 * clock. It packages the analysis context Plan Detective already produced
 * (database context, SQL, metrics, Findings, Hotspots, evidence) for a user who
 * wants to paste it into an external AI tool. Plan Detective itself never calls
 * an AI service.
 *
 * Every section only prints values that exist. A missing metric is omitted as a
 * whole line instead of leaking `undefined` / `null` noise, and the evidence
 * section is bounded and explicitly marks truncation.
 */

/** Evidence character budget: a few thousand characters, never a raw plan dump. */
export const DEFAULT_EVIDENCE_BUDGET_CHARS = 6000;

/** Plan Summary rows, aligned with the metrics the core actually publishes. */
const SUMMARY_METRIC_ROWS = Object.freeze([
  { label: "Total Estimated Cost", value: (metrics, fmt) => fmt(metrics.totalEstimatedCost) },
  { label: "Root Estimated Rows", value: (metrics, fmt) => fmt(metrics.rootEstimatedRows) },
  { label: "Node Count", value: (metrics, fmt) => fmt(metrics.nodeCount) },
  { label: "Max Depth", value: (metrics, fmt) => fmt(metrics.maxDepth) },
  { label: "Scan Count", value: (metrics, fmt) => fmt(metrics.scanCount) },
  { label: "Sequential Scan Count", value: (metrics, fmt) => fmt(metrics.sequentialScanCount) },
  { label: "Index Scan Count", value: (metrics, fmt) => fmt(metrics.indexScanCount) },
  { label: "Join Count", value: (metrics, fmt) => fmt(metrics.joinCount) },
  { label: "Sort Count", value: (metrics, fmt) => fmt(metrics.sortCount) },
  { label: "Aggregate Count", value: (metrics, fmt) => fmt(metrics.aggregateCount) },
  { label: "Largest Estimated Rows", value: (metrics, fmt) => formatLargestEstimatedRows(metrics.largestEstimatedRows, fmt) },
]);

/**
 * Build the complete prompt for the current structured analysis.
 *
 * @param {{
 *   rawInput?: import("../core/raw-plan-input.js").RawPlanInput|null,
 *   analysis?: {
 *     metrics?: object|null, findings?: Array<object>|null,
 *     hotspots?: { cost?: { status?: string, engine?: string, reason?: string|null }|null, items?: Array<object>|null }|null,
 *     normalized?: { root?: object }|null,
 *   }|null,
 *   locale?: unknown,
 *   databaseType?: string|null,
 *   maxEvidenceChars?: number,
 * }} [context]
 * @returns {string}
 */
export function buildAiAnalysisPrompt(context = {}) {
  const rawInput = isPlainObject(context?.rawInput) ? context.rawInput : null;
  const analysis = isPlainObject(context?.analysis) ? context.analysis : null;
  const maxEvidenceChars = resolveBudget(context?.maxEvidenceChars);
  const translator = createTranslator(context?.locale ?? DEFAULT_LOCALE);
  const locale = translator.locale;
  const t = translator.t;
  const numberLocale = locale === "en" ? "en-US" : locale;
  const fmt = (value) => formatNumber(value, numberLocale);

  const lines = ["# DBX Plan Detective · AI analysis context", "", t("aiPrompt.intro"), ""];

  lines.push("## Analysis constraints", ...bulletLines(constraintLines(rawInput, t)), "");

  const databaseLines = databaseContextLines(rawInput, context?.databaseType);
  if (databaseLines.length > 0) {
    lines.push("## Database Context", ...databaseLines, "");
  }

  lines.push("## SQL");
  const sql = typeof rawInput?.sql === "string" ? rawInput.sql.trim() : "";
  if (sql.length === 0) {
    lines.push(t("aiPrompt.sql.missing"));
  } else {
    lines.push("```sql", sql, "```");
  }
  lines.push("");

  const summaryLines = planSummaryLines(analysis?.metrics, fmt);
  if (summaryLines.length > 0) {
    lines.push("## Plan Summary", ...summaryLines, "");
  }

  lines.push("## Findings", ...findingsLines(analysis, locale, t), "");
  lines.push("## Hotspots", ...hotspotLines(analysis, locale, t), "");
  lines.push("## Evidence", ...evidenceLines(analysis, maxEvidenceChars, t), "");

  lines.push(`## ${t("aiPrompt.answer.title")}`, ...answerStructureLines(t));

  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------ constraints -- */

/**
 * The fixed semantic constraints every external AI must read before the data.
 * Wording lives in the catalog; the selection is decided here.
 *
 * @param {{ mode?: string }|null} rawInput
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 */
function constraintLines(rawInput, t) {
  const modeLine =
    rawInput?.mode === "estimated"
      ? t("aiPrompt.constraints.estimated")
      : rawInput?.mode === "actual"
        ? t("aiPrompt.constraints.actual")
        : t("aiPrompt.constraints.modeUnknown");

  return [
    modeLine,
    t("aiPrompt.constraints.costNotTime"),
    t("aiPrompt.constraints.costNotProblem"),
    t("aiPrompt.constraints.rowsEstimated"),
    t("aiPrompt.constraints.factInferenceSuggestion"),
    t("aiPrompt.constraints.verifyFirst"),
    t("aiPrompt.constraints.noIndexAdviceWithoutEvidence"),
    t("aiPrompt.constraints.noFindingCaveat"),
    t("aiPrompt.constraints.costNotComparable"),
  ];
}

/* ------------------------------------------------------- database context -- */

/**
 * @param {import("../core/raw-plan-input.js").RawPlanInput|null} rawInput
 * @param {unknown} databaseType host `dbType`, kept as the raw value when present
 */
function databaseContextLines(rawInput, databaseType) {
  const lines = [];
  const type = nonEmptyString(databaseType) ?? nonEmptyString(rawInput?.database);
  pushLine(lines, "Database Type", type);
  pushLine(lines, "Database Version", nonEmptyString(rawInput?.databaseVersion));
  if (rawInput?.mode === "estimated") pushLine(lines, "Plan Mode", "Estimated Plan");
  else if (rawInput?.mode === "actual") pushLine(lines, "Plan Mode", "Actual Plan");
  return lines;
}

/* ------------------------------------------------------------ plan summary -- */

/**
 * @param {object|null|undefined} metrics
 * @param {(value: unknown) => string|null} fmt
 */
function planSummaryLines(metrics, fmt) {
  if (!isPlainObject(metrics)) return [];
  const lines = [];
  for (const row of SUMMARY_METRIC_ROWS) {
    pushLine(lines, row.label, row.value(metrics, fmt));
  }
  return lines;
}

/**
 * @param {object|null|undefined} summary `metrics.largestEstimatedRows`
 * @param {(value: unknown) => string|null} fmt
 */
function formatLargestEstimatedRows(summary, fmt) {
  if (!isPlainObject(summary)) return null;
  const rows = fmt(summary.estimatedRows);
  if (rows === null) return null;
  const node = [nonEmptyString(summary.nodeId) === null ? null : `node ${summary.nodeId}`, nonEmptyString(summary.nodeType), nonEmptyString(summary.relation)]
    .filter((part) => part !== null)
    .join(" · ");
  return node.length === 0 ? rows : `${rows} (${node})`;
}

/* ---------------------------------------------------------------- findings -- */

/**
 * @param {object|null} analysis
 * @param {"zh-CN"|"en"} locale
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 */
function findingsLines(analysis, locale, t) {
  const findings = Array.isArray(analysis?.findings) ? analysis.findings : [];
  if (findings.length === 0) {
    return [t("aiPrompt.findings.none"), t("aiPrompt.findings.noneCaveat")];
  }

  const lines = [];
  for (const finding of findings) {
    const presentation = presentFinding(finding, locale);
    const severity = nonEmptyString(finding?.severity);
    const ruleId = nonEmptyString(finding?.ruleId);
    const nodeRef = nonEmptyString(finding?.nodeRef);
    lines.push(`### [${severity ?? "unknown"}] ${ruleId ?? "unknown-rule"}${nodeRef === null ? "" : ` · node ${nodeRef}`}`);
    pushLine(lines, "- Title", presentation.title);
    pushLine(lines, "- Summary", presentation.summary);
  }
  return lines;
}

/* ---------------------------------------------------------------- hotspots -- */

/**
 * @param {object|null} analysis
 * @param {"zh-CN"|"en"} locale
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 */
function hotspotLines(analysis, locale, t) {
  const hotspots = Array.isArray(analysis?.hotspots?.items) ? analysis.hotspots.items : [];
  const cost = isPlainObject(analysis?.hotspots?.cost) ? analysis.hotspots.cost : null;
  const costNote = presentHotspotCostNote(cost, locale);

  if (hotspots.length === 0) {
    const lines = [t("aiPrompt.hotspots.none"), t("aiPrompt.hotspots.noneCaveat")];
    if (costNote !== null) pushLine(lines, `- ${t("aiPrompt.hotspots.costNoteLabel")}`, costNote);
    return lines;
  }

  const nodesById = indexNodes(analysis?.normalized?.root);
  const numberLocale = locale === "en" ? "en-US" : locale;
  const lines = [];
  if (costNote !== null) pushLine(lines, `- ${t("aiPrompt.hotspots.costNoteLabel")}`, costNote);

  hotspots.forEach((hotspot, index) => {
    const nodeContext = nodeContextFor(hotspot, nodesById);
    const presentation = presentHotspot(hotspot, locale, nodeContext);
    lines.push(hotspotHeading(hotspot, nodeContext, index + 1));
    pushLine(lines, "- Node Type", nonEmptyString(hotspot?.nodeType) ?? nodeContext.nodeType);
    pushLine(lines, "- Relation", nodeContext.relation);
    pushLine(lines, "- Alias", nodeContext.alias !== nodeContext.relation ? nodeContext.alias : null);
    pushLine(lines, "- Index", nodeContext.indexName);
    pushLine(lines, "- Estimated Rows", formatNumber(hotspotEstimatedRows(hotspot, nodesById), numberLocale));
    lines.push(...hotspotCostLines(hotspot, cost, numberLocale));
    lines.push(...hotspotReasonLines(hotspot, presentation));
  });

  return lines;
}

/**
 * Engine-scoped cost lines. Only `status: "available"` publishes a cost, and
 * the labels stay inside one engine's cost model: PostgreSQL self cost and
 * MySQL access cost are never mixed, and SQL Server publishes no attributable
 * cost at all.
 *
 * @param {object} hotspot
 * @param {{ status?: string, engine?: string }|null} cost
 * @param {string} numberLocale
 */
function hotspotCostLines(hotspot, cost, numberLocale) {
  if (cost?.status !== "available") return [];
  const evidence = isPlainObject(hotspot?.evidence) ? hotspot.evidence : {};

  if (cost.engine === "postgresql") {
    return compactLines([
      ["- Estimated Self Cost", formatCost(evidence.selfCost, "PostgreSQL cost units", numberLocale)],
      ["- Self Cost Share", formatPercent(evidence.selfCostShare)],
    ]);
  }
  if (cost.engine === "mysql") {
    return compactLines([
      ["- Estimated Access Cost", formatCost(evidence.accessCost, "read_cost + eval_cost", numberLocale)],
      ["- Query Block Cost Share", formatPercent(evidence.costShare)],
    ]);
  }
  return [];
}

/**
 * @param {object} hotspot
 * @param {{ reasons: Array<{ summary: string|null, caveat: string|null }> }} presentation
 */
function hotspotReasonLines(hotspot, presentation) {
  const reasons = Array.isArray(hotspot?.reasons) ? hotspot.reasons : [];
  const lines = [];

  reasons.forEach((reason, index) => {
    const presented = presentation.reasons[index] ?? { summary: null, caveat: null };
    const level = nonEmptyString(reason?.level) ?? "info";
    const code = nonEmptyString(reason?.code) ?? "unknown";
    const source = nonEmptyString(reason?.source);
    lines.push(`- Reason [${level}] ${code}${source === null ? "" : ` (source: ${source})`}`);
    pushLine(lines, "  - Human", presented.summary);
    pushLine(lines, "  - Statement", nonEmptyString(reason?.statement));
    pushLine(lines, "  - Caveat", presented.caveat);
  });

  return lines;
}

/** @param {object} hotspot @param {Map<string, object>} nodesById */
function hotspotEstimatedRows(hotspot, nodesById) {
  const evidence = isPlainObject(hotspot?.evidence) ? hotspot.evidence : {};
  if (typeof evidence.estimatedRows === "number") return evidence.estimatedRows;
  const node = nodesById.get(hotspot?.nodeId);
  return typeof node?.estimatedRows === "number" ? node.estimatedRows : null;
}

/* ---------------------------------------------------------------- evidence -- */

/**
 * Evidence is a bounded selection, ordered by attention: high hotspots, then
 * warning hotspots, then Findings, then everything else. Ordering is stable
 * (core order inside each group), and truncation is always explicit.
 *
 * @param {object|null} analysis
 * @param {number} budget
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 */
function evidenceLines(analysis, budget, t) {
  const blocks = collectEvidenceBlocks(analysis);
  const lines = [t("aiPrompt.evidence.notice")];

  if (blocks.length === 0) {
    lines.push(t("aiPrompt.evidence.none"));
    return lines;
  }

  let used = 0;
  let truncated = false;
  let included = 0;

  for (const block of blocks) {
    if (truncated) break;
    let headerEmitted = false;
    for (const row of block.rows) {
      const line = `- ${row.path}: ${row.value}`;
      const cost = line.length + 1;
      if (used + cost > budget) {
        truncated = true;
        break;
      }
      if (!headerEmitted) {
        const header = `### ${block.title}`;
        lines.push(header);
        used += header.length + 1;
        headerEmitted = true;
      }
      lines.push(line);
      used += cost;
      included += 1;
    }
  }

  if (included === 0) {
    // Blocks exist but even the first line did not fit; say that explicitly
    // instead of claiming there is no evidence.
    lines.push(t("aiPrompt.evidence.truncated"));
    return lines;
  }
  if (truncated) lines.push(t("aiPrompt.evidence.truncated"));

  return lines;
}

/**
 * @param {object|null} analysis
 * @returns {Array<{ title: string, rows: Array<{ path: string, value: string }> }>}
 */
function collectEvidenceBlocks(analysis) {
  const hotspots = Array.isArray(analysis?.hotspots?.items) ? analysis.hotspots.items : [];
  const findings = Array.isArray(analysis?.findings) ? analysis.findings : [];
  const byLevel = { high: [], warning: [], info: [] };
  for (const hotspot of hotspots) {
    (byLevel[hotspot?.level] ?? byLevel.info).push(hotspot);
  }

  const blocks = [];
  for (const level of ["high", "warning"]) {
    for (const hotspot of byLevel[level]) blocks.push(hotspotEvidenceBlock(hotspot));
  }
  for (const finding of findings) blocks.push(findingEvidenceBlock(finding));
  for (const hotspot of byLevel.info) blocks.push(hotspotEvidenceBlock(hotspot));

  return blocks.filter((block) => block.rows.length > 0);
}

/** @param {object} hotspot */
function hotspotEvidenceBlock(hotspot) {
  return {
    title: `Hotspot ${nonEmptyString(hotspot?.nodeId) ?? "?"} [${nonEmptyString(hotspot?.level) ?? "info"}]`,
    rows: flattenEvidence(isPlainObject(hotspot?.evidence) ? hotspot.evidence : {}),
  };
}

/** @param {object} finding */
function findingEvidenceBlock(finding) {
  return {
    title: `Finding ${nonEmptyString(finding?.ruleId) ?? "unknown-rule"} · node ${nonEmptyString(finding?.nodeRef) ?? "?"}`,
    rows: flattenEvidence(isPlainObject(finding?.evidence) ? finding.evidence : {}),
  };
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * @param {(key: string, params?: Record<string, unknown>) => string} t
 */
function answerStructureLines(t) {
  return [t("aiPrompt.answer.step1"), t("aiPrompt.answer.step2"), t("aiPrompt.answer.step3"), t("aiPrompt.answer.step4"), t("aiPrompt.answer.step5")];
}

/** @param {object|null|undefined} root */
function indexNodes(root) {
  const map = new Map();
  if (root === null || root === undefined) return map;
  for (const node of flattenNodes(root)) map.set(node.id, node);
  return map;
}

/**
 * @param {object} hotspot
 * @param {Map<string, object>} nodesById
 */
function nodeContextFor(hotspot, nodesById) {
  const node = nodesById.get(hotspot?.nodeId) ?? null;
  return {
    relation: nonEmptyString(node?.relation?.name) ?? nonEmptyString(hotspot?.relation),
    alias: nonEmptyString(node?.relation?.alias),
    indexName: nonEmptyString(node?.relation?.indexName),
    accessType: nonEmptyString(node?.engineSpecific?.mysql?.accessType) ?? nonEmptyString(hotspot?.evidence?.accessType),
    nodeType: nonEmptyString(node?.nodeType) ?? nonEmptyString(hotspot?.nodeType),
    kind: nonEmptyString(node?.kind) ?? nonEmptyString(hotspot?.kind),
  };
}

/** @param {object} hotspot @param {{ nodeType: string|null, relation: string|null, alias: string|null, indexName: string|null }} context */
function hotspotHeading(hotspot, context, rank) {
  const parts = [context.nodeType ?? nonEmptyString(hotspot?.nodeType) ?? "node"];
  if (context.relation !== null) parts.push(context.relation);
  if (context.alias !== null && context.alias !== context.relation) parts.push(`[${context.alias}]`);
  if (context.indexName !== null) parts.push(`via ${context.indexName}`);
  return `### #${rank} [${nonEmptyString(hotspot?.level) ?? "info"}] ${parts.join(" · ")} (node ${nonEmptyString(hotspot?.nodeId) ?? "?"})`;
}

/** @param {Array<[string, string|null]>} entries */
function compactLines(entries) {
  const lines = [];
  for (const [label, value] of entries) pushLine(lines, label, value);
  return lines;
}

/**
 * Append one `Label: value` line, skipping missing values. This is the single
 * gate that keeps `undefined` / `null` / empty values out of the prompt.
 *
 * @param {string[]} lines
 * @param {string} label
 * @param {unknown} value
 */
function pushLine(lines, label, value) {
  const text = typeof value === "string" ? value.trim() : null;
  if (text === null || text.length === 0) return;
  lines.push(`${label}: ${text}`);
}

/** @param {string[]} lines @param {string[]} entries */
function bulletLines(entries) {
  const lines = [];
  for (const entry of entries) {
    if (typeof entry === "string" && entry.length > 0) lines.push(`- ${entry}`);
  }
  return lines;
}

/** @param {number} value @param {string} unit @param {string} numberLocale */
function formatCost(value, unit, numberLocale) {
  const formatted = formatNumber(value, numberLocale);
  return formatted === null ? null : `${formatted} ${unit}`;
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {unknown} value */
function resolveBudget(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return DEFAULT_EVIDENCE_BUDGET_CHARS;
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
