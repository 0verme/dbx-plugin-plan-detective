/**
 * Pure view-model mapping for the fixture-driven MVP UI.
 *
 * The UI never interprets a plan on its own and never recomputes analysis: it
 * renders what `analyzePlan()` already produced (metrics, findings, hotspots,
 * normalized tree). This module only reshapes those values for display and owns
 * the small tree state helpers (collapse / selection / evidence flattening), so
 * it stays testable offline, without a browser, and without duplicating core
 * logic.
 */

import { incrementalCostOf } from "../core/index.js";
import { presentFinding } from "./finding-presentation.js";
import { createTranslator } from "./i18n/index.js";
import { formatNumber, formatPercent, formatRawValue } from "./format.js";

/* ---------------------------------------------------------------- summary -- */

/**
 * Metrics shown in the Plan Summary, in display order. Labels are the UI
 * vocabulary; every value comes straight from `metrics` — no scoring, no
 * ranking, no re-computation.
 */
const SUMMARY_ROWS = Object.freeze([
  { key: "totalEstimatedCost", label: "Total Estimated Cost", hint: "根节点 total cost（planner 估算，非运行时耗时）" },
  { key: "rootEstimatedRows", label: "Root Estimated Rows", hint: "根节点估算行数" },
  { key: "nodeCount", label: "Node Count", hint: "计划树节点总数" },
  { key: "maxDepth", label: "Max Depth", hint: "最长 root-to-leaf 路径（单节点 = 1）" },
  { key: "scanCount", label: "Scan Count", hint: "全部 scan 类节点" },
  { key: "sequentialScanCount", label: "Sequential Scan Count", hint: "Seq Scan 节点" },
  { key: "indexScanCount", label: "Index Scan Count", hint: "Index Scan + Index Only Scan" },
  { key: "joinCount", label: "Join Count", hint: "Nested Loop / Hash Join / Merge Join" },
  { key: "sortCount", label: "Sort Count", hint: "Sort + Incremental Sort" },
  { key: "aggregateCount", label: "Aggregate Count", hint: "Aggregate 家族 + Group" },
  { key: "unknownNodeTypeCount", label: "Unknown Node Type Count", hint: "normalizer 未登记的节点类型数量" },
]);

/**
 * Display copy for `metrics.costAttribution.reason`. The Core decides whether
 * PostgreSQL cost attribution is safe; the UI only translates the stable
 * reason code, exactly like the Hotspot panel does for `hotspots.cost`.
 */
const COST_ATTRIBUTION_NOTES = Object.freeze({
  NO_PLAN_COST: "计划未报告根节点 Total Cost，无法归因自代价。",
  MISSING_NODE_COST: "计划存在缺失 Total Cost 的节点，缺失值不按 0 处理，自代价不可归因。",
  PLAN_CONTAINS_SUBPLAN:
    "计划包含 InitPlan / SubPlan：父节点 Total Cost 不按子节点累加，自代价不可归因。",
  UNVERIFIED_COST_FLOW: "部分节点缺少可验证的 Parent Relationship，自代价归因不可靠。",
  NO_ATTRIBUTABLE_COST: "该计划没有可归因的自代价节点（根节点截断了子节点代价）。",
});

/**
 * @param {import("../core/metrics/compute-metrics.js").PlanMetrics} metrics
 * @returns {{
 *   rows: Array<{ key: string, label: string, hint: string, value: string|null }>,
 *   highlights: Array<{ key: string, label: string, value: string|null, detail: string|null, note: string|null, node: object|null }>,
 * }}
 */
export function buildPlanSummary(metrics) {
  return {
    rows: SUMMARY_ROWS.map((row) => ({ ...row, value: formatNumber(metrics?.[row.key]) })),
    highlights: [
      buildHighlight("largestEstimatedRows", "Largest Estimated Rows", metrics?.largestEstimatedRows),
      buildHighestIncrementalCostHighlight(metrics),
    ].filter((highlight) => highlight !== null),
  };
}

