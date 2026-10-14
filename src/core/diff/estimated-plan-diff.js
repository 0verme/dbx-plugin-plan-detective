/**
 * Conservative, pure matching and field comparison for structured Estimated Plans.
 *
 * Node ids are returned only as per-plan locators. Cross-plan identity is based
 * on unique relation name / alias for scans, then on the set of already matched
 * descendant scans for operators. Cost and row estimates never participate in
 * identity. Ambiguous candidates are kept explicit rather than paired by order.
 */

const SUPPORTED_DATABASES = new Set(["postgresql", "mysql"]);
const SCAN_KINDS = new Set([
  "seq_scan",
  "index_scan",
  "index_only_scan",
  "bitmap_heap_scan",
  "bitmap_index_scan",
  "tid_scan",
  "sample_scan",
  "values_scan",
  "function_scan",
  "table_function_scan",
  "cte_scan",
  "worktable_scan",
  "const_scan",
]);
const JOIN_KINDS = new Set(["nested_loop", "hash_join", "merge_join", "join"]);
const SORT_KINDS = new Set(["sort", "incremental_sort"]);

const CHANGE_FIELDS = Object.freeze([
  ["operator.kind", (node) => node.kind],
  ["operator.nodeType", (node) => node.nodeType],
  ["relation.name", (node) => node.relation?.name ?? null],
  ["relation.alias", (node) => node.relation?.alias ?? null],
  ["relation.indexName", (node) => node.relation?.indexName ?? null],
  ["estimatedRows", (node) => node.estimatedRows],
  ["filter", (node) => node.filter],
  ["joinType", (node) => node.joinType],
  ["joinCondition", (node) => node.joinCondition],
  ["indexCondition", (node) => node.indexCondition],
  ["sortKeys", (node) => node.sortKeys],
  ["groupKeys", (node) => node.groupKeys],
]);

/**
 * Compare two structured analyses produced by the current Plan Core.
 *
 * Inputs may be `analyzeRawPlan()` results, `analyzePlan()` results, or host /
 * snapshot sessions that contain one under `.analysis`. This function does not
 * acquire plans, re-run analysis, or inspect raw payloads.
 *
 * @param {unknown} baseline
 * @param {unknown} current
 * @returns {object} A JSON-serializable comparison result.
 */
export function diffEstimatedPlans(baseline, current) {
  const baselineResult = readAnalysis(baseline);
  if (baselineResult.error !== null) return incompatible(baselineResult.error);
  const currentResult = readAnalysis(current);
  if (currentResult.error !== null) return incompatible(currentResult.error);

  const beforePlan = baselineResult.normalized;
  const afterPlan = currentResult.normalized;

  if (beforePlan.database !== afterPlan.database) return incompatible("DATABASE_MISMATCH");
  if (!SUPPORTED_DATABASES.has(beforePlan.database)) return incompatible("UNSUPPORTED_DATABASE");
  if (beforePlan.format !== "json" || afterPlan.format !== "json") return incompatible("UNSUPPORTED_FORMAT");
  if (beforePlan.mode !== "estimated" || afterPlan.mode !== "estimated") return incompatible("MODE_NOT_ESTIMATED");

  const beforeNodes = flatten(beforePlan.root);
  const afterNodes = flatten(afterPlan.root);
  const matches = [];
  const matchedBefore = new Set();
  const matchedAfter = new Set();
  const ambiguousBefore = new Set();
  const ambiguousAfter = new Set();
  const beforeScanTokens = new Map();
  const afterScanTokens = new Map();
  const ambiguities = [];

  matchRelationScans({
    beforeNodes,
    afterNodes,
    beforeScanTokens,
    afterScanTokens,
    matchedBefore,
    matchedAfter,
    ambiguousBefore,
    ambiguousAfter,
    matches,
    ambiguities,
  });

  const beforeLineage = collectLineage(beforePlan.root, beforeScanTokens, ambiguousBefore);
  const afterLineage = collectLineage(afterPlan.root, afterScanTokens, ambiguousAfter);
  matchNonScanNodes({
    beforeNodes,
    afterNodes,
    beforeLineage,
    afterLineage,
    matchedBefore,
    matchedAfter,
    ambiguousBefore,
    ambiguousAfter,
    matches,
    ambiguities,
  });

  matches.sort((a, b) => compareIds(a.beforeId, b.beforeId) || compareIds(a.afterId, b.afterId));
  ambiguities.sort((a, b) => compareIdLists(a.beforeIds, b.beforeIds) || compareIdLists(a.afterIds, b.afterIds));

  return {
    status: "comparable",
    database: beforePlan.database,
    matches,
    unmatched: {
      baseline: describeUnmatched(beforeNodes, matchedBefore, ambiguousBefore, beforeLineage),
      current: describeUnmatched(afterNodes, matchedAfter, ambiguousAfter, afterLineage),
    },
    ambiguous: ambiguities,
  };
}

