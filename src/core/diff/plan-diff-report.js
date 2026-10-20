/**
 * Presentation-ready, pure report for two Estimated Plans.
 *
 * The matching itself stays in `diffEstimatedPlans`; this module only adds the
 * comparability envelope, grouped change summaries and association of existing
 * Findings / Hotspots through the matched node ids. It never acquires a plan,
 * re-runs a database, reads a snapshot store or touches the DOM.
 *
 * Every entry is JSON-serializable and language-neutral: stable reason codes,
 * rule ids and raw values only. The UI owns localized copy and formatting.
 */

import { flattenNodes } from "../tree.js";
import {
  AGGREGATE_KINDS,
  JOIN_KINDS,
  SCAN_KINDS,
  SORT_KINDS,
  diffEstimatedPlans,
  readPlanAnalysis,
} from "./estimated-plan-diff.js";

/** Group order the UI renders; unknown categories are appended at the end. */
export const DIFF_GROUP_ORDER = Object.freeze([
  "access",
  "index",
  "join",
  "sort",
  "aggregate",
  "rows",
  "predicate",
  "relation",
  "operator",
  "message",
  "other",
]);

const SOURCE_KEYS = Object.freeze(["databaseName", "schema"]);

/**
 * Build a display report for one baseline / current pair.
 *
 * @param {{
 *   baseline: unknown,
 *   current: unknown,
 *   baselineMeta?: Record<string, unknown>|null,
 *   currentMeta?: Record<string, unknown>|null,
 * }} input
 * @returns {object} JSON-serializable report.
 */
export function buildEstimatedPlanDiff(input = {}) {
  const baselineResult = readPlanAnalysis(input.baseline);
  const currentResult = readPlanAnalysis(input.current);
  const sides = {
    baseline: describeSide(baselineResult, input.baselineMeta),
    current: describeSide(currentResult, input.currentMeta),
  };
  const comparison = diffEstimatedPlans(input.baseline, input.current);

  if (comparison.status !== "comparable") {
    return {
      status: "incompatible",
      reasonCode: comparison.reasonCode,
      database: comparison.database,
      sides,
      comparability: null,
      summary: null,
      totals: null,
      groups: emptyGroups(),
      matches: [],
      nodes: {
        added: [],
        removed: [],
        unmatched: { baseline: [], current: [] },
        ambiguous: [],
      },
      diagnostics: {
        status: "unavailable",
        reasonCode: comparison.reasonCode,
        findings: emptyFindingDiff(),
        hotspots: emptyHotspotDiff(),
      },
    };
  }

  const beforePlan = baselineResult.normalized;
  const afterPlan = currentResult.normalized;
  const beforeNodes = flattenNodes(beforePlan.root);
  const afterNodes = flattenNodes(afterPlan.root);
  const beforeById = new Map(beforeNodes.map((node) => [node.id, node]));
  const afterById = new Map(afterNodes.map((node) => [node.id, node]));

  const matches = comparison.matches.map((match) => ({
    ...match,
    before: nodeSummary(beforeById.get(match.beforeId)),
    after: nodeSummary(afterById.get(match.afterId)),
  }));

  const groups = buildGroups(matches);
  const nodes = buildNodeChanges({
    comparison,
    beforeById,
    afterById,
    beforeNodes,
    afterNodes,
    matchedBeforeIds: new Set(comparison.matches.map((match) => match.beforeId)),
    matchedAfterIds: new Set(comparison.matches.map((match) => match.afterId)),
  });
  const categoryCounts = Object.fromEntries(DIFF_GROUP_ORDER.map((category) => [category, groups[category].length]));
  const changed = matches.filter((match) => match.changes.length > 0).length;
  const ambiguousNodeCount = comparison.ambiguous.reduce(
    (total, entry) => total + entry.beforeIds.length + entry.afterIds.length,
    0,
  );

  return {
    status: "comparable",
    reasonCode: null,
    database: beforePlan.database,
    sides,
    comparability: buildComparability({ beforePlan, afterPlan, sides }),
    summary: {
      matched: matches.length,
      changed,
      unchanged: matches.length - changed,
      added: nodes.added.length,
      removed: nodes.removed.length,
      unmatched: nodes.unmatched.baseline.length + nodes.unmatched.current.length,
      ambiguous: ambiguousNodeCount,
      categoryCounts,
    },
    totals: {
      baseline: {
        nodeCount: beforeNodes.length,
        rootEstimatedRows: beforePlan.root.estimatedRows ?? null,
        rootTotalCost: beforePlan.root.totalCost ?? null,
      },
      current: {
        nodeCount: afterNodes.length,
        rootEstimatedRows: afterPlan.root.estimatedRows ?? null,
        rootTotalCost: afterPlan.root.totalCost ?? null,
      },
    },
    groups,
    matches,
    nodes,
    diagnostics: buildDiagnostics({
      beforeAnalysis: baselineResult.analysis,
      afterAnalysis: currentResult.analysis,
      beforeToAfter: new Map(comparison.matches.map((match) => [match.beforeId, match.afterId])),
      afterToBefore: new Map(comparison.matches.map((match) => [match.afterId, match.beforeId])),
    }),
  };
}

