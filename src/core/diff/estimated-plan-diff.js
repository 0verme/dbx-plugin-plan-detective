/**
 * Conservative, pure matching and field comparison for structured Estimated Plans.
 *
 * Node ids are returned only as per-plan locators. Cross-plan identity is based
 * on relation name / alias plus available schema evidence for scans, then on
 * the set of already matched descendant scans for operators. Cost and row
 * estimates never participate in identity. Ambiguous candidates are kept
 * explicit rather than paired by order.
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
  ["relation.schema", (node, database) => relationSchema(node, database)],
  ["relation.alias", (node) => node.relation?.alias ?? null],
  ["relation.indexName", (node) => node.relation?.indexName ?? null],
  ["estimatedRows", (node) => node.estimatedRows],
  ["filter", (node) => node.filter],
  ["joinType", (node) => node.joinType],
  ["joinCondition", (node) => node.joinCondition],
  ["indexCondition", (node) => node.indexCondition],
  ["sortKeys", (node) => node.sortKeys],
  ["groupKeys", (node) => node.groupKeys],
  // MySQL reports optimizer conclusions such as "Impossible WHERE" here; the
  // value is engine-owned evidence, so the neutral diff reports it verbatim
  // instead of hiding a changed conclusion behind an empty change list.
  ["engineSpecific.mysql.message", (node, database) => (
    database === "mysql" ? node.engineSpecific?.mysql?.message ?? null : null
  )],
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
  const beforeSubplanContexts = collectSubplanContexts(beforePlan.root, beforePlan.database);
  const afterSubplanContexts = collectSubplanContexts(afterPlan.root, afterPlan.database);
  const beforeSubplanIdentityTokens = collectSubplanIdentityTokens(
    beforePlan.root, beforePlan.database, beforeSubplanContexts,
  );
  const afterSubplanIdentityTokens = collectSubplanIdentityTokens(
    afterPlan.root, afterPlan.database, afterSubplanContexts,
  );
  const matches = [];
  const matchedBefore = new Set();
  const matchedAfter = new Set();
  const ambiguousBefore = new Set();
  const ambiguousAfter = new Set();
  const beforeScanTokens = new Map();
  const afterScanTokens = new Map();
  const ambiguities = [];
  const scanMatches = [];

  matchRelationScans({
    database: beforePlan.database,
    beforeNodes,
    afterNodes,
    beforeSubplanContexts,
    afterSubplanContexts,
    beforeSubplanIdentityTokens,
    afterSubplanIdentityTokens,
    beforeScanTokens,
    afterScanTokens,
    matchedBefore,
    matchedAfter,
    ambiguousBefore,
    ambiguousAfter,
    matches,
    ambiguities,
    scanMatches,
  });

  const bitmapIndexSupport = matchBitmapIndexScans({
    scanMatches,
    beforeScanTokens,
    afterScanTokens,
    matchedBefore,
    matchedAfter,
    ambiguousBefore,
    ambiguousAfter,
    matches,
    ambiguities,
    database: beforePlan.database,
  });

  const beforeLineage = collectLineage(beforePlan.root, beforeScanTokens, ambiguousBefore, bitmapIndexSupport.baseline);
  const afterLineage = collectLineage(afterPlan.root, afterScanTokens, ambiguousAfter, bitmapIndexSupport.current);
  matchNonScanNodes({
    beforeNodes,
    afterNodes,
    database: beforePlan.database,
    beforeSubplanContexts,
    afterSubplanContexts,
    beforeSubplanIdentityTokens,
    afterSubplanIdentityTokens,
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

/**
 * MySQL structural keys that open a new query scope. V1 plans keep the raw key
 * in `engineSpecific.mysql.structure`; `selectId` identifies the block when the
 * server provides it. V2 access-path nodes never use these keys.
 */
const MYSQL_QUERY_SCOPE_STRUCTURES = new Set([
  "query_block",
  "union_result",
  "unary_result",
  "intersect_result",
  "except_result",
  "attached_subqueries",
  "optimized_away_subqueries",
  "group_by_subqueries",
  "having_subqueries",
  "order_by_subqueries",
  "select_list_subqueries",
  "materialized_from_subquery",
]);

