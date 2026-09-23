const KIND_BY_OPERATOR = Object.freeze({
  "async filter": "filter",
  "async jit filter": "filter",
  filter: "filter",
  pageframe: "pipeline",
  "row forward scan": "pipeline",
  "row backward scan": "pipeline",
  "frame forward scan": "scan",
  "frame backward scan": "scan",
  "interval forward scan": "scan",
  "index forward scan": "index_scan",
  "index backward scan": "index_scan",
  "cursor-order scan": "index_scan",
  "table-order scan": "index_scan",
  coveringindex: "index_scan",
  postingindex: "index_scan",
  "Async Window Fast Join": "join",
  "Async Window Join": "join",
  "asof join fast": "join",
  "asof join light": "join",
  "hash join": "join",
  "hash join light": "join",
  "lt join": "join",
  "splice join": "join",
  "cross join": "join",
  "nested loop": "nested_loop",
  "nested loop join": "nested_loop",
  hash: "hash",
  sort: "sort",
  "sort light": "sort",
  "encode sort": "sort",
  "encode sort light": "sort",
  limit: "limit",
  groupby: "aggregate",
  "group by": "aggregate",
  groupbyrecord: "aggregate",
  sampleby: "aggregate",
  "sample by": "aggregate",
  count: "aggregate",
  Window: "analytic",
  CachedWindow: "analytic",
  "selected record": "project",
  selectedrecord: "project",
  virtualrecord: "project",
  union: "append",
  except: "setop",
});

/**
 * QuestDB's operator tree -> database-neutral NormalizedPlan. Operators and
 * all parsed properties remain available under `engineSpecific.questdb`; only
 * relationships explicitly represented by `... scan on: <name>` become a
 * neutral relation. The three-node PageFrame / Row cursor / Frame cursor
 * pipeline has exactly one metric-bearing scan node: the Frame/Interval scan.
 *
 * @typedef {Object} NormalizedQuestDbPlan
 * @property {"questdb"} database
 * @property {"estimated"} mode
 * @property {"text"} format
 * @property {NormalizedNode} root
 * @property {string[]} unknownNodeTypes
 *
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
 */

/**
 * @param {import("../questdb/parse-text-plan.js").ParsedQuestDbPlan} parsed
 * @returns {NormalizedQuestDbPlan}
 */
export function normalizeQuestDbPlan(parsed) {
  const unknownNodeTypes = new Set();
  const root = normalizeNode(parsed.root, "0", unknownNodeTypes, parsed.orphanProperties);
  return {
    database: "questdb",
    mode: parsed.mode,
    format: parsed.format,
    root,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  };
}

/**
 * @param {import("../questdb/parse-text-plan.js").ParsedQuestDbNode} node
 * @param {string} id
 * @param {Set<string>} unknownNodeTypes
 * @param {import("../questdb/parse-text-plan.js").ParsedQuestDbProperty[]} [orphanProperties]
 * @returns {NormalizedNode}
 */
function normalizeNode(node, id, unknownNodeTypes, orphanProperties = []) {
  const kind = kindOf(node.nodeType);
  if (kind === "unknown") unknownNodeTypes.add(node.rawNodeType);
  const properties = Array.isArray(node.properties) ? node.properties.map((property) => ({ ...property })) : [];
  const inlineProperties = Array.isArray(node.inlineProperties) ? node.inlineProperties.map((property) => ({ ...property })) : [];

  return {
    id,
    kind,
    nodeType: node.rawNodeType,
    relation: node.relation === null ? null : { name: node.relation, alias: null, indexName: null },
    // QuestDB Estimated EXPLAIN examples do not report these
    // PostgreSQL-style estimate fields. Keep every unavailable value null.
    estimatedRows: null,
    actualRows: null,
    actualStartupTime: null,
    actualTotalTime: null,
    loops: null,
    startupCost: null,
    totalCost: null,
    width: null,
    filter: nonEmptyString(node.filter),
    joinType: null,
    joinCondition: null,
    indexCondition: null,
    sortKeys: null,
    groupKeys: null,
    children: Array.isArray(node.children)
      ? node.children.map((child, index) => normalizeNode(child, `${id}.${index}`, unknownNodeTypes))
      : [],
    engineSpecific: {
      database: "questdb",
      questdb: {
        nodeType: node.rawNodeType,
        rawNodeType: node.rawNodeType,
        rawLine: node.rawLine,
        indent: node.indent,
        relation: node.relation,
        scanDirection: node.scanDirection,
        workers: node.workers,
        filter: node.filter,
        condition: node.condition,
        vectorized: node.vectorized,
        properties,
        inlineProperties,
        ...(orphanProperties.length > 0 ? { orphanProperties: orphanProperties.map((property) => ({ ...property })) } : {}),
      },
      extra: isPlainObject(node.extra) ? { ...node.extra } : {},
    },
  };
}

/** @param {string} nodeType @returns {string} */
function kindOf(nodeType) {
  const exact = KIND_BY_OPERATOR[String(nodeType).trim()];
  if (exact !== undefined) return exact;
  const key = normalizeOperator(nodeType);
  const known = KIND_BY_OPERATOR[key];
  if (known !== undefined) return known;
  if (/^(?:create table|insert into table|update table):/i.test(nodeType)) return "modify_table";
  if (/^long_sequence\s+count\s*:/i.test(nodeType)) return "source";
  return "unknown";
}

/** @param {string} nodeType */
function normalizeOperator(nodeType) {
  return String(nodeType).trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