/**
 * `Highest Incremental Cost` is a PostgreSQL cumulative-cost metric. The Core
 * publishes whether that attribution is safe through `metrics.costAttribution`;
 * the UI never inspects InitPlan / SubPlan / Limit itself.
 *
 * - `available`: the value and its node, exactly as Core reported them;
 * - `withheld`: no value, plus the Core reason as display copy;
 * - `not-applicable`: the highlight is omitted (MySQL has its own cost model,
 *   and no PostgreSQL incremental cost is invented for it);
 * - missing attribution (legacy metrics): keep the previous mapping.
 *
 * @param {import("../core/metrics/compute-metrics.js").PlanMetrics} metrics
 */
function buildHighestIncrementalCostHighlight(metrics) {
  const attribution = metrics?.costAttribution ?? null;
  if (attribution?.status === "not-applicable") return null;

  const highlight = buildHighlight("highestIncrementalCost", "Highest Incremental Cost", metrics?.highestIncrementalCost);
  if (attribution?.status !== "withheld") return highlight;

  return {
    ...highlight,
    value: null,
    detail: null,
    note: COST_ATTRIBUTION_NOTES[attribution.reason] ?? "该计划的 PostgreSQL 代价归因不可靠，已停用该指标。",
    node: null,
  };
}

/**
 * @param {string} key
 * @param {string} label
 * @param {Record<string, any>|null|undefined} summary
 */
function buildHighlight(key, label, summary) {
  if (summary === null || summary === undefined || typeof summary !== "object") {
    return { key, label, value: null, detail: null, note: null, node: null };
  }

  const isCost = key === "highestIncrementalCost";
  const value = formatNumber(isCost ? summary.incrementalCost : summary.estimatedRows);
  const detail = isCost ? `node total cost ${formatNumber(summary.totalCost) ?? "—"}` : null;

  return {
    key,
    label,
    value,
    detail,
    note: null,
    node: {
      nodeId: summary.nodeId,
      nodeType: summary.nodeType,
      kind: summary.kind,
      relation: summary.relation ?? null,
    },
  };
}

/* ------------------------------------------------------------------- tree -- */

/**
 * Flatten a normalized plan into pre-order rows for a nested tree view.
 *
 * @param {import("../core/normalize/normalize-postgres.js").NormalizedNode} root
 * @returns {Array<{
 *   id: string, parentId: string|null, ancestorIds: string[], depth: number,
 *   hasChildren: boolean, kind: string, nodeType: string, relation: string|null,
 *   alias: string|null, indexName: string|null, estimatedRows: number|null,
 *   totalCost: number|null, label: string,
 * }>}
 */
export function buildTreeRows(root) {
  const rows = [];

  /** @param {any} node @param {number} depth @param {string[]} ancestorIds */
  function visit(node, depth, ancestorIds) {
    rows.push({
      id: node.id,
      parentId: ancestorIds.length === 0 ? null : ancestorIds[ancestorIds.length - 1],
      ancestorIds,
      depth,
      hasChildren: node.children.length > 0,
      kind: node.kind,
      nodeType: node.nodeType,
      relation: node.relation?.name ?? null,
      alias: node.relation?.alias ?? null,
      indexName: node.relation?.indexName ?? null,
      estimatedRows: node.estimatedRows,
      totalCost: node.totalCost,
      label: nodeLabel(node),
    });
    for (const child of node.children) {
      visit(child, depth + 1, [...ancestorIds, node.id]);
    }
  }

  visit(root, 0, []);
  return rows;
}

/**
 * Human label for a plan node: node type plus the relation / index it touches.
 *
 * @param {{ nodeType: string, relation: { name: string|null, alias: string|null, indexName: string|null }|null }} node
 * @returns {string}
 */
export function nodeLabel(node) {
  const base = node.relation?.name ? `${node.nodeType} · ${node.relation.name}` : node.nodeType;
  const alias = node.relation?.alias && node.relation.alias !== node.relation.name ? ` [${node.relation.alias}]` : "";
  const index = node.relation?.indexName ? ` via ${node.relation.indexName}` : "";
  return `${base}${alias}${index}`;
}