/* ----------------------------------------------------------- side context -- */

function describeSide(result, meta) {
  const descriptor = isRecord(meta) ? meta : {};
  const session = isRecord(result.session) ? result.session : {};
  const rawInput = result.rawInput;
  const normalizedRoot = result.normalized?.root ?? null;
  return {
    kind: textOrNull(descriptor.kind),
    id: textOrNull(descriptor.id),
    title: textOrNull(descriptor.title),
    savedAt: textOrNull(descriptor.savedAt),
    capturedAt: textOrNull(descriptor.capturedAt) ?? textOrNull(session.capturedAt),
    producerVersion: textOrNull(descriptor.producerVersion),
    databaseVersion: textOrNull(rawInput?.databaseVersion) ?? textOrNull(descriptor.databaseVersion),
    source: normalizeSource(session.source) ?? normalizeSource(descriptor.source),
    sql: textOrNull(rawInput?.sql) ?? textOrNull(descriptor.sql),
    nodeCount: normalizedRoot === null ? 0 : flattenNodes(normalizedRoot).length,
    rootEstimatedRows: normalizedRoot?.estimatedRows ?? null,
    rootTotalCost: normalizedRoot?.totalCost ?? null,
  };
}

function buildComparability({ beforePlan, afterPlan, sides }) {
  const reasons = [];
  const baselineVersion = sides.baseline.databaseVersion;
  const currentVersion = sides.current.databaseVersion;
  if (baselineVersion === null || currentVersion === null) {
    reasons.push({
      code: "DATABASE_VERSION_UNKNOWN",
      level: "warning",
      baseline: baselineVersion,
      current: currentVersion,
    });
  } else if (baselineVersion !== currentVersion) {
    reasons.push({
      code: "DATABASE_VERSION_MISMATCH",
      level: "warning",
      baseline: baselineVersion,
      current: currentVersion,
    });
  }

  const baselineSource = sourceKey(sides.baseline.source);
  const currentSource = sourceKey(sides.current.source);
  if (baselineSource === null || currentSource === null) {
    reasons.push({
      code: "SOURCE_CONTEXT_UNKNOWN",
      level: "warning",
      baseline: sides.baseline.source,
      current: sides.current.source,
    });
  } else if (baselineSource !== currentSource) {
    reasons.push({
      code: "SOURCE_CONTEXT_MISMATCH",
      level: "warning",
      baseline: sides.baseline.source,
      current: sides.current.source,
    });
  }

  const baselineSql = sides.baseline.sql;
  const currentSql = sides.current.sql;
  if (baselineSql === null || currentSql === null) {
    reasons.push({
      code: "SQL_TEXT_UNKNOWN",
      level: "info",
      baseline: baselineSql,
      current: currentSql,
    });
  } else if (baselineSql.trim() !== currentSql.trim()) {
    reasons.push({
      code: "SQL_TEXT_DIFFERS",
      level: "info",
      baseline: baselineSql,
      current: currentSql,
    });
  }

  return {
    status: reasons.some((reason) => reason.level === "warning") ? "limited" : "comparable",
    reasons,
    cost: buildCostComparison(beforePlan, afterPlan),
  };
}