/**
 * Independent MySQL branches whose identity must reach ancestors, mirroring
 * PostgreSQL's InitPlan / SubPlan boundaries: a changed subquery role or set
 * operation must break every enclosing operator key, not just its own node.
 */
const MYSQL_BRANCH_STRUCTURES = new Set([
  "union_result",
  "unary_result",
  "intersect_result",
  "except_result",
  "attached_subqueries",
  "optimized_away_subqueries",
  "group_by_subqueries",
  "having_subqueries",
  "order_by_subqueries",
  "select_list_subqueries",
  "materialized_from_subquery",
]);

/**
 * Preserve PostgreSQL's independent InitPlan / SubPlan boundaries and MySQL's
 * query-block / subquery boundaries as identity context for every descendant.
 * Ordinary Outer / Inner relationships are intentionally excluded because join
 * inputs may be reordered.
 * @param {object} root
 * @param {string} database
 */
function collectSubplanContexts(root, database) {
  const contexts = new Map();
  function visit(node, inherited) {
    const context = database === "postgresql"
      ? postgresContext(node, inherited)
      : database === "mysql"
        ? mysqlContext(node, inherited)
        : inherited;
    contexts.set(node, JSON.stringify(context));
    for (const child of node.children) visit(child, context);
  }
  visit(root, []);
  return contexts;
}

/** @param {object} node @param {Array} inherited */
function postgresContext(node, inherited) {
  const relationship = node.engineSpecific?.parentRelationship;
  if (relationship !== "InitPlan" && relationship !== "SubPlan") return inherited;
  const subplanName = typeof node.engineSpecific?.subplanName === "string" ? node.engineSpecific.subplanName : null;
  return [...inherited, [relationship, subplanName]];
}

/**
 * A MySQL query block or set operation starts a scope for its descendants, so
 * a relation scan moved between the top-level block and an attached, optimized
 * away, or materialized subquery no longer shares a context. The raw structure
 * is kept as fallback evidence when `select_id` is missing.
 * @param {object} node @param {Array} inherited
 */
function mysqlContext(node, inherited) {
  const structure = node.engineSpecific?.mysql?.structure;
  if (typeof structure !== "string" || !MYSQL_QUERY_SCOPE_STRUCTURES.has(structure)) return inherited;
  const selectId = node.engineSpecific?.mysql?.selectId;
  return [
    ...inherited,
    [structure, typeof selectId === "number" && Number.isFinite(selectId) ? selectId : null],
  ];
}

/**
 * Collect each independent subplan / branch's identity evidence for its
 * ancestors. Relation-scan lineage alone cannot see no-scan PostgreSQL
 * InitPlan / SubPlan or MySQL subquery / set-operation branches.
 * @param {object} root
 * @param {string} database
 * @param {Map<object, string>} subplanContexts
 */
function collectSubplanIdentityTokens(root, database, subplanContexts) {
  const identities = new Map();
  function visit(node) {
    const descendants = node.children.flatMap(visit);
    const relationship = database === "postgresql" ? node.engineSpecific?.parentRelationship : null;
    const isPostgresSubplan = relationship === "InitPlan" || relationship === "SubPlan";
    const isMySqlBranch = database === "mysql"
      && MYSQL_BRANCH_STRUCTURES.has(node.engineSpecific?.mysql?.structure);
    const ownIdentity = isPostgresSubplan || isMySqlBranch
      ? JSON.stringify([
          subplanContexts.get(node) ?? "[]",
          semanticFingerprint(node, database, subplanContexts),
        ])
      : null;
    const tokens = [...descendants, ...(ownIdentity === null ? [] : [ownIdentity])].sort();
    identities.set(node, tokens);
    return tokens;
  }
  visit(root);
  return identities;
}

/** @param {object} node */
function isScan(node) {
  return SCAN_KINDS.has(node.kind);
}

/** @param {object} node */
function hasRelationIdentity(node) {
  return typeof node.relation?.name === "string" && node.relation.name.trim().length > 0;
}