/** @param {ReturnType<typeof buildTreeRows>} rows */
export function indexRowsById(rows) {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Map node id -> normalized node, so the inspector can look up the selected
 * node without walking the tree on every render.
 *
 * @param {import("../core/normalize/normalize-postgres.js").NormalizedNode} root
 */
export function indexNodesById(root) {
  const map = new Map();

  /** @param {any} node */
  function visit(node) {
    map.set(node.id, node);
    for (const child of node.children) visit(child);
  }

  visit(root);
  return map;
}

/**
 * Rows that survive the current collapse state. A row is hidden when any of
 * its ancestors is collapsed.
 *
 * @param {ReturnType<typeof buildTreeRows>} rows
 * @param {Set<string>} collapsedIds
 */
export function visibleTreeRows(rows, collapsedIds) {
  if (collapsedIds === undefined || collapsedIds.size === 0) return rows;
  return rows.filter((row) => !row.ancestorIds.some((id) => collapsedIds.has(id)));
}

/**
 * Toggle one node's collapse state, returning a new Set so Svelte reactivity
 * sees a changed value.
 *
 * @param {Set<string>} collapsedIds
 * @param {string} nodeId
 * @returns {Set<string>}
 */
export function toggleCollapsed(collapsedIds, nodeId) {
  const next = new Set(collapsedIds);
  if (next.has(nodeId)) next.delete(nodeId);
  else next.add(nodeId);
  return next;
}

/**
 * Remove the ancestors of a row from the collapse set so the row becomes
 * visible (used when a finding jumps to its node).
 *
 * @param {Set<string>} collapsedIds
 * @param {{ ancestorIds: string[] }|undefined} row
 * @returns {Set<string>}
 */
export function expandAncestors(collapsedIds, row) {
  if (row === undefined) return collapsedIds;
  const next = new Set(collapsedIds);
  for (const id of row.ancestorIds) next.delete(id);
  return next;
}

/* --------------------------------------------------------------- findings -- */

const SEVERITY_ORDER = Object.freeze({ high: 0, warning: 1, info: 2 });

/** @param {string} severity */
export function severityRank(severity) {
  return SEVERITY_ORDER[severity] ?? SEVERITY_ORDER.info;
}

/**
 * Sort findings by severity (high → warning → info), keeping the deterministic
 * rule order for findings of the same severity.
 *
 * @template {{ severity: string }} T
 * @param {T[]} findings
 * @returns {T[]}
 */
export function sortFindings(findings) {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => severityRank(a.finding.severity) - severityRank(b.finding.severity) || a.index - b.index)
    .map((entry) => entry.finding);
}

/**
 * @param {{ severity: string }[]} findings
 */
export function countFindingsBySeverity(findings) {
  const counts = { info: 0, warning: 0, high: 0, total: findings.length };
  for (const finding of findings) {
    if (finding.severity in counts) counts[finding.severity] += 1;
  }
  return counts;
}

/**
 * Map nodeRef -> { count, severity } so the tree can flag nodes that produced
 * findings without recomputing anything.
 *
 * @param {{ nodeRef: string, severity: string }[]} findings
 */
export function groupFindingsByNodeRef(findings) {
  const map = new Map();
  for (const finding of findings) {
    const current = map.get(finding.nodeRef) ?? { count: 0, severity: "info" };
    current.count += 1;
    if (severityRank(finding.severity) < severityRank(current.severity)) current.severity = finding.severity;
    map.set(finding.nodeRef, current);
  }
  return map;
}

/**
 * @param {import("../core/findings/finding.js").Finding[]} findings
 * @param {Map<string, ReturnType<typeof buildTreeRows>[number]>} rowsById
 * @param {unknown} [locale]
 */
export function buildFindingViews(findings, rowsById, locale = "zh-CN") {
  return sortFindings(findings).map((finding) => {
    const presentation = presentFinding(finding, locale);
    const evidence = flattenEvidence(finding.evidence);
    const evidenceSummary = createTranslator(presentation.locale).t("diagnosis.section.evidence", { count: evidence.length });
    return {
      id: finding.id,
      ruleId: finding.ruleId,
      severity: finding.severity,
      title: presentation.title,
      summary: presentation.summary,
      nodeRef: finding.nodeRef,
      nodeLabel: describeNodeRef(rowsById, finding.nodeRef),
      presentation,
      evidence,
      evidenceSummary,
    };
  });
}