function buildCostComparison(beforePlan, afterPlan) {
  const baseline = beforePlan.root.totalCost;
  const current = afterPlan.root.totalCost;
  if (beforePlan.database !== "postgresql") {
    return {
      status: "withheld",
      reasonCode: "COST_MODEL_NOT_DIFFED",
      unit: null,
      baseline: null,
      current: null,
    };
  }
  if (!isFiniteNumber(baseline) || !isFiniteNumber(current)) {
    return {
      status: "withheld",
      reasonCode: "COST_MISSING",
      unit: null,
      baseline: isFiniteNumber(baseline) ? baseline : null,
      current: isFiniteNumber(current) ? current : null,
    };
  }
  // Native PostgreSQL optimizer units. No difference, ratio or performance
  // claim is derived from them; only the two reported estimates are exposed.
  return { status: "available", reasonCode: null, unit: "postgresql-native", baseline, current };
}

/* --------------------------------------------------------------- groups --- */

function buildGroups(matches) {
  const groups = emptyGroups();
  for (const match of matches) {
    const buckets = new Map();
    for (const change of match.changes) {
      const category = categorizeChange(change.field, match.before, match.after);
      if (!buckets.has(category)) buckets.set(category, []);
      buckets.get(category).push(change);
    }
    for (const [category, fields] of buckets) {
      const rowsChange = fields.find((field) => field.field === "estimatedRows");
      groups[category].push({
        key: `${match.beforeId}>${match.afterId}:${category}`,
        category,
        beforeId: match.beforeId,
        afterId: match.afterId,
        before: match.before,
        after: match.after,
        evidence: match.evidence,
        fields,
        beforeValue: fields[0].before,
        afterValue: fields[0].after,
        rowsDelta: category === "rows" ? safeDelta(rowsChange?.before, rowsChange?.after) : null,
      });
    }
  }
  for (const category of DIFF_GROUP_ORDER) {
    groups[category].sort((left, right) =>
      compareIds(left.beforeId, right.beforeId) || compareIds(left.afterId, right.afterId) || left.key.localeCompare(right.key));
  }
  return groups;
}

function emptyGroups() {
  return Object.fromEntries(DIFF_GROUP_ORDER.map((category) => [category, []]));
}

function categorizeChange(field, beforeNode, afterNode) {
  if (field === "estimatedRows") return "rows";
  if (field === "relation.indexName") return "index";
  if (field === "relation.name" || field === "relation.schema" || field === "relation.alias") return "relation";
  if (field === "filter" || field === "indexCondition") return "predicate";
  if (field === "joinType" || field === "joinCondition") return "join";
  if (field === "sortKeys") return "sort";
  if (field === "groupKeys") return "aggregate";
  if (field === "engineSpecific.mysql.message") return "message";
  if (field === "operator.kind" || field === "operator.nodeType") {
    const kinds = [beforeNode.kind, afterNode.kind];
    if (kinds.some((kind) => AGGREGATE_KINDS.has(kind))) return "aggregate";
    if (kinds.some((kind) => JOIN_KINDS.has(kind))) return "join";
    if (kinds.some((kind) => SORT_KINDS.has(kind))) return "sort";
    if (kinds.some((kind) => SCAN_KINDS.has(kind))) return "access";
    return "operator";
  }
  return "other";
}

/* ----------------------------------------------------------- node changes -- */

