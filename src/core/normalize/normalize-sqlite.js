/**
 * SQLite EXPLAIN QUERY PLAN tree -> database-neutral NormalizedPlan.
 *
 * SQLite EQP reports structural access paths (`SCAN`, `SEARCH ... USING INDEX`,
 * `USING COVERING INDEX`, `USING AUTOMATIC INDEX`, `USE TEMP B-TREE FOR ...`,
 * compound queries, subqueries) without planner row counts or cost numbers.
 * Every numeric estimate / cost / actual field stays `null` instead of being
 * fabricated.
 *
 * @typedef {Object} NormalizedSqlitePlan
 * @property {"sqlite"} database
 * @property {"estimated"} mode
 * @property {"json"} format
 * @property {import("./normalize-postgres.js").NormalizedNode} root
 * @property {string[]} unknownNodeTypes
 */

/**
 * @param {import("../sqlite/parse-json-plan.js").ParsedSqlitePlan} parsed
 * @returns {NormalizedSqlitePlan}
 */
export function normalizeSqlitePlan(parsed) {
  const unknownNodeTypes = new Set();
  const root = normalizeNode(parsed.root, "0", unknownNodeTypes);
  return {
    database: "sqlite",
    mode: parsed.mode,
    format: parsed.format,
    root,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  };
}

/**
 * @param {import("../sqlite/parse-json-plan.js").ParsedSqliteNode} node
 * @param {string} id
 * @param {Set<string>} unknownNodeTypes
 * @returns {import("./normalize-postgres.js").NormalizedNode}
 */
function normalizeNode(node, id, unknownNodeTypes) {
  if (node.structural === true) {
    return {
      id,
      kind: "structural",
      nodeType: node.nodeType,
      relation: null,
      estimatedRows: null,
      actualRows: null,
      actualStartupTime: null,
      actualTotalTime: null,
      loops: null,
      startupCost: null,
      totalCost: null,
      width: null,
      filter: null,
      joinType: null,
      joinCondition: null,
      indexCondition: null,
      sortKeys: null,
      groupKeys: null,
      children: node.children.map((child, index) => normalizeNode(child, `${id}.${index}`, unknownNodeTypes)),
      engineSpecific: {
        database: "sqlite",
        structural: true,
        sqlite: {
          structuralType: node.structuralType ?? "query-plan",
          topLevelStepCount: node.children.length,
        },
        extra: {},
      },
    };
  }

  const kind = kindOf(node);
  if (kind === "unknown") {
    unknownNodeTypes.add(node.detail ?? node.nodeType);
  }

  const hasRelation = node.relationName !== null || node.alias !== null || node.indexName !== null;

  return {
    id,
    kind,
    nodeType: node.nodeType,
    relation: hasRelation
      ? {
          name: node.relationName,
          alias: node.alias,
          indexName: node.indexName,
        }
      : null,
    // SQLite EXPLAIN QUERY PLAN does not report estimated row counts, costs,
    // or runtime metrics. Keep all of them null.
    estimatedRows: null,
    actualRows: null,
    actualStartupTime: null,
    actualTotalTime: null,
    loops: null,
    startupCost: null,
    totalCost: null,
    width: null,
    filter: node.filter,
    joinType: null,
    joinCondition: null,
    indexCondition: node.indexCondition,
    sortKeys: null,
    groupKeys: null,
    children: node.children.map((child, index) => normalizeNode(child, `${id}.${index}`, unknownNodeTypes)),
    engineSpecific: {
      database: "sqlite",
      sqlite: {
        id: node.id,
        parent: node.parent,
        notused: node.notused,
        detail: node.detail,
        operation: node.operation,
        accessStrategy: node.accessStrategy,
        usingCoveringIndex: node.usingCoveringIndex,
        usingAutomaticIndex: node.usingAutomaticIndex,
        tempBTreePurpose: node.tempBTreePurpose,
      },
      extra: isPlainObject(node.extra) ? { ...node.extra } : {},
    },
  };
}

/**
 * Map a parsed SQLite EQP node to the database-neutral `kind` vocabulary.
 *
 * @param {import("../sqlite/parse-json-plan.js").ParsedSqliteNode} node
 * @returns {string}
 */
function kindOf(node) {
  if (!node.recognized) return "unknown";

  if (node.operation === "SEARCH") {
    return node.usingCoveringIndex ? "index_only_scan" : "index_scan";
  }

  if (node.operation === "SCAN") {
    if (node.accessStrategy === "COVERING INDEX SCAN") return "index_only_scan";
    if (node.accessStrategy === "INDEX SCAN") return "index_scan";
    if (node.accessStrategy === "SUBQUERY SCAN" || node.accessStrategy === "VIRTUAL TABLE INDEX") return "scan";
    return "seq_scan";
  }

  if (node.operation === "SCAN CONSTANT ROW") return "result";

  if (node.operation === "USE TEMP B-TREE") {
    const purpose = node.tempBTreePurpose ?? "";
    if (purpose.includes("GROUP BY") || purpose.includes("DISTINCT")) return "aggregate";
    return "sort";
  }

  if (node.operation === "UNION" || node.operation === "UNION ALL") return "append";
  if (node.operation === "INTERSECT" || node.operation === "EXCEPT" || node.operation === "COMPOUND QUERY" || node.operation === "MERGE") {
    return "setop";
  }
  if (node.operation === "MATERIALIZE") return "materialize";
  if (node.operation === "MULTI-INDEX OR") return "bitmap_heap_scan";
  if (node.operation === "BLOOM FILTER") return "filter";
  if (
    node.operation === "LEFT-MOST SUBQUERY" ||
    node.operation === "CO-ROUTINE" ||
    (typeof node.operation === "string" && node.operation.endsWith("SUBQUERY"))
  ) {
    return "subquery";
  }

  return "unknown";
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