/**
 * @param {Map<string, { label: string }>|undefined} rowsById
 * @param {string} nodeRef
 */
export function describeNodeRef(rowsById, nodeRef) {
  const row = rowsById?.get(nodeRef);
  return row === undefined ? nodeRef : `${row.id} · ${row.label}`;
}

/**
 * Flatten a finding evidence object into display rows. Nested objects (for
 * example `thresholds`) become indented rows whose path keeps the full key, and
 * `null` is rendered as `—` because "the rule saw no value" is itself evidence.
 *
 * @param {Record<string, unknown>} evidence
 * @returns {Array<{ path: string, value: string, depth: number }>}
 */
export function flattenEvidence(evidence) {
  const rows = [];

  /** @param {unknown} value @param {string} path @param {number} depth */
  function visit(value, path, depth) {
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, depth + 1);
      return;
    }
    rows.push({ path, value: formatEvidenceValue(path, value), depth });
  }

  for (const [key, value] of Object.entries(evidence)) visit(value, key, 0);
  return rows;
}

/**
 * @param {string} path
 * @param {unknown} value
 * @returns {string}
 */
function formatEvidenceValue(path, value) {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    return value.map((item) => formatRawValue(item) ?? "—").join(", ");
  }
  if (typeof value === "number") {
    const leaf = path.split(".").pop() ?? "";
    if (leaf === "costShare" || leaf.endsWith("Share")) return formatPercent(value) ?? "—";
    return formatNumber(value) ?? String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value.length === 0 ? "—" : value;
  return JSON.stringify(value);
}

/* ---------------------------------------------------------------- hotspots -- */

/**
 * Why cost-based hotspot signals were withheld. The note is display copy only:
 * the core already decided, and the UI must not re-derive or soften it.
 */
const HOTSPOT_COST_NOTES = Object.freeze({
  NO_PLAN_COST: "计划未报告根节点 Total Cost，已停用代价占比信号，仅使用行数信号（Estimated Plan）。",
  MISSING_NODE_COST: "计划存在缺失 Total Cost 的节点，子树代价累加不可靠，已停用代价占比信号。",
  PLAN_CONTAINS_SUBPLAN:
    "计划包含 InitPlan / SubPlan / CTE：PostgreSQL 父节点代价不按子节点 Total Cost 累加，已停用代价占比信号。",
  UNVERIFIED_COST_FLOW: "部分节点缺少可验证的 Parent Relationship，代价归因不可靠，已停用代价占比信号。",
  NO_QUERY_COST: "MySQL 计划未报告 query_cost，已停用 MySQL 代价占比信号，仅使用行数与操作标记信号。",
  NOT_POSTGRES_COST_MODEL:
    "SQL Server 的 EstimatedTotalSubtreeCost 属于 SQL Server 自己的代价模型，未按 PostgreSQL 语义归因；仅使用行数信号。",
});

/**
 * Hotspot panel view model. The UI adds no ranking and no advice: reasons and
 * evidence come from the core, and the finding cross-reference is a lookup, not
 * a recalculation.
 *
 * @param {import("../core/hotspots/compute-hotspots.js").HotspotAnalysis|null|undefined} hotspotAnalysis
 * @param {Map<string, ReturnType<typeof buildTreeRows>[number]>} [rowsById]
 * @param {import("../core/findings/finding.js").Finding[]} [findings]
 * @returns {{
 *   costNote: string|null,
 *   items: Array<{
 *     id: string, rank: number, level: string, nodeId: string, nodeLabel: string,
 *     nodeType: string, relation: string|null,
 *     reasons: Array<{ code: string, level: string, statement: string, source: string }>,
 *     evidence: Array<{ path: string, value: string, depth: number }>,
 *     findingRuleIds: string[], estimateOnly: boolean,
 *   }>,
 * }}
 */