/**
 * Read database-owned schema evidence without inferring a default schema.
 * PostgreSQL's raw `Schema` property is preserved in `engineSpecific.extra`;
 * MySQL V2 exposes `schema_name` as `engineSpecific.mysql.schemaName`.
 * @param {object} node
 * @param {string} database
 */
function relationSchema(node, database) {
  const schema = database === "postgresql"
    ? node.engineSpecific?.extra?.Schema
    : database === "mysql"
      ? node.engineSpecific?.mysql?.schemaName
      : null;
  return typeof schema === "string" && schema.trim().length > 0 ? schema : null;
}

/** @param {object[]} nodes */
function groupRelationScans(nodes, database, subplanContexts, subplanIdentityTokens) {
  const groups = new Map();
  for (const node of nodes) {
    if (!isScan(node) || !hasRelationIdentity(node)) continue;
    const key = JSON.stringify([
      node.relation.name,
      node.relation.alias ?? null,
      relationSchema(node, database),
      subplanContexts.get(node) ?? "[]",
      subplanIdentityTokens.get(node) ?? [],
    ]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return groups;
}

function matchRelationScans(context) {
  const {
    database, beforeNodes, afterNodes, beforeSubplanContexts, afterSubplanContexts,
    beforeSubplanIdentityTokens, afterSubplanIdentityTokens,
    beforeScanTokens, afterScanTokens, matchedBefore, matchedAfter,
    ambiguousBefore, ambiguousAfter, matches, ambiguities,
  } = context;
  const beforeGroups = groupRelationScans(
    beforeNodes, database, beforeSubplanContexts, beforeSubplanIdentityTokens,
  );
  const afterGroups = groupRelationScans(
    afterNodes, database, afterSubplanContexts, afterSubplanIdentityTokens,
  );

  // First use the strongest key: exact relation name, alias, and available schema.
  // Operator kind (so Seq -> Index remains matchable) and index are not identity.
  const exactKeys = [...beforeGroups.keys()].filter((key) => afterGroups.has(key)).sort();
  for (const key of exactKeys) {
    const before = beforeGroups.get(key);
    const after = afterGroups.get(key);
    if (before.length === 1 && after.length === 1) {
      addScanMatch(before[0], after[0], "qualified-relation-name-and-alias", context);
    }
  }

  // If aliases changed, relation name is a safe fallback only when exactly one
  // unmatched occurrence remains on each side. Repeated/self-join occurrences
  // are never disambiguated by child order, path, rows, or cost.
  const beforeByIdentity = remainingScansByIdentity(
    beforeNodes, matchedBefore, database, beforeSubplanContexts, beforeSubplanIdentityTokens,
  );
  const afterByIdentity = remainingScansByIdentity(
    afterNodes, matchedAfter, database, afterSubplanContexts, afterSubplanIdentityTokens,
  );
  const identities = [...new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()])].sort();
  for (const identity of identities) {
    const before = beforeByIdentity.get(identity) ?? [];
    const after = afterByIdentity.get(identity) ?? [];
    if (before.length === 1 && after.length === 1) {
      addScanMatch(before[0], after[0], "unique-qualified-relation-name", context);
    } else if (before.length > 0 && after.length > 0 && (before.length > 1 || after.length > 1)) {
      addAmbiguity(before, after, "REPEATED_RELATION_IDENTITY", "qualified-relation-name", context);
    }
  }
}

function remainingScansByIdentity(nodes, matched, database, subplanContexts, subplanIdentityTokens) {
  const groups = new Map();
  for (const node of nodes) {
    if (!isScan(node) || matched.has(node) || !hasRelationIdentity(node)) continue;
    const identity = JSON.stringify([
      node.relation.name,
      relationSchema(node, database),
      subplanContexts.get(node) ?? "[]",
      subplanIdentityTokens.get(node) ?? [],
    ]);
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(node);
  }
  return groups;
}