function buildNodeChanges({ comparison, beforeById, afterById, beforeNodes, afterNodes, matchedBeforeIds, matchedAfterIds }) {
  const afterRelationNames = new Set(afterNodes.map((node) => node.relation?.name).filter((name) => typeof name === "string"));
  const beforeRelationNames = new Set(beforeNodes.map((node) => node.relation?.name).filter((name) => typeof name === "string"));
  const pairKeyByBefore = new Map(comparison.matches.map((match) => [match.beforeId, `${match.beforeId}>${match.afterId}`]));
  const pairKeyByAfter = new Map(comparison.matches.map((match) => [match.afterId, `${match.beforeId}>${match.afterId}`]));
  const unmatchedSignatures = {
    baseline: new Set(comparison.unmatched.baseline
      .map((entry) => beforeById.get(entry.id))
      .filter((node) => node !== undefined)
      .map((node) => matchedDescendantSignature(node, pairKeyByBefore))),
    current: new Set(comparison.unmatched.current
      .map((entry) => afterById.get(entry.id))
      .filter((node) => node !== undefined)
      .map((node) => matchedDescendantSignature(node, pairKeyByAfter))),
  };

  const added = [];
  const removed = [];
  const unmatchedBaseline = [];
  const unmatchedCurrent = [];

  for (const entry of comparison.unmatched.baseline) {
    const node = beforeById.get(entry.id);
    if (node === undefined) continue;
    const summary = nodeSummary(node);
    if (isConfidentOnlySide({
      node,
      matchedDescendantIds: matchedBeforeIds,
      otherRelationNames: afterRelationNames,
      matchedDescendantSignature: matchedDescendantSignature(node, pairKeyByBefore),
      otherUnmatchedSignatures: unmatchedSignatures.current,
    })) {
      removed.push({ ...entry, node: summary });
    } else {
      unmatchedBaseline.push({ ...entry, node: summary });
    }
  }
  for (const entry of comparison.unmatched.current) {
    const node = afterById.get(entry.id);
    if (node === undefined) continue;
    const summary = nodeSummary(node);
    if (isConfidentOnlySide({
      node,
      matchedDescendantIds: matchedAfterIds,
      otherRelationNames: beforeRelationNames,
      matchedDescendantSignature: matchedDescendantSignature(node, pairKeyByAfter),
      otherUnmatchedSignatures: unmatchedSignatures.baseline,
    })) {
      added.push({ ...entry, node: summary });
    } else {
      unmatchedCurrent.push({ ...entry, node: summary });
    }
  }

  const ambiguous = comparison.ambiguous.map((entry) => ({
    beforeIds: entry.beforeIds,
    afterIds: entry.afterIds,
    reasonCode: entry.reasonCode,
    evidence: entry.evidence,
    before: entry.beforeIds.map((id) => nodeSummary(beforeById.get(id))).filter((node) => node !== null),
    after: entry.afterIds.map((id) => nodeSummary(afterById.get(id))).filter((node) => node !== null),
  }));

  added.sort((left, right) => compareIds(left.id, right.id));
  removed.sort((left, right) => compareIds(left.id, right.id));
  unmatchedBaseline.sort((left, right) => compareIds(left.id, right.id));
  unmatchedCurrent.sort((left, right) => compareIds(left.id, right.id));
  ambiguous.sort((left, right) => compareIdLists(left.beforeIds, right.beforeIds) || compareIdLists(left.afterIds, right.afterIds));

  return {
    added,
    removed,
    unmatched: { baseline: unmatchedBaseline, current: unmatchedCurrent },
    ambiguous,
  };
}

/**
 * A node that exists on only one side is reported as added / removed only when
 * a matched descendant anchors it and no unmatched node on the other side has
 * the same matched-descendant signature (that would mean the same structural
 * node still exists and only its subtree changed). A scan of a relation absent
 * from the other plan is also confident. Every other case stays "unmatched":
 * association is not proven, so it is never presented as an insertion or
 * deletion.
 */
function isConfidentOnlySide({ node, matchedDescendantIds, otherRelationNames, matchedDescendantSignature: signature, otherUnmatchedSignatures }) {
  let anchored = false;
  for (const descendant of flattenNodes(node).slice(1)) {
    if (matchedDescendantIds.has(descendant.id)) {
      anchored = true;
      break;
    }
  }
  if (anchored) return !otherUnmatchedSignatures.has(signature);
  if (SCAN_KINDS.has(node.kind) && typeof node.relation?.name === "string") {
    return !otherRelationNames.has(node.relation.name);
  }
  return false;
}

function matchedDescendantSignature(node, pairKeyByNodeId) {
  const keys = [];
  for (const descendant of flattenNodes(node)) {
    const key = pairKeyByNodeId.get(descendant.id);
    if (key !== undefined) keys.push(key);
  }
  return keys.sort().join("|");
}

function nodeSummary(node) {
  if (node === undefined || node === null) return null;
  return {
    id: node.id,
    kind: node.kind,
    nodeType: node.nodeType,
    relation: node.relation?.name ?? null,
    alias: node.relation?.alias ?? null,
    indexName: node.relation?.indexName ?? null,
    estimatedRows: node.estimatedRows ?? null,
    startupCost: node.startupCost ?? null,
    totalCost: node.totalCost ?? null,
  };
}

/* ------------------------------------------------------------ diagnostics -- */

