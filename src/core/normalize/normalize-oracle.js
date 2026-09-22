/**
 * Oracle DBMS_XPLAN parsed rows -> database-neutral NormalizedPlan.
 *
 * Oracle's `Rows`, `Bytes`, `Cost`, `%CPU`, and `Time` are kept as Oracle
 * evidence. In particular, Oracle `Cost` is not PostgreSQL's cumulative cost,
 * so it never enters `startupCost` or `totalCost`; the shared cost metrics
 * therefore report `not-applicable` and do not invent PostgreSQL cost signals.
 */

/**
 * Exact Oracle operation labels whose semantics are stable enough to promote
 * into the small cross-database vocabulary. Suffix rules below cover known
 * variants such as `NESTED LOOPS OUTER` without classifying arbitrary future
 * labels merely because they contain a familiar word.
 */
const KIND_BY_OPERATION = Object.freeze({
  "SELECT STATEMENT": "result",
  "TABLE ACCESS FULL": "seq_scan",
  "TABLE ACCESS SAMPLE": "seq_scan",
  "TABLE ACCESS BY INDEX ROWID": "lookup",
  "TABLE ACCESS BY GLOBAL INDEX ROWID": "lookup",
  "TABLE ACCESS BY USER ROWID": "lookup",
  "INDEX RANGE SCAN": "index_scan",
  "INDEX UNIQUE SCAN": "index_scan",
  "INDEX FULL SCAN": "index_scan",
  "INDEX FAST FULL SCAN": "index_scan",
  "INDEX SKIP SCAN": "index_scan",
  "INDEX JOIN SCAN": "index_scan",
  "INDEX SAMPLE SCAN": "index_scan",
  "NESTED LOOPS": "nested_loop",
  "HASH JOIN": "hash_join",
  "MERGE JOIN": "merge_join",
  "SORT ORDER BY": "sort",
  "SORT GROUP BY": "aggregate",
  "SORT UNIQUE": "unique",
  "SORT AGGREGATE": "aggregate",
  "SORT JOIN": "sort",
  "HASH GROUP BY": "aggregate",
  "HASH UNIQUE": "unique",
  "WINDOW SORT": "sort",
  "WINDOW NOSORT": "analytic",
  "WINDOW BUFFER": "analytic",
  FILTER: "filter",
  VIEW: "subquery_scan",
  "UNION ALL": "append",
  MINUS: "setop",
  INTERSECTION: "setop",
  "COUNT STOPKEY": "limit",
  COUNT: "aggregate",
});

const KIND_BY_SUFFIX = Object.freeze([
  ["TABLE ACCESS STORAGE FULL", "seq_scan"],
  ["TABLE ACCESS FULL", "seq_scan"],
  ["TABLE ACCESS SAMPLE", "seq_scan"],
  ["TABLE ACCESS BY INDEX ROWID", "lookup"],
  ["TABLE ACCESS BY GLOBAL INDEX ROWID", "lookup"],
  ["TABLE ACCESS BY USER ROWID", "lookup"],
  ["INDEX RANGE SCAN", "index_scan"],
  ["INDEX UNIQUE SCAN", "index_scan"],
  ["INDEX FULL SCAN", "index_scan"],
  ["INDEX FAST FULL SCAN", "index_scan"],
  ["INDEX SKIP SCAN", "index_scan"],
  ["INDEX JOIN SCAN", "index_scan"],
  ["INDEX SAMPLE SCAN", "index_scan"],
  ["NESTED LOOPS", "nested_loop"],
  ["HASH JOIN", "hash_join"],
  ["MERGE JOIN", "merge_join"],
  ["SORT ORDER BY", "sort"],
  ["SORT GROUP BY", "aggregate"],
  ["SORT UNIQUE", "unique"],
  ["SORT AGGREGATE", "aggregate"],
  ["HASH GROUP BY", "aggregate"],
  ["HASH UNIQUE", "unique"],
]);

/**
 * @typedef {Object} NormalizedNode
 * @property {string} id
 * @property {string} kind
 * @property {string} nodeType
 * @property {{ name: string|null, alias: string|null, indexName: string|null }|null} relation
 * @property {number|null} estimatedRows
 * @property {number|null} actualRows
 * @property {number|null} actualStartupTime
 * @property {number|null} actualTotalTime
 * @property {number|null} loops
 * @property {number|null} startupCost
 * @property {number|null} totalCost
 * @property {number|null} width
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
 * @property {"oracle"} database
 * @property {"estimated"} mode
 * @property {"text"} format
 * @property {NormalizedNode} root
 * @property {string[]} unknownNodeTypes
 */

/**
 * @param {import("../oracle/parse-text-plan.js").ParsedPlan} parsed
 * @returns {NormalizedPlan}
 */
export function normalizeOraclePlan(parsed) {
  const unknownNodeTypes = new Set();
  const root = normalizeNode(parsed.root, "0", unknownNodeTypes, parsed.planHashValue);

  return {
    database: "oracle",
    mode: parsed.mode,
    format: parsed.format,
    root,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  };
}