export function buildHotspotViews(hotspotAnalysis, rowsById, findings = []) {
  const items = hotspotAnalysis?.items ?? [];
  const ruleIdsByNodeRef = new Map();
  for (const finding of findings) {
    const ruleIds = ruleIdsByNodeRef.get(finding.nodeRef) ?? [];
    if (!ruleIds.includes(finding.ruleId)) ruleIds.push(finding.ruleId);
    ruleIdsByNodeRef.set(finding.nodeRef, ruleIds);
  }

  return {
    costNote: describeHotspotCost(hotspotAnalysis?.cost),
    items: items.map((hotspot, index) => ({
      id: hotspot.id,
      rank: index + 1,
      level: hotspot.level,
      nodeId: hotspot.nodeId,
      nodeLabel: rowsById?.get(hotspot.nodeId)?.label ?? hotspot.nodeType,
      nodeType: hotspot.nodeType,
      relation: hotspot.relation ?? null,
      reasons: hotspot.reasons.map((reason) => ({
        code: reason.code,
        level: reason.level,
        statement: reason.statement,
        source: reason.source,
      })),
      evidence: flattenEvidence(hotspot.evidence),
      findingRuleIds: ruleIdsByNodeRef.get(hotspot.nodeId) ?? [],
      estimateOnly: hotspot.estimateOnly === true,
    })),
  };
}

/**
 * @param {{ status: string, reason: string|null }|null|undefined} cost
 * @returns {string|null} display note, or `null` when cost signals are available
 */
export function describeHotspotCost(cost) {
  if (cost === null || cost === undefined) return null;
  if (cost.status === "not-applicable") {
    // MySQL reports its own cost signals, so `not-applicable` in practice means
    // a plan whose engine has no shared cost attribution (SQL Server).
    return HOTSPOT_COST_NOTES[cost.reason] ?? "该引擎没有可用的共享代价归因，已仅使用行数信号。";
  }
  if (cost.status !== "withheld") return null;
  return HOTSPOT_COST_NOTES[cost.reason] ?? "该计划的代价信号不可用，已仅使用行数信号。";
}

/**
 * Map node id -> strongest hotspot level, so the plan tree can mark hotspot
 * nodes without recomputing any signal.
 *
 * @param {{ nodeId: string, level: string }[]} hotspots
 */
export function groupHotspotsByNodeRef(hotspots) {
  const map = new Map();
  for (const hotspot of hotspots) {
    const current = map.get(hotspot.nodeId) ?? { count: 0, level: "info" };
    current.count += 1;
    if (severityRank(hotspot.level) < severityRank(current.level)) current.level = hotspot.level;
    map.set(hotspot.nodeId, current);
  }
  return map;
}

/**
 * @param {{ level: string }[]} hotspots
 */
export function countHotspotLevels(hotspots) {
  const counts = { info: 0, warning: 0, high: 0, total: hotspots.length };
  for (const hotspot of hotspots) {
    if (hotspot.level in counts) counts[hotspot.level] += 1;
  }
  return counts;
}

/* -------------------------------------------------------------- inspector -- */

/**
 * Build the Node Inspector view model for one normalized node.
 *
 * Only values that the plan actually reported are shown: `null`, empty strings,
 * empty arrays and `false` flags are omitted instead of being rendered as
 * `undefined` / `null` noise. Actual-execution fields therefore appear for
 * `actual` plans only.
 *
 * @param {import("../core/normalize/normalize-postgres.js").NormalizedNode|null|undefined} node
 * @returns {{
 *   id: string, title: string, subtitle: string,
 *   groups: Array<{ key: string, label: string, fields: Array<{ label: string, value: string }> }>,
 * }|null}
 */