function addScanMatch(before, after, method, context) {
  const name = before.relation.name;
  const schema = relationSchema(before, context.database);
  const beforeSubplanContext = context.beforeSubplanContexts.get(before) ?? "[]";
  const afterSubplanContext = context.afterSubplanContexts.get(after) ?? "[]";
  const token = JSON.stringify([
    "matched-relation",
    name,
    schema,
    before.relation.alias ?? null,
    after.relation.alias ?? null,
    beforeSubplanContext,
    afterSubplanContext,
  ]);
  context.beforeScanTokens.set(before, token);
  context.afterScanTokens.set(after, token);
  context.scanMatches.push({ before, after });
  addMatch(before, after, {
    method,
    reason: method === "qualified-relation-name-and-alias"
      ? "Relation name, alias, and available schema evidence uniquely identify this scan in both plans."
      : "This relation and available schema evidence occur once among the remaining scan candidates in both plans.",
  }, context);
}

function matchBitmapIndexScans(context) {
  const baseline = new Set();
  const current = new Set();
  const heapPairs = context.scanMatches.filter(({ before, after }) =>
    before.kind === "bitmap_heap_scan" && after.kind === "bitmap_heap_scan");

  for (const { before: beforeHeap, after: afterHeap } of heapPairs) {
    const beforeIndexes = descendantBitmapIndexScans(beforeHeap)
      .filter((node) => !hasRelationIdentity(node) && !baseline.has(node));
    const afterIndexes = descendantBitmapIndexScans(afterHeap)
      .filter((node) => !hasRelationIdentity(node) && !current.has(node));
    if (beforeIndexes.length === 1 && afterIndexes.length === 1) {
      const beforeIndex = beforeIndexes[0];
      const afterIndex = afterIndexes[0];
      const parentToken = context.beforeScanTokens.get(beforeHeap);
      const token = JSON.stringify(["bitmap-index-under-matched-heap", parentToken]);
      context.beforeScanTokens.set(beforeIndex, token);
      context.afterScanTokens.set(afterIndex, token);
      addMatch(beforeIndex, afterIndex, {
        method: "matched-bitmap-heap-descendant",
        reason: "A unique Bitmap Index Scan descendant is paired through the same uniquely matched Bitmap Heap Scan relation.",
      }, context);
      if (context.matchedBefore.has(beforeIndex) && context.matchedAfter.has(afterIndex)) {
        baseline.add(beforeIndex);
        current.add(afterIndex);
      }
    } else if (
      beforeIndexes.length > 0 && afterIndexes.length > 0 &&
      (beforeIndexes.length > 1 || afterIndexes.length > 1)
    ) {
      addAmbiguity(
        beforeIndexes,
        afterIndexes,
        "NON_UNIQUE_STRUCTURAL_IDENTITY",
        "matched-bitmap-heap-descendant",
        context,
      );
    }
  }

  return { baseline, current };
}

function descendantBitmapIndexScans(heapScan) {
  const scans = [];
  function visit(node) {
    for (const child of node.children) {
      if (child.kind === "bitmap_index_scan") scans.push(child);
      visit(child);
    }
  }
  visit(heapScan);
  return scans;
}