/** @param {unknown} value */
function readAnalysis(value) {
  if (!isRecord(value)) return { normalized: null, error: "INVALID_ANALYSIS" };

  // createPlanSnapshotView returns { snapshot, session }; accept either that
  // wrapper or the session itself, without examining the raw snapshot payload.
  if (isRecord(value.session) && value.status === undefined && value.analysis === undefined) {
    value = value.session;
  }

  if (value.truncated === true || value.status === "truncated" || value.hostResult?.truncated === true) {
    return { normalized: null, error: "PLAN_TRUNCATED" };
  }
  if (value.status === "raw-only") return { normalized: null, error: "RAW_ONLY" };
  if (value.status === "error") return { normalized: null, error: "ANALYSIS_FAILED" };
  if (["idle", "loading", "unsupported"].includes(value.status)) {
    return { normalized: null, error: "ANALYSIS_NOT_READY" };
  }
  if (value.status !== undefined && value.status !== "structured") {
    return { normalized: null, error: "INVALID_ANALYSIS" };
  }

  const analysis = isRecord(value.analysis) ? value.analysis : value;
  if (analysis.status === "raw-only") return { normalized: null, error: "RAW_ONLY" };
  if (analysis.status !== undefined && analysis.status !== "structured") {
    return { normalized: null, error: analysis.status === "error" ? "ANALYSIS_FAILED" : "INVALID_ANALYSIS" };
  }
  const normalized = analysis.normalized;
  if (!isRecord(normalized)) return { normalized: null, error: "ANALYSIS_NOT_STRUCTURED" };
  if (!isValidNormalizedPlan(normalized)) return { normalized: null, error: "INVALID_NORMALIZED_PLAN" };
  return { normalized, error: null };
}

/**
 * Validate only the normalized fields this matcher reads or returns. Keeping
 * this boundary small also ensures all output values can be JSON serialized.
 * @param {Record<string, any>} plan
 */