export function buildNodeInspector(node) {
  if (node === null || node === undefined) return null;

  const engine = node.engineSpecific ?? {};
  const groups = [
    {
      key: "identity",
      label: "Identity",
      fields: compact([
        field("Node ID", node.id),
        field("Node Type", node.nodeType),
        field("Kind", node.kind),
        field("Relation", node.relation?.name),
        field("Alias", node.relation?.alias),
        field("Index Name", node.relation?.indexName),
        field("Join Type", node.joinType),
      ]),
    },
    {
      key: "estimates",
      label: "Estimates",
      fields: compact([
        field("Estimated Rows", formatNumber(node.estimatedRows)),
        field("Startup Cost", formatNumber(node.startupCost)),
        field("Total Cost", formatNumber(node.totalCost)),
        field("Incremental Cost", formatNumber(incrementalCostOf(node))),
        field("Plan Width", formatNumber(node.width)),
      ]),
    },
    {
      key: "actual",
      label: "Actual (runtime)",
      fields: compact([
        field("Actual Rows", formatNumber(node.actualRows)),
        field("Actual Startup Time", formatNumber(node.actualStartupTime)),
        field("Actual Total Time", formatNumber(node.actualTotalTime)),
        field("Actual Loops", formatNumber(node.loops)),
      ]),
    },
    {
      key: "predicates",
      label: "Predicates",
      fields: compact([
        field("Filter", node.filter),
        field("Index Condition", node.indexCondition),
        field("Join Condition", node.joinCondition),
        field("Sort Keys", formatRawValue(node.sortKeys)),
        field("Group Keys", formatRawValue(node.groupKeys)),
      ]),
    },
    {
      key: "engine",
      label: "Engine-specific",
      fields: compact(engineFields(engine)),
    },
    {
      key: "extra",
      label: "Extra / native fields",
      fields: extraFields(engine.extra),
    },
  ];

  return {
    id: node.id,
    title: nodeLabel(node),
    subtitle: [node.kind, node.relation?.alias ? `alias ${node.relation.alias}` : null].filter(Boolean).join(" · "),
    groups: groups.filter((group) => group.fields.length > 0),
  };
}

/**
 * Engine-specific fields. PostgreSQL, MySQL and SQL Server keep their own
 * vocabularies: the panel renders whatever the node's normalizer actually
 * reported and never renames one engine's fields into another's.
 *
 * @param {Record<string, any>} engine
 * @returns {Array<{ label: string, value: string }|null>}
 */
function engineFields(engine) {
  if (isPlainObject(engine.mysql)) return mysqlEngineFields(engine.mysql);
  if (isPlainObject(engine.sqlServer)) return sqlServerEngineFields(engine.sqlServer);
  return [
    flagField("Parallel Aware", engine.parallelAware),
    flagField("Async Capable", engine.asyncCapable),
    field("Strategy", engine.strategy),
    field("Partial Mode", engine.partialMode),
    field("Parent Relationship", engine.parentRelationship),
    field("Subplan Name", engine.subplanName),
    field("Hash Condition", engine.hashCondition),
    field("Merge Condition", engine.mergeCondition),
    field("Join Filter", engine.joinFilter),
    field("Recheck Condition", engine.recheckCondition),
    field("Presorted Keys", formatRawValue(engine.presortedKeys)),
  ];
}

/**
 * SQL Server ShowPlanXML fields. Subtree / per-node costs are shown here, not
 * as PostgreSQL-style costs: they belong to SQL Server's own cost model and are
 * not comparable with PostgreSQL cost units.
 *
 * @param {Record<string, unknown>} sqlServer
 * @returns {Array<{ label: string, value: string }|null>}
 */
function sqlServerEngineFields(sqlServer) {
  const operator = isPlainObject(sqlServer.operator) ? sqlServer.operator : {};
  return [
    field("Physical Op", sqlServer.physicalOp),
    field("Logical Op", sqlServer.logicalOp),
    field("Node ID (ShowPlanXML)", formatNumber(sqlServer.nodeId)),
    field("Estimated Subtree Cost", formatNumber(sqlServer.estimatedTotalSubtreeCost)),
    field("Estimate CPU", formatNumber(sqlServer.estimateCpu)),
    field("Estimate IO", formatNumber(sqlServer.estimateIo)),
    field("Estimate Rebinds", formatNumber(sqlServer.estimateRebinds)),
    field("Estimate Rewinds", formatNumber(sqlServer.estimateRewinds)),
    field("Estimate Executions", formatNumber(sqlServer.estimateExecutions)),
    flagField("Parallel", sqlServer.parallel),
    field("Object Database", sqlServer.database),
    field("Object Schema", sqlServer.schema),
    field("Object Table", sqlServer.table),
    field("Object Index", sqlServer.index),
    field("Object Alias", sqlServer.alias),
    field("Index Kind", sqlServer.indexKind),
    field("Storage", sqlServer.storage),
    flagField("Lookup", operator.lookup),
    flagField("Ordered", operator.ordered),
    flagField("Distinct", operator.distinct),
    field("Top Row Count", formatNumber(operator.topRowCount)),
    flagField("Many to Many", operator.manyToMany),
    field("Partitioning Type", operator.partitioningType),
    field("Hash Keys Build", formatRawValue(sqlServer.hashKeysBuild)),
    field("Hash Keys Probe", formatRawValue(sqlServer.hashKeysProbe)),
    field("Probe Residual", sqlServer.probeResidual),
    field("Build Residual", sqlServer.buildResidual),
    field("Residual", sqlServer.residual),
    field("Defined Values", formatRawValue(sqlServer.definedValues)),
    field("Statement Type", sqlServer.statement?.type),
    field("Degree of Parallelism", formatNumber(sqlServer.queryPlan?.degreeOfParallelism)),
    field("Memory Grant", formatNumber(sqlServer.queryPlan?.memoryGrant)),
  ];
}