function buildDiagnostics({ beforeAnalysis, afterAnalysis, beforeToAfter, afterToBefore }) {
  const beforeFindings = Array.isArray(beforeAnalysis?.findings) ? beforeAnalysis.findings : null;
  const afterFindings = Array.isArray(afterAnalysis?.findings) ? afterAnalysis.findings : null;
  const beforeHotspots = Array.isArray(beforeAnalysis?.hotspots?.items) ? beforeAnalysis.hotspots.items : null;
  const afterHotspots = Array.isArray(afterAnalysis?.hotspots?.items) ? afterAnalysis.hotspots.items : null;

  if (beforeFindings === null || afterFindings === null || beforeHotspots === null || afterHotspots === null) {
    return {
      status: "unavailable",
      reasonCode: "DIAGNOSTICS_UNAVAILABLE",
      findings: emptyFindingDiff(),
      hotspots: emptyHotspotDiff(),
    };
  }

  return {
    status: "available",
    reasonCode: null,
    findings: diffFindings(beforeFindings, afterFindings, beforeToAfter, afterToBefore),
    hotspots: diffHotspots(beforeHotspots, afterHotspots, beforeToAfter, afterToBefore),
  };
}

function emptyFindingDiff() {
  return { added: [], resolved: [], evidenceChanged: [], unchanged: 0, unlinked: { baseline: [], current: [] } };
}

function emptyHotspotDiff() {
  return { added: [], resolved: [], evidenceChanged: [], unchanged: 0, unlinked: { baseline: [], current: [] } };
}

function diffFindings(beforeFindings, afterFindings, beforeToAfter, afterToBefore) {
  const beforeByKey = new Map(beforeFindings.map((finding) => [findingKey(finding.ruleId, finding.nodeRef), finding]));
  const afterByKey = new Map(afterFindings.map((finding) => [findingKey(finding.ruleId, finding.nodeRef), finding]));
  const result = emptyFindingDiff();

  for (const finding of beforeFindings) {
    const afterNodeId = beforeToAfter.get(finding.nodeRef);
    if (afterNodeId === undefined) {
      result.unlinked.baseline.push(findingEntry(finding, "unlinked", finding.nodeRef, null));
      continue;
    }
    const afterFinding = afterByKey.get(findingKey(finding.ruleId, afterNodeId));
    if (afterFinding === undefined) {
      result.resolved.push(findingEntry(finding, "resolved", finding.nodeRef, null));
      continue;
    }
    const changedFields = changedTopLevelFields(finding.evidence, afterFinding.evidence);
    if (changedFields.length > 0) {
      result.evidenceChanged.push({
        ...findingEntry(finding, "evidence-changed", finding.nodeRef, afterNodeId),
        afterFindingId: afterFinding.id,
        afterSeverity: afterFinding.severity,
        changedFields,
      });
    } else {
      result.unchanged += 1;
    }
  }

  for (const finding of afterFindings) {
    const beforeNodeId = afterToBefore.get(finding.nodeRef);
    if (beforeNodeId === undefined) {
      result.unlinked.current.push(findingEntry(finding, "unlinked", null, finding.nodeRef));
      continue;
    }
    if (!beforeByKey.has(findingKey(finding.ruleId, beforeNodeId))) {
      result.added.push(findingEntry(finding, "added", null, finding.nodeRef));
    }
  }

  sortDiagnosticEntries(result);
  return result;
}

function findingEntry(finding, status, beforeNodeId, afterNodeId) {
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    status,
    beforeNodeId,
    afterNodeId,
    beforeFindingId: beforeNodeId === null ? null : finding.id,
    afterFindingId: afterNodeId === null ? null : finding.id,
    changedFields: [],
  };
}