/**
 * @param {import("../oracle/parse-text-plan.js").ParsedOracleNode} node
 * @param {string} id
 * @param {Set<string>} unknownNodeTypes
 * @param {number|null} planHashValue
 * @returns {NormalizedNode}
 */
function normalizeNode(node, id, unknownNodeTypes, planHashValue) {
  const rawOperation = typeof node.rawOperation === "string" ? node.rawOperation : node.nodeType === "Plan" ? null : node.nodeType;
  const nodeType = typeof node.nodeType === "string" && node.nodeType.length > 0 ? node.nodeType : "Plan";
  const kind = kindOf(nodeType);
  if (kind === "unknown" && rawOperation !== null) unknownNodeTypes.add(rawOperation);

  const operation = operatorKey(nodeType);
  const relation = relationFor(operation, node.name);
  const oracle = {
    id: numberOrNull(node.id),
    rawOperation,
    name: stringOrNull(node.name),
    estimatedRows: numberOrNull(node.estimatedRows),
    bytes: numberOrNull(node.bytes),
    cost: numberOrNull(node.cost),
    cpuPercent: numberOrNull(node.cpuPercent),
    time: stringOrNull(node.time),
    predicateMarker: node.predicateMarker === true,
    predicates: Array.isArray(node.predicates) ? [...node.predicates] : null,
    planHashValue: id === "0" ? numberOrNull(planHashValue) : null,
    extra: isPlainObject(node.extra) ? { ...node.extra } : {},
  };

  return {
    id,
    kind,
    nodeType,
    relation,
    estimatedRows: numberOrNull(node.estimatedRows),
    actualRows: null,
    actualStartupTime: null,
    actualTotalTime: null,
    loops: null,
    // Oracle Cost is not PostgreSQL Total Cost.
    startupCost: null,
    totalCost: null,
    width: null,
    filter: null,
    joinType: null,
    joinCondition: null,
    indexCondition: null,
    sortKeys: null,
    groupKeys: null,
    children: Array.isArray(node.children)
      ? node.children.map((child, index) => normalizeNode(child, `${id}.${index}`, unknownNodeTypes, planHashValue))
      : [],
    engineSpecific: {
      database: "oracle",
      oracle,
    },
  };
}

/** @param {string} nodeType @returns {string} */
function kindOf(nodeType) {
  const key = operatorKey(nodeType);
  const exact = KIND_BY_OPERATION[key];
  if (exact !== undefined) return exact;
  for (const [operation, kind] of KIND_BY_SUFFIX) {
    if (key === operation || key.startsWith(`${operation} `) || key.endsWith(` ${operation}`)) return kind;
  }
  return "unknown";
}

/**
 * @param {string} operation
 * @param {string|null|undefined} name
 * @returns {{ name: string|null, alias: string|null, indexName: string|null }|null}
 */
function relationFor(operation, name) {
  const value = stringOrNull(name);
  if (value === null) return null;

  if (isIndexOperation(operation)) return { name: null, alias: null, indexName: value };
  if (operation === "VIEW" || operation.startsWith("VIEW ") || operation.includes("TABLE ACCESS")) return { name: value, alias: null, indexName: null };
  return null;
}

/** @param {string} operation @returns {boolean} */
function isIndexOperation(operation) {
  return (
    operation === "INDEX RANGE SCAN" ||
    operation === "INDEX UNIQUE SCAN" ||
    operation === "INDEX FULL SCAN" ||
    operation === "INDEX FAST FULL SCAN" ||
    operation === "INDEX SKIP SCAN" ||
    operation === "INDEX JOIN SCAN" ||
    operation === "INDEX SAMPLE SCAN" ||
    operation.startsWith("INDEX RANGE SCAN ") ||
    operation.startsWith("INDEX UNIQUE SCAN ") ||
    operation.startsWith("INDEX FULL SCAN ") ||
    operation.startsWith("INDEX FAST FULL SCAN ") ||
    operation.startsWith("INDEX SKIP SCAN ") ||
    operation.startsWith("INDEX JOIN SCAN ") ||
    operation.startsWith("INDEX SAMPLE SCAN ") ||
    operation.endsWith(" INDEX RANGE SCAN") ||
    operation.endsWith(" INDEX UNIQUE SCAN") ||
    operation.endsWith(" INDEX FULL SCAN") ||
    operation.endsWith(" INDEX FAST FULL SCAN") ||
    operation.endsWith(" INDEX SKIP SCAN") ||
    operation.endsWith(" INDEX JOIN SCAN") ||
    operation.endsWith(" INDEX SAMPLE SCAN")
  );
}

/** @param {string} value @returns {string} */
function operatorKey(value) {
  return String(value).trim().toUpperCase().replace(/[-\s]+/g, " ");
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