function isValidNormalizedPlan(plan) {
  if (typeof plan.database !== "string" || typeof plan.mode !== "string" || typeof plan.format !== "string") return false;
  const ids = new Set();
  const seen = new Set();

  /** @param {unknown} node */
  function visit(node) {
    if (!isRecord(node) || seen.has(node)) return false;
    seen.add(node);
    if (
      typeof node.id !== "string" || node.id.length === 0 || ids.has(node.id) ||
      typeof node.kind !== "string" || typeof node.nodeType !== "string" ||
      !isNullableFiniteNumber(node.estimatedRows) ||
      !isNullableFiniteNumber(node.startupCost) ||
      !isNullableFiniteNumber(node.totalCost) ||
      !isNullableString(node.filter) || !isNullableString(node.joinType) ||
      !isNullableString(node.joinCondition) || !isNullableString(node.indexCondition) ||
      !isNullableStringArray(node.sortKeys) || !isNullableStringArray(node.groupKeys) ||
      !Array.isArray(node.children)
    ) return false;
    ids.add(node.id);

    if (node.relation !== null) {
      if (!isRecord(node.relation)) return false;
      if (!isNullableString(node.relation.name) || !isNullableString(node.relation.alias) || !isNullableString(node.relation.indexName)) return false;
    }
    for (const child of node.children) {
      if (!visit(child)) return false;
    }
    return true;
  }

  return visit(plan.root);
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
function isNullableString(value) {
  return value === null || typeof value === "string";
}

/** @param {unknown} value */
function isNullableFiniteNumber(value) {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

/** @param {unknown} value */
function isNullableStringArray(value) {
  return value === null || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

/** @param {object} root */
function flatten(root) {
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    for (const child of node.children) visit(child);
  }
  visit(root);
  return nodes;
}

/** @param {object} node */
function isScan(node) {
  return SCAN_KINDS.has(node.kind);
}

/** @param {object[]} nodes */
function groupRelationScans(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    if (!isScan(node) || typeof node.relation?.name !== "string" || node.relation.name.trim().length === 0) continue;
    const key = JSON.stringify([node.relation.name, node.relation.alias ?? null]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return groups;
}

function matchRelationScans(context) {
  const {
    beforeNodes, afterNodes, beforeScanTokens, afterScanTokens,
    matchedBefore, matchedAfter, ambiguousBefore, ambiguousAfter, matches, ambiguities,
  } = context;
  const beforeGroups = groupRelationScans(beforeNodes);
  const afterGroups = groupRelationScans(afterNodes);

  // First use the strongest key: exact relation name and alias. Neither the
  // operator kind (so Seq -> Index remains matchable) nor its index is identity.
  const exactKeys = [...beforeGroups.keys()].filter((key) => afterGroups.has(key)).sort();
  for (const key of exactKeys) {
    const before = beforeGroups.get(key);
    const after = afterGroups.get(key);
    if (before.length === 1 && after.length === 1) {
      addScanMatch(before[0], after[0], "relation-name-and-alias", context);
    }
  }

  // If aliases changed, relation name is a safe fallback only when exactly one
  // unmatched occurrence remains on each side. Repeated/self-join occurrences
  // are never disambiguated by child order, path, rows, or cost.
  const beforeByName = remainingScansByName(beforeNodes, matchedBefore);
  const afterByName = remainingScansByName(afterNodes, matchedAfter);
  const relationNames = [...new Set([...beforeByName.keys(), ...afterByName.keys()])].sort();
  for (const name of relationNames) {
    const before = beforeByName.get(name) ?? [];
    const after = afterByName.get(name) ?? [];
    if (before.length === 1 && after.length === 1) {
      addScanMatch(before[0], after[0], "unique-relation-name", context);
    } else if (before.length > 1 || after.length > 1) {
      addAmbiguity(before, after, "REPEATED_RELATION_IDENTITY", "relation-name", context);
    }
  }
}

function remainingScansByName(nodes, matched) {
  const groups = new Map();
  for (const node of nodes) {
    if (!isScan(node) || matched.has(node) || typeof node.relation?.name !== "string" || node.relation.name.trim().length === 0) continue;
    if (!groups.has(node.relation.name)) groups.set(node.relation.name, []);
    groups.get(node.relation.name).push(node);
  }
  return groups;
}

function addScanMatch(before, after, method, context) {
  const name = before.relation.name;
  const token = JSON.stringify(["matched-relation", name, before.relation.alias ?? null, after.relation.alias ?? null]);
  context.beforeScanTokens.set(before, token);
  context.afterScanTokens.set(after, token);
  addMatch(before, after, {
    method,
    reason: method === "relation-name-and-alias"
      ? "Relation name and alias uniquely identify this scan in both plans."
      : "This relation occurs once among the remaining scan candidates in both plans.",
  }, context);
}

function matchNonScanNodes(context) {
  const {
    beforeNodes, afterNodes, beforeLineage, afterLineage,
    matchedBefore, matchedAfter, ambiguousBefore, ambiguousAfter, matches, ambiguities,
  } = context;
  const beforeGroups = groupNonScanCandidates(beforeNodes, beforeLineage, matchedBefore);
  const afterGroups = groupNonScanCandidates(afterNodes, afterLineage, matchedAfter);
  const keys = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])].sort();

  for (const key of keys) {
    const before = beforeGroups.get(key) ?? [];
    const after = afterGroups.get(key) ?? [];
    if (before.length === 1 && after.length === 1) {
      const beforeInfo = beforeLineage.get(before[0]);
      const evidence = beforeInfo.scanCount > 0
        ? {
            method: "descendant-scan-set",
            reason: "Operator family and the set of uniquely matched descendant scans are unique; child order is not used.",
          }
        : {
            method: "exact-semantic-subtree",
            reason: "The semantic subtree excluding ids, estimated rows, and costs is identical and unique.",
          };
      addMatch(before[0], after[0], evidence, context);
    } else if (before.length > 1 || after.length > 1) {
      const info = before.length > 0 ? beforeLineage.get(before[0]) : afterLineage.get(after[0]);
      addAmbiguity(
        before,
        after,
        "NON_UNIQUE_STRUCTURAL_IDENTITY",
        info?.scanCount > 0 ? "descendant-scan-set" : "exact-semantic-subtree",
        context,
      );
    }
  }
}