/**
 * MySQL `EXPLAIN FORMAT=JSON` fields. MySQL costs are shown here, not as
 * PostgreSQL-style costs: they belong to MySQL's own cost model and are not
 * comparable with PostgreSQL cost units.
 *
 * @param {Record<string, unknown>} mysql
 * @returns {Array<{ label: string, value: string }|null>}
 */
function mysqlEngineFields(mysql) {
  return [
    field("Structure", mysql.structure),
    field("Select ID", formatNumber(mysql.selectId)),
    field("Message", mysql.message),
    field("Access Type", mysql.accessType),
    field("Possible Keys", formatRawValue(mysql.possibleKeys)),
    field("Used Key Parts", formatRawValue(mysql.usedKeyParts)),
    field("Key Length", mysql.keyLength),
    field("Ref", formatRawValue(mysql.ref)),
    field("Rows Examined Per Scan", formatNumber(mysql.rowsExaminedPerScan)),
    field("Rows Produced Per Join", formatNumber(mysql.rowsProducedPerJoin)),
    percentField("Filtered", mysql.filteredPercent),
    flagField("Using Index", mysql.usingIndex),
    flagField("Using Index For Group By", mysql.usingIndexForGroupBy),
    flagField("Using Filesort", mysql.usingFilesort),
    flagField("Using Temporary Table", mysql.usingTemporaryTable),
    field("Using Join Buffer", mysql.usingJoinBuffer),
    field("First Match", mysql.firstMatch),
    // dependent / cacheable are meaningful in both states, so neither is hidden.
    field("Dependent", mysql.dependent),
    field("Cacheable", mysql.cacheable),
    field("Query Cost", formatNumber(mysql.queryCost)),
    field("Read Cost", formatNumber(mysql.readCost)),
    field("Eval Cost", formatNumber(mysql.evalCost)),
    field("Prefix Cost", formatNumber(mysql.prefixCost)),
    field("Data Read Per Join", formatNumber(mysql.dataReadPerJoin)),
    field("Sort Cost", formatNumber(mysql.sortCost)),
  ];
}

/**
 * MySQL `filtered` is already a percentage (14.29 means 14.29%), so it must not
 * go through `formatPercent` (which expects a fraction).
 *
 * @param {string} label
 * @param {unknown} value
 */
function percentField(label, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return { label, value: `${formatNumber(value)}%` };
}

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {{ label: string, value: string }|null}
 */
function field(label, value) {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : String(value);
  if (text.length === 0) return null;
  return { label, value: text };
}

/**
 * Booleans are shown only when true: `false` is the uninteresting default and
 * would otherwise add noise to every node.
 *
 * @param {string} label
 * @param {unknown} value
 */
function flagField(label, value) {
  return value === true ? { label, value: "true" } : null;
}

/** @param {Array<{ label: string, value: string }|null>} fields */
function compact(fields) {
  return fields.filter((entry) => entry !== null);
}

/** @param {Record<string, unknown>|undefined} extra */
function extraFields(extra) {
  if (extra === null || extra === undefined || typeof extra !== "object") return [];
  return Object.entries(extra)
    .map(([key, value]) => field(key, formatRawValue(value)))
    .filter((entry) => entry !== null);
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
