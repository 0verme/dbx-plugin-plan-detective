/**
 * Pure view-model mapping for the fixture-driven MVP UI.
 *
 * The UI never interprets a plan on its own and never recomputes analysis: it
 * renders what `analyzePlan()` already produced (metrics, findings, normalized
 * tree). This module only reshapes those values for display and owns the small
 * tree state helpers (collapse / selection / evidence flattening), so it stays
 * testable offline, without a browser, and without duplicating core logic.
 */

import { incrementalCostOf } from "../core/index.js";
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
 * @param {import("../core/metrics/compute-metrics.js").PlanMetrics} metrics
 * @returns {{
 *   rows: Array<{ key: string, label: string, hint: string, value: string|null }>,
 *   highlights: Array<{ key: string, label: string, value: string|null, detail: string|null, node: object|null }>,
 * }}
 */
export function buildPlanSummary(metrics) {
  return {
    rows: SUMMARY_ROWS.map((row) => ({ ...row, value: formatNumber(metrics?.[row.key]) })),
    highlights: [
      buildHighlight("largestEstimatedRows", "Largest Estimated Rows", metrics?.largestEstimatedRows),
      buildHighlight("highestIncrementalCost", "Highest Incremental Cost", metrics?.highestIncrementalCost),
    ],
  };
}

/**
 * @param {string} key
 * @param {string} label
 * @param {Record<string, any>|null|undefined} summary
 */
function buildHighlight(key, label, summary) {
  if (summary === null || summary === undefined || typeof summary !== "object") {
    return { key, label, value: null, detail: null, node: null };
  }

  const isCost = key === "highestIncrementalCost";
  const value = formatNumber(isCost ? summary.incrementalCost : summary.estimatedRows);
  const detail = isCost ? `node total cost ${formatNumber(summary.totalCost) ?? "—"}` : null;

  return {
    key,
    label,
    value,
    detail,
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
 */
export function buildFindingViews(findings, rowsById) {
  return sortFindings(findings).map((finding) => ({
    id: finding.id,
    ruleId: finding.ruleId,
    severity: finding.severity,
    title: finding.title,
    summary: finding.summary,
    nodeRef: finding.nodeRef,
    nodeLabel: describeNodeRef(rowsById, finding.nodeRef),
    evidence: flattenEvidence(finding.evidence),
  }));
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
 * Engine-specific fields. PostgreSQL and MySQL keep their own vocabularies:
 * the panel renders whatever the node's normalizer actually reported and never
 * renames one engine's fields into the other's.
 *
 * @param {Record<string, any>} engine
 * @returns {Array<{ label: string, value: string }|null>}
 */
function engineFields(engine) {
  if (isPlainObject(engine.mysql)) return mysqlEngineFields(engine.mysql);
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