function groupNonScanCandidates(nodes, lineage, alreadyMatched) {
  const groups = new Map();
  for (const node of nodes) {
    if (isScan(node) || alreadyMatched.has(node)) continue;
    const info = lineage.get(node);
    if (info === undefined || !info.complete) continue;

    let key;
    if (info.scanCount > 0) {
      const tokens = [...info.tokens].sort();
      key = JSON.stringify(["descendant-scans", identityFamily(node), tokens]);
    } else {
      key = JSON.stringify(["semantic-subtree", semanticFingerprint(node)]);
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return groups;
}

function collectLineage(root, scanTokens, ambiguousScans) {
  const lineage = new Map();
  function visit(node) {
    const childInfo = node.children.map(visit);
    const ownScan = isScan(node);
    const ownToken = ownScan ? scanTokens.get(node) : undefined;
    const scanCount = (ownScan ? 1 : 0) + childInfo.reduce((sum, child) => sum + child.scanCount, 0);
    const tokens = [
      ...(ownToken === undefined ? [] : [ownToken]),
      ...childInfo.flatMap((child) => child.tokens),
    ];
    const complete = (ownScan ? ownToken !== undefined : true) && childInfo.every((child) => child.complete);
    const ambiguous = (ownScan && ambiguousScans.has(node)) || childInfo.some((child) => child.ambiguous);
    const info = { scanCount, tokens, complete, ambiguous };
    lineage.set(node, info);
    return info;
  }
  visit(root);
  return lineage;
}

/**
 * Stable semantic fingerprint for subtrees that contain no relation scans.
 * Estimates, costs, ids, index names, and engine-specific evidence are omitted.
 * Child order is retained as structural evidence, but never used to pair siblings.
 * @param {object} node
 */
function semanticFingerprint(node) {
  return [
    node.kind,
    node.nodeType,
    node.relation === null ? null : [node.relation.name, node.relation.alias],
    node.filter,
    node.joinType,
    node.joinCondition,
    node.indexCondition,
    node.sortKeys,
    node.groupKeys,
    node.children.map(semanticFingerprint),
  ];
}

/** @param {object} node */
function identityFamily(node) {
  if (JOIN_KINDS.has(node.kind)) return "join";
  if (SORT_KINDS.has(node.kind)) return "sort";
  if (node.kind === "unknown") return `unknown:${node.nodeType}`;
  return node.kind;
}

function addMatch(before, after, evidence, context) {
  if (context.matchedBefore.has(before) || context.matchedAfter.has(after)) return;
  context.matchedBefore.add(before);
  context.matchedAfter.add(after);
  context.matches.push({
    beforeId: before.id,
    afterId: after.id,
    evidence,
    changes: collectChanges(before, after),
  });
}

function addAmbiguity(before, after, reasonCode, method, context) {
  const beforeNodes = before.filter((node) => !context.matchedBefore.has(node));
  const afterNodes = after.filter((node) => !context.matchedAfter.has(node));
  if (beforeNodes.length === 0 && afterNodes.length === 0) return;
  for (const node of beforeNodes) context.ambiguousBefore.add(node);
  for (const node of afterNodes) context.ambiguousAfter.add(node);
  context.ambiguities.push({
    beforeIds: beforeNodes.map((node) => node.id).sort(compareIds),
    afterIds: afterNodes.map((node) => node.id).sort(compareIds),
    reasonCode,
    evidence: { method },
  });
}

function collectChanges(before, after) {
  const changes = [];
  for (const [field, getValue] of CHANGE_FIELDS) {
    const beforeValue = getValue(before);
    const afterValue = getValue(after);
    if (!sameValue(beforeValue, afterValue)) changes.push({ field, before: beforeValue, after: afterValue });
  }
  return changes;
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

function describeUnmatched(nodes, matched, ambiguous, lineage) {
  return nodes
    .filter((node) => !matched.has(node) && !ambiguous.has(node))
    .map((node) => {
      let reasonCode = "NO_UNIQUE_COUNTERPART";
      if (isScan(node) && typeof node.relation?.name !== "string") {
        reasonCode = "NO_STABLE_RELATION";
      } else if (!isScan(node)) {
        const info = lineage.get(node);
        if (info?.scanCount > 0 && info.ambiguous) reasonCode = "DESCENDANT_IDENTITY_AMBIGUOUS";
        else if (info?.scanCount > 0 && !info.complete) reasonCode = "DESCENDANT_NOT_MATCHED";
      }
      return { id: node.id, reasonCode };
    })
    .sort((a, b) => compareIds(a.id, b.id));
}

function incompatible(reasonCode) {
  return {
    status: "incompatible",
    reasonCode,
    database: null,
    matches: [],
    unmatched: { baseline: [], current: [] },
    ambiguous: [],
  };
}

function compareIds(left, right) {
  return left.localeCompare(right, "en", { numeric: true });
}

function compareIdLists(left, right) {
  return left.join("\u0000").localeCompare(right.join("\u0000"), "en", { numeric: true });
}