function matchNonScanNodes(context) {
  const {
    database, beforeNodes, afterNodes, beforeSubplanContexts, afterSubplanContexts,
    beforeSubplanIdentityTokens, afterSubplanIdentityTokens,
    beforeLineage, afterLineage, matchedBefore, matchedAfter,
    ambiguousBefore, ambiguousAfter, matches, ambiguities,
  } = context;
  const beforeGroups = groupNonScanCandidates(
    beforeNodes, beforeLineage, matchedBefore, database,
    beforeSubplanContexts, beforeSubplanIdentityTokens,
  );
  const afterGroups = groupNonScanCandidates(
    afterNodes, afterLineage, matchedAfter, database,
    afterSubplanContexts, afterSubplanIdentityTokens,
  );
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
            reason: "The semantic subtree, including available relation schema, excluding ids, estimated rows, and costs is identical and unique.",
          };
      addMatch(before[0], after[0], evidence, context);
    } else if (before.length > 0 && after.length > 0 && (before.length > 1 || after.length > 1)) {
      const info = beforeLineage.get(before[0]);
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

function groupNonScanCandidates(
  nodes, lineage, alreadyMatched, database, subplanContexts, subplanIdentityTokens,
) {
  const groups = new Map();
  for (const node of nodes) {
    if (isScan(node) || alreadyMatched.has(node)) continue;
    const info = lineage.get(node);
    if (info === undefined || !info.complete) continue;

    let key;
    if (info.scanCount > 0) {
      const tokens = [...info.tokens].sort();
      key = JSON.stringify([
        "descendant-scans",
        identityFamily(node),
        tokens,
        subplanIdentityTokens.get(node) ?? [],
      ]);
    } else {
      key = JSON.stringify([
        "semantic-subtree",
        semanticFingerprint(node, database, subplanContexts),
      ]);
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return groups;
}

function collectLineage(root, scanTokens, ambiguousScans, bitmapIndexSupportScans) {
  const lineage = new Map();
  function visit(node) {
    const childInfo = node.children.map(visit);
    const ownScan = isScan(node);
    const ownIdentityScan = ownScan && hasRelationIdentity(node);
    const ownToken = ownScan ? scanTokens.get(node) : undefined;
    const ownUnanchoredScan = ownScan && !ownIdentityScan && !bitmapIndexSupportScans.has(node);
    const scanCount = (ownScan ? 1 : 0) + childInfo.reduce((sum, child) => sum + child.scanCount, 0);
    const identityScanCount = (ownIdentityScan ? 1 : 0) + childInfo.reduce((sum, child) => sum + child.identityScanCount, 0);
    const matchedIdentityScanCount = (ownIdentityScan && ownToken !== undefined ? 1 : 0) + childInfo.reduce((sum, child) => sum + child.matchedIdentityScanCount, 0);
    const unanchoredScanCount = (ownUnanchoredScan ? 1 : 0) + childInfo.reduce((sum, child) => sum + child.unanchoredScanCount, 0);
    const tokens = [
      ...(ownToken === undefined ? [] : [ownToken]),
      ...childInfo.flatMap((child) => child.tokens),
    ];
    // Anonymous scans may be ignored only when they are a Bitmap Index Scan
    // beneath a uniquely matched Bitmap Heap Scan. Independent anonymous scans
    // (such as Function Scan) keep the entire ancestor lineage incomplete.
    const complete = identityScanCount > 0
      ? matchedIdentityScanCount === identityScanCount && unanchoredScanCount === 0
      : scanCount === 0;
    const ambiguous = (ownScan && ambiguousScans.has(node)) || childInfo.some((child) => child.ambiguous);
    const info = { scanCount, identityScanCount, matchedIdentityScanCount, unanchoredScanCount, tokens, complete, ambiguous };
    lineage.set(node, info);
    return info;
  }
  visit(root);
  return lineage;
}

/**
 * Stable semantic fingerprint for subtrees that contain no relation scans.
 * Estimates, costs, ids, index names, and unrelated engine-specific evidence
 * are omitted. PostgreSQL independent-subplan context is retained per node so
 * role/name changes also invalidate every enclosing no-scan fingerprint.
 * Child order is retained as structural evidence, but never used to pair siblings.
 * @param {object} node
 * @param {string} database
 * @param {Map<object, string>} subplanContexts
 */
function semanticFingerprint(node, database, subplanContexts) {
  return [
    node.kind,
    node.nodeType,
    subplanContexts.get(node) ?? "[]",
    node.relation === null ? null : [node.relation.name, relationSchema(node, database), node.relation.alias],
    node.filter,
    node.joinType,
    node.joinCondition,
    node.indexCondition,
    node.sortKeys,
    node.groupKeys,
    node.children.map((child) => semanticFingerprint(child, database, subplanContexts)),
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
    changes: collectChanges(before, after, context.database),
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

function collectChanges(before, after, database) {
  const changes = [];
  for (const [field, getValue] of CHANGE_FIELDS) {
    const beforeValue = getValue(before, database);
    const afterValue = getValue(after, database);
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
      if (isScan(node) && !hasRelationIdentity(node)) {
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
