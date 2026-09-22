/**
 * Dameng estimated EXPLAIN rows -> database-neutral NormalizedPlan.
 *
 * Dameng reports a native `[cost, rows, bytes-per-row]` tuple. The row count
 * and bytes-per-row value are useful neutral estimates, but Dameng `cost` is
 * not PostgreSQL's cumulative `Total Cost`; it remains under
 * `engineSpecific.dameng` and the shared PostgreSQL cost metrics stay disabled.
 *
 * Predicate text is associated with nodes by Dameng operation id in the parser.
 * The raw predicate strings remain visible under `engineSpecific.dameng`; only
 * the clearly named `filter(...)` form is promoted to the neutral `filter`
 * field. Unknown predicate/detail text is never guessed into another field.
 */

const KIND_BY_OPERATOR = Object.freeze({
  NSET2: "result",
  PRJT2: "project",
  SLCT2: "filter",
  CSCN2: "seq_scan",
  CSEK2: "index_scan",
  SSCN: "index_scan",
  SSCN2: "index_scan",
  SSEK2: "index_scan",
  BLKUP2: "lookup",
  HAGR2: "aggregate",
  SAGR2: "aggregate",
  SORT3: "sort",
  HASH2: "hash",
  "UNION ALL": "append",
  UNIONALL: "append",
  DISTINCT: "unique",
  MATERIAL: "materialize",
  MATERIAL2: "materialize",
  LIMIT: "limit",
});

/**
 * @typedef {Object} NormalizedNode
 * @property {string} id stable path id: "0", "0.0", "0.1.0", ...
 * @property {string} kind semantic kind; "unknown" for unclassified operators
 * @property {string} nodeType Dameng operator label
 * @property {{ name: string|null, alias: string|null, indexName: string|null }|null} relation
 * @property {number|null} estimatedRows
 * @property {number|null} actualRows always null for estimated plans
 * @property {number|null} actualStartupTime always null
 * @property {number|null} actualTotalTime always null
 * @property {number|null} loops always null
 * @property {number|null} startupCost always null: Dameng cost is not PostgreSQL cost
 * @property {number|null} totalCost always null
 * @property {number|null} width bytes per output row when reported
 * @property {string|null} filter
 * @property {string|null} joinType
 * @property {string|null} joinCondition
 * @property {string|null} indexCondition
 * @property {string[]|null} sortKeys
 * @property {string[]|null} groupKeys
 * @property {NormalizedNode[]} children
 * @property {Record<string, unknown>} engineSpecific
 *
 * @typedef {Object} NormalizedPlan
 * @property {"dameng"} database
 * @property {"estimated"} mode
 * @property {"text"} format
 * @property {NormalizedNode} root
 * @property {string[]} unknownNodeTypes sorted unique labels that had no kind
 */

/**
 * @param {import("../dameng/parse-text-plan.js").ParsedPlan} parsed
 * @returns {NormalizedPlan}
 */
export function normalizeDamengPlan(parsed) {
  const unknownNodeTypes = new Set();
  const root = normalizeNode(parsed.root, "0", unknownNodeTypes);

  return {
    database: "dameng",
    mode: parsed.mode,
    format: parsed.format,
    root,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  };
}

/**
 * @param {import("../dameng/parse-text-plan.js").ParsedDamengNode} node
 * @param {string} id
 * @param {Set<string>} unknownNodeTypes
 * @returns {NormalizedNode}
 */
function normalizeNode(node, id, unknownNodeTypes) {
  const operator = typeof node.operator === "string" && node.operator.length > 0 ? node.operator : node.nodeType;
  const kind = kindOf(node.nodeType);
  if (kind === "unknown" && operator !== null && operator !== undefined) unknownNodeTypes.add(operator);

  const predicates = Array.isArray(node.predicates) ? [...node.predicates] : null;
  const filter = firstFilterPredicate(predicates);

  return {
    id,
    kind,
    nodeType: node.nodeType,
    relation: relationFromDetail(node.detail),
    estimatedRows: numberOrNull(node.estimatedRows),
    actualRows: null,
    actualStartupTime: null,
    actualTotalTime: null,
    loops: null,
    // Dameng's first tuple value is native cost, not PostgreSQL Total Cost.
    startupCost: null,
    totalCost: null,
    width: numberOrNull(node.bytesPerRow),
    filter,
    joinType: null,
    joinCondition: null,
    indexCondition: null,
    sortKeys: null,
    groupKeys: null,
    children: Array.isArray(node.children)
      ? node.children.map((child, index) => normalizeNode(child, `${id}.${index}`, unknownNodeTypes))
      : [],
    engineSpecific: {
      database: "dameng",
      dameng: {
        id: numberOrNull(node.id),
        operator,
        cost: numberOrNull(node.cost),
        estimatedRows: numberOrNull(node.estimatedRows),
        bytesPerRow: numberOrNull(node.bytesPerRow),
        detail: stringOrNull(node.detail),
        predicates,
      },
      extra: isPlainObject(node.extra) ? { ...node.extra } : {},
    },
  };
}