function diffHotspots(beforeHotspots, afterHotspots, beforeToAfter, afterToBefore) {
  const beforeByKey = new Map(flattenHotspotReasons(beforeHotspots).map((entry) => [hotspotKey(entry), entry]));
  const afterByKey = new Map(flattenHotspotReasons(afterHotspots).map((entry) => [hotspotKey(entry), entry]));
  const result = emptyHotspotDiff();

  for (const entry of beforeByKey.values()) {
    const afterNodeId = beforeToAfter.get(entry.nodeId);
    if (afterNodeId === undefined) {
      result.unlinked.baseline.push(hotspotEntry(entry, "unlinked", entry.nodeId, null));
      continue;
    }
    const counterpart = afterByKey.get(findingKey(entry.reasonCode, afterNodeId));
    if (counterpart === undefined) {
      result.resolved.push(hotspotEntry(entry, "resolved", entry.nodeId, null));
      continue;
    }
    const changedFields = changedTopLevelFields(entry.evidence, counterpart.evidence);
    const hotspotChangedFields = changedTopLevelFields(entry.hotspotEvidence, counterpart.hotspotEvidence);
    const levelChanged = entry.level !== counterpart.level;
    if (changedFields.length > 0 || hotspotChangedFields.length > 0 || levelChanged) {
      result.evidenceChanged.push({
        ...hotspotEntry(entry, "evidence-changed", entry.nodeId, afterNodeId),
        afterHotspotId: counterpart.hotspotId,
        afterLevel: counterpart.level,
        levelChanged,
        changedFields: [...new Set([...changedFields, ...hotspotChangedFields])].sort(),
      });
    } else {
      result.unchanged += 1;
    }
  }

  for (const entry of afterByKey.values()) {
    const beforeNodeId = afterToBefore.get(entry.nodeId);
    if (beforeNodeId === undefined) {
      result.unlinked.current.push(hotspotEntry(entry, "unlinked", null, entry.nodeId));
      continue;
    }
    if (!beforeByKey.has(findingKey(entry.reasonCode, beforeNodeId))) {
      result.added.push(hotspotEntry(entry, "added", null, entry.nodeId));
    }
  }

  sortDiagnosticEntries(result);
  return result;
}

function flattenHotspotReasons(hotspots) {
  const entries = [];
  for (const hotspot of hotspots) {
    for (const reason of hotspot.reasons ?? []) {
      entries.push({
        hotspotId: hotspot.id,
        nodeId: hotspot.nodeId,
        nodeType: hotspot.nodeType,
        relation: hotspot.relation ?? null,
        reasonCode: reason.code,
        level: reason.level,
        evidence: reason.evidence ?? {},
        hotspotEvidence: hotspot.evidence ?? {},
      });
    }
  }
  return entries;
}

function hotspotEntry(entry, status, beforeNodeId, afterNodeId) {
  return {
    reasonCode: entry.reasonCode,
    level: entry.level,
    status,
    beforeNodeId,
    afterNodeId,
    beforeHotspotId: beforeNodeId === null ? null : entry.hotspotId,
    afterHotspotId: afterNodeId === null ? null : entry.hotspotId,
    levelChanged: false,
    changedFields: [],
  };
}

function sortDiagnosticEntries(diff) {
  for (const key of ["added", "resolved", "evidenceChanged"]) {
    diff[key].sort((left, right) =>
      compareIds(left.beforeNodeId ?? "", right.beforeNodeId ?? "") ||
      compareIds(left.afterNodeId ?? "", right.afterNodeId ?? "") ||
      diagnosticCode(left).localeCompare(diagnosticCode(right)));
  }
  for (const side of ["baseline", "current"]) {
    diff.unlinked[side].sort((left, right) =>
      compareIds(left.beforeNodeId ?? left.afterNodeId ?? "", right.beforeNodeId ?? right.afterNodeId ?? "") ||
      diagnosticCode(left).localeCompare(diagnosticCode(right)));
  }
}

function diagnosticCode(entry) {
  return entry.ruleId ?? entry.reasonCode ?? "";
}

function findingKey(ruleId, nodeId) {
  return `${ruleId}\u0000${nodeId}`;
}

function hotspotKey(entry) {
  return findingKey(entry.reasonCode, entry.nodeId);
}

/* --------------------------------------------------------------- helpers -- */

function normalizeSource(value) {
  if (!isRecord(value)) return null;
  const source = {};
  for (const key of SOURCE_KEYS) {
    if (typeof value[key] === "string" && value[key].length > 0) source[key] = value[key];
  }
  return Object.keys(source).length > 0 ? source : null;
}

function sourceKey(source) {
  if (source === null) return null;
  return JSON.stringify([source.databaseName ?? null, source.schema ?? null]);
}

function changedTopLevelFields(left, right) {
  if (!isRecord(left) || !isRecord(right)) {
    return stableJson(left) === stableJson(right) ? [] : ["value"];
  }
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.filter((key) => stableJson(left[key]) !== stableJson(right[key]));
}

function stableJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function safeDelta(before, after) {
  if (!isFiniteNumber(before) || !isFiniteNumber(after)) return null;
  const delta = after - before;
  return Number.isFinite(delta) ? delta : null;
}

function textOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function compareIds(left, right) {
  return left.localeCompare(right, "en", { numeric: true });
}

function compareIdLists(left, right) {
  return left.join("\u0000").localeCompare(right.join("\u0000"), "en", { numeric: true });
}