/** @param {string} nodeType @returns {string} */
function kindOf(nodeType) {
  const label = operatorKey(nodeType);
  const exact = KIND_BY_OPERATOR[label];
  if (exact !== undefined) return exact;

  if (/^NSET\d*$/.test(label)) return "result";
  if (/^PRJT\d*$/.test(label)) return "project";
  if (/^SLCT\d*$/.test(label)) return "filter";
  if (/^CSCN\d*$/.test(label)) return "seq_scan";
  if (/^(?:CSEK|SSCN|SSEK)\d*$/.test(label)) return "index_scan";
  if (/^BLKUP\d*$/.test(label)) return "lookup";
  if (/^(?:HAGR|SAGR|AAGR)\d*$/.test(label)) return "aggregate";
  if (/^SORT\d*$/.test(label)) return "sort";
  if (/^HASH\d*$/.test(label)) return "hash";
  if (/^NEST(?:ED)? LOOP(?:.*JOIN)?\d*$/.test(label) || /^INDEX JOIN.*JOIN\d*$/.test(label)) return "nested_loop";
  if (/^HASH.*JOIN\d*$/.test(label)) return "hash_join";
  if (/^MERGE.*JOIN\d*$/.test(label)) return "merge_join";
  if (/^UNION(?: ALL|ALL)?\d*$/.test(label)) return "append";
  if (/^(?:HASH|MERGE) DISTINCT\d*$/.test(label)) return "unique";
  if (/^(?:MATERIAL|MATERIALIZE|MAT)\d*$/.test(label)) return "materialize";
  if (/^(?:LIMIT|TOP)\d*$/.test(label)) return "limit";

  return "unknown";
}

/**
 * @param {string} nodeType
 * @returns {string}
 */
function operatorKey(nodeType) {
  return String(nodeType).replace(/^#/, "").trim().toUpperCase().replace(/[-\s]+/g, " ");
}

/**
 * Extract a relation/index pair only from the object-like detail fragments
 * Dameng detail strings use forms such as (`INDEX...(TABLE as ALIAS)`). Function-like detail flags
 * such as `scan_type(...)` and `btr_scan(...)` are deliberately ignored.
 *
 * @param {string|null|undefined} detail
 * @returns {{ name: string|null, alias: string|null, indexName: string|null }|null}
 */
function relationFromDetail(detail) {
  if (typeof detail !== "string" || detail.length === 0) return null;

  const ignored = new Set([
    "BTR_SCAN",
    "NEED_SLCT",
    "PREDICTION",
    "PREDJUDGE_IESCN",
    "SCAN_TYPE",
    "SCAN_RANGE",
    "IS_GLOBAL",
    "USE_CLU_ADDR",
    "FLT_BATCH_EXEC",
    "KEY",
    "KEY_NUM",
    "KEY_NULL_EQU",
  ]);

  const fragments = detail.matchAll(/([A-Za-z_$][A-Za-z0-9_$#]*)\s*\(([^()]*)\)/g);
  for (const match of fragments) {
    const candidate = match[1];
    const key = candidate.toUpperCase();
    if (ignored.has(key)) continue;

    const argument = match[2].trim();
    const aliasMatch = argument.match(/^(.+?)\s+as\s+(.+)$/i);
    const name = (aliasMatch?.[1] ?? argument).trim();
    const alias = aliasMatch?.[2]?.trim() ?? null;
    if (name.length === 0) continue;

    // An object fragment either names an index or carries the
    // explicit `TABLE as ALIAS` shape. Other expression fragments are not
    // promoted to relation metadata.
    if (alias !== null || /(?:^|_)INDEX|^IDX[_$]/i.test(candidate)) {
      return { name, alias, indexName: candidate };
    }
  }

  return null;
}

/** @param {string[]|null} predicates @returns {string|null} */
function firstFilterPredicate(predicates) {
  if (!Array.isArray(predicates)) return null;
  for (const predicate of predicates) {
    if (typeof predicate !== "string") continue;
    const match = predicate.match(/^\s*filter\s*\((.*)\)\s*$/is);
    if (match !== null && match[1].trim().length > 0) return match[1].trim();
  }
  return null;
}

/** @param {unknown} value @returns {number|null} */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value @returns {string|null} */
function stringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
