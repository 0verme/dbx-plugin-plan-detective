import { PlanInputError, PlanParseError } from "../errors.js";
import { validateRawPlanInput } from "../raw-plan-input.js";

export const SQLITE_PLAN_LIMITS = Object.freeze({
  rows: 20_000,
  depth: 512,
});

const KNOWN_ROW_KEYS = new Set(["id", "parent", "notused", "detail"]);

const SEARCH_ROWID_RE = /^SEARCH\s+(?:TABLE\s+)?(.+?)\s+USING\s+INTEGER\s+PRIMARY\s+KEY(?:\s*\((.+)\))?$/i;
const SEARCH_AUTO_INDEX_RE = /^SEARCH\s+(?:TABLE\s+)?(.+?)\s+USING\s+AUTOMATIC\s+(COVERING\s+)?INDEX(?:\s*\((.+)\))?$/i;
const SEARCH_INDEX_RE = /^SEARCH\s+(?:TABLE\s+)?(.+?)\s+USING\s+(COVERING\s+)?INDEX\s+([^\s(]+)(?:\s*\((.+)\))?$/i;
const SCAN_CONSTANT_RE = /^SCAN\s+CONSTANT\s+ROW$/i;
const SCAN_INDEX_RE = /^SCAN\s+(?:TABLE\s+)?(.+?)\s+USING\s+(COVERING\s+)?INDEX\s+([^\s(]+)(?:\s*\((.+)\))?$/i;
const SCAN_VIRTUAL_RE = /^SCAN\s+(?:TABLE\s+)?(.+?)\s+VIRTUAL\s+TABLE\s+INDEX\s+(.+)$/i;
const SCAN_SUBQUERY_RE = /^SCAN\s+(SUBQUERY\s+\d+)(?:\s+AS\s+([^\s]+))?$/i;
const SCAN_TABLE_RE = /^SCAN\s+(?:TABLE\s+)?(.+)$/i;
const TEMP_BTREE_RE = /^USE\s+TEMP\s+B-TREE\s+FOR\s+(.+)$/i;
const COMPOUND_QUERY_RE = /^COMPOUND\s+QUERY$/i;
const LEFT_MOST_SUBQUERY_RE = /^LEFT-MOST\s+SUBQUERY$/i;
const SET_OP_RE = /^(UNION\s+ALL|UNION|INTERSECT|EXCEPT)$/i;
const MATERIALIZE_RE = /^MATERIALIZE\s+(.+)$/i;
const COROUTINE_RE = /^CO-ROUTINE\s+(.+)$/i;
const TYPED_SUBQUERY_RE = /^(CORRELATED\s+)?(SCALAR|LIST|EXISTS)\s+SUBQUERY(?:\s+(\d+))?$/i;
const GENERIC_SUBQUERY_RE = /^SUBQUERY\s+(\d+)$/i;
const MULTI_INDEX_OR_RE = /^MULTI-INDEX\s+OR$/i;
const BLOOM_FILTER_RE = /^BLOOM\s+FILTER\s+ON\s+(.+?)(?:\s*\((.+)\))?$/i;
const MERGE_COMPOUND_RE = /^MERGE\s*\((.+)\)$/i;

/**
 * @typedef {Object} ParsedSqliteNode
 * @property {boolean} [structural]
 * @property {string} [structuralType]
 * @property {number} id SQLite EQP node id (0 on the structural root)
 * @property {number|null} parent parent EQP node id (`0` for top-level EQP rows, `null` on structural root)
 * @property {number|null} notused native `notused` integer column when present
 * @property {string|null} detail complete raw `detail` string from SQLite EQP
 * @property {string} nodeType concise operator label derived from `detail` (or raw `detail` when unknown)
 * @property {string|null} operation high-level SQLite EQP operation family (`SCAN`, `SEARCH`, `USE TEMP B-TREE`, ...)
 * @property {boolean} recognized whether `detail` matched a known SQLite EQP pattern
 * @property {string|null} relationName target table / CTE / subquery name when identified
 * @property {string|null} alias table / subquery alias when explicitly reported with `AS`
 * @property {string|null} indexName index name (or `"INTEGER PRIMARY KEY"`) when reported
 * @property {string|null} indexCondition parenthesized index lookup expression when reported
 * @property {string|null} filter bloom filter or non-index condition when reported
 * @property {string|null} accessStrategy explicit SQLite access path (`TABLE SCAN`, `INDEX`, `COVERING INDEX`, ...)
 * @property {boolean} usingCoveringIndex
 * @property {boolean} usingAutomaticIndex
 * @property {string|null} tempBTreePurpose purpose string from `USE TEMP B-TREE FOR ...`
 * @property {ParsedSqliteNode[]} children
 * @property {Record<string, unknown>} extra unrecognized row properties preserved verbatim
 *
 * @typedef {Object} ParsedSqlitePlan
 * @property {"sqlite"} database
 * @property {"json"} format
 * @property {"estimated"} mode
 * @property {ParsedSqliteNode} root
 */

/**
 * Parse a RawPlanInput containing the structured JSON row array returned by DBX
 * for SQLite `EXPLAIN QUERY PLAN` (t8y2/dbx#14885).
 *
 * @param {unknown} input
 * @returns {ParsedSqlitePlan}
 * @throws {PlanInputError|PlanParseError}
 */
export function parseSqliteJsonPlan(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }

  const rawInput = /** @type {import("../raw-plan-input.js").RawPlanInput} */ (input);
  if (rawInput.database !== "sqlite" || rawInput.format !== "json") {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `SQLite JSON parser expects database "sqlite" with format "json"; got ${JSON.stringify(rawInput.database)} / ${JSON.stringify(rawInput.format)}.`,
    );
  }
  if (rawInput.mode !== "estimated") {
    throw new PlanParseError("MODE_MISMATCH", `SQLite EXPLAIN QUERY PLAN parser accepts mode "estimated" only; got "${rawInput.mode}".`);
  }
  if (!Array.isArray(rawInput.plan) || rawInput.plan.length === 0) {
    throw new PlanParseError("MALFORMED_PLAN", `SQLite plan must be a non-empty array of EXPLAIN QUERY PLAN row objects; got ${describeValue(rawInput.plan)}.`);
  }
  if (rawInput.plan.length > SQLITE_PLAN_LIMITS.rows) {
    throw new PlanParseError(
      "PLAN_TOO_LARGE",
      `SQLite EXPLAIN QUERY PLAN contains ${rawInput.plan.length} rows, exceeding the ${SQLITE_PLAN_LIMITS.rows}-row limit.`,
    );
  }

  /** @type {Map<number, ParsedSqliteNode>} */
  const nodesById = new Map();
  /** @type {ParsedSqliteNode[]} */
  const orderedNodes = [];

  for (let index = 0; index < rawInput.plan.length; index += 1) {
    const row = rawInput.plan[index];
    if (!isPlainObject(row)) {
      throw new PlanParseError("MALFORMED_PLAN", `SQLite EXPLAIN QUERY PLAN row ${index} must be a plain object; got ${describeValue(row)}.`);
    }

    const id = row.id;
    const parent = row.parent;
    const notused = row.notused;
    const detail = row.detail;

    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new PlanParseError("MALFORMED_PLAN", `SQLite EXPLAIN QUERY PLAN row ${index} must have a positive integer id; got ${describeValue(id)}.`);
    }
    if (nodesById.has(id)) {
      throw new PlanParseError("MALFORMED_PLAN", `SQLite EXPLAIN QUERY PLAN contains duplicate row id ${id}.`);
    }
    if (!Number.isSafeInteger(parent) || parent < 0) {
      throw new PlanParseError("MALFORMED_PLAN", `SQLite EXPLAIN QUERY PLAN row ${index} (id=${id}) must have a non-negative integer parent; got ${describeValue(parent)}.`);
    }
    if (parent === id) {
      throw new PlanParseError("MALFORMED_PLAN", `SQLite EXPLAIN QUERY PLAN row ${index} (id=${id}) cannot be its own parent.`);
    }
    if (notused !== undefined && notused !== null && !Number.isSafeInteger(notused)) {
      throw new PlanParseError("MALFORMED_PLAN", `SQLite EXPLAIN QUERY PLAN row ${index} (id=${id}) has invalid notused field; got ${describeValue(notused)}.`);
    }
    if (typeof detail !== "string" || detail.trim().length === 0) {
      throw new PlanParseError("MALFORMED_PLAN", `SQLite EXPLAIN QUERY PLAN row ${index} (id=${id}) must have a non-empty detail string; got ${describeValue(detail)}.`);
    }

    /** @type {Record<string, unknown>} */
    const extra = {};
    for (const [key, value] of Object.entries(row)) {
      if (!KNOWN_ROW_KEYS.has(key)) extra[key] = value;
    }

    const descriptor = parseSqliteDetail(detail);
    /** @type {ParsedSqliteNode} */
    const node = {
      id,
      parent,
      notused: notused === undefined || notused === null ? null : notused,
      detail,
      nodeType: descriptor.nodeType,
      operation: descriptor.operation,
      recognized: descriptor.recognized,
      relationName: descriptor.relationName,
      alias: descriptor.alias,
      indexName: descriptor.indexName,
      indexCondition: descriptor.indexCondition,
      filter: descriptor.filter,
      accessStrategy: descriptor.accessStrategy,
      usingCoveringIndex: descriptor.usingCoveringIndex,
      usingAutomaticIndex: descriptor.usingAutomaticIndex,
      tempBTreePurpose: descriptor.tempBTreePurpose,
      children: [],
      extra,
    };

    nodesById.set(id, node);
    orderedNodes.push(node);
  }

  /** @type {ParsedSqliteNode[]} */
  const topLevelNodes = [];
  for (const node of orderedNodes) {
    if (node.parent === 0) {
      topLevelNodes.push(node);
      continue;
    }
    const parentNode = nodesById.get(node.parent);
    if (parentNode === undefined) {
      throw new PlanParseError(
        "MALFORMED_PLAN",
        `SQLite EXPLAIN QUERY PLAN row id=${node.id} references missing parent id=${node.parent}.`,
      );
    }
    parentNode.children.push(node);
  }

  if (topLevelNodes.length === 0) {
    throw new PlanParseError("MALFORMED_PLAN", "SQLite EXPLAIN QUERY PLAN has no top-level rows with parent=0 (cycle detected).");
  }

  let visitedCount = 0;
  /**
   * @param {ParsedSqliteNode} node
   * @param {number} depth
   * @param {Set<number>} ancestors
   */
  function verifyTree(node, depth, ancestors) {
    if (ancestors.has(node.id)) {
      throw new PlanParseError("MALFORMED_PLAN", `SQLite EXPLAIN QUERY PLAN contains a parent-child cycle at id=${node.id}.`);
    }
    if (depth > SQLITE_PLAN_LIMITS.depth) {
      throw new PlanParseError(
        "PLAN_TOO_DEEP",
        `SQLite EXPLAIN QUERY PLAN depth exceeds the ${SQLITE_PLAN_LIMITS.depth}-level limit.`,
      );
    }
    visitedCount += 1;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(node.id);
    for (const child of node.children) {
      verifyTree(child, depth + 1, nextAncestors);
    }
  }

  for (const rootChild of topLevelNodes) {
    verifyTree(rootChild, 1, new Set());
  }

  if (visitedCount !== orderedNodes.length) {
    throw new PlanParseError("MALFORMED_PLAN", "SQLite EXPLAIN QUERY PLAN contains a disconnected parent-child cycle.");
  }

  /** @type {ParsedSqliteNode} */
  const root = {
    structural: true,
    structuralType: "query-plan",
    id: 0,
    parent: null,
    notused: null,
    detail: null,
    nodeType: "SQLite Query Plan",
    operation: "QUERY PLAN",
    recognized: true,
    relationName: null,
    alias: null,
    indexName: null,
    indexCondition: null,
    filter: null,
    accessStrategy: null,
    usingCoveringIndex: false,
    usingAutomaticIndex: false,
    tempBTreePurpose: null,
    children: topLevelNodes,
    extra: {},
  };

  return {
    database: "sqlite",
    format: "json",
    mode: "estimated",
    root,
  };
}

/**
 * Extract structured operator and access-path evidence from a SQLite EQP
 * `detail` string while keeping unknown descriptions fail-soft.
 *
 * @param {string} detail
 */
export function parseSqliteDetail(detail) {
  const trimmed = detail.trim();

  const searchRowid = trimmed.match(SEARCH_ROWID_RE);
  if (searchRowid !== null) {
    const target = parseTarget(searchRowid[1]);
    return makeDescriptor({
      nodeType: "Rowid Search",
      operation: "SEARCH",
      relationName: target.relationName,
      alias: target.alias,
      indexName: "INTEGER PRIMARY KEY",
      indexCondition: cleanOptional(searchRowid[2]),
      accessStrategy: "INTEGER PRIMARY KEY",
    });
  }

  const searchAuto = trimmed.match(SEARCH_AUTO_INDEX_RE);
  if (searchAuto !== null) {
    const target = parseTarget(searchAuto[1]);
    const covering = Boolean(searchAuto[2]);
    return makeDescriptor({
      nodeType: covering ? "Automatic Covering Index Search" : "Automatic Index Search",
      operation: "SEARCH",
      relationName: target.relationName,
      alias: target.alias,
      indexCondition: cleanOptional(searchAuto[3]),
      accessStrategy: covering ? "AUTOMATIC COVERING INDEX" : "AUTOMATIC INDEX",
      usingCoveringIndex: covering,
      usingAutomaticIndex: true,
    });
  }

  const searchIndex = trimmed.match(SEARCH_INDEX_RE);
  if (searchIndex !== null) {
    const target = parseTarget(searchIndex[1]);
    const covering = Boolean(searchIndex[2]);
    return makeDescriptor({
      nodeType: covering ? "Covering Index Search" : "Index Search",
      operation: "SEARCH",
      relationName: target.relationName,
      alias: target.alias,
      indexName: searchIndex[3].trim(),
      indexCondition: cleanOptional(searchIndex[4]),
      accessStrategy: covering ? "COVERING INDEX" : "INDEX",
      usingCoveringIndex: covering,
    });
  }

  if (SCAN_CONSTANT_RE.test(trimmed)) {
    return makeDescriptor({
      nodeType: "Constant Row",
      operation: "SCAN CONSTANT ROW",
      accessStrategy: "CONSTANT ROW",
    });
  }

  const scanIndex = trimmed.match(SCAN_INDEX_RE);
  if (scanIndex !== null) {
    const target = parseTarget(scanIndex[1]);
    const covering = Boolean(scanIndex[2]);
    return makeDescriptor({
      nodeType: covering ? "Covering Index Scan" : "Index Scan",
      operation: "SCAN",
      relationName: target.relationName,
      alias: target.alias,
      indexName: scanIndex[3].trim(),
      indexCondition: cleanOptional(scanIndex[4]),
      accessStrategy: covering ? "COVERING INDEX SCAN" : "INDEX SCAN",
      usingCoveringIndex: covering,
    });
  }

  const scanVirtual = trimmed.match(SCAN_VIRTUAL_RE);
  if (scanVirtual !== null) {
    const target = parseTarget(scanVirtual[1]);
    return makeDescriptor({
      nodeType: "Virtual Table Scan",
      operation: "SCAN",
      relationName: target.relationName,
      alias: target.alias,
      indexCondition: cleanOptional(scanVirtual[2]),
      accessStrategy: "VIRTUAL TABLE INDEX",
    });
  }

  const scanSubquery = trimmed.match(SCAN_SUBQUERY_RE);
  if (scanSubquery !== null) {
    return makeDescriptor({
      nodeType: "Subquery Scan",
      operation: "SCAN",
      relationName: scanSubquery[1].replace(/\s+/g, " ").toUpperCase(),
      alias: cleanOptional(scanSubquery[2]),
      accessStrategy: "SUBQUERY SCAN",
    });
  }

  const scanTable = trimmed.match(SCAN_TABLE_RE);
  if (scanTable !== null) {
    const target = parseTarget(scanTable[1]);
    return makeDescriptor({
      nodeType: "Table Scan",
      operation: "SCAN",
      relationName: target.relationName,
      alias: target.alias,
      accessStrategy: "TABLE SCAN",
    });
  }

  const tempBTree = trimmed.match(TEMP_BTREE_RE);
  if (tempBTree !== null) {
    const purpose = tempBTree[1].trim().replace(/\s+/g, " ").toUpperCase();
    return makeDescriptor({
      nodeType: `Temp B-Tree (${purpose})`,
      operation: "USE TEMP B-TREE",
      tempBTreePurpose: purpose,
    });
  }

  if (COMPOUND_QUERY_RE.test(trimmed)) {
    return makeDescriptor({
      nodeType: "Compound Query",
      operation: "COMPOUND QUERY",
    });
  }

  if (LEFT_MOST_SUBQUERY_RE.test(trimmed)) {
    return makeDescriptor({
      nodeType: "Left-Most Subquery",
      operation: "LEFT-MOST SUBQUERY",
    });
  }

  const setOp = trimmed.match(SET_OP_RE);
  if (setOp !== null) {
    const op = setOp[1].replace(/\s+/g, " ").toUpperCase();
    const label = op === "UNION ALL" ? "Union All" : op === "UNION" ? "Union" : op === "INTERSECT" ? "Intersect" : "Except";
    return makeDescriptor({
      nodeType: label,
      operation: op,
    });
  }

  const materialize = trimmed.match(MATERIALIZE_RE);
  if (materialize !== null) {
    return makeDescriptor({
      nodeType: "Materialize",
      operation: "MATERIALIZE",
      relationName: materialize[1].trim(),
    });
  }

  const coroutine = trimmed.match(COROUTINE_RE);
  if (coroutine !== null) {
    return makeDescriptor({
      nodeType: "Co-Routine",
      operation: "CO-ROUTINE",
      relationName: coroutine[1].trim(),
    });
  }

  const typedSubquery = trimmed.match(TYPED_SUBQUERY_RE);
  if (typedSubquery !== null) {
    const correlated = Boolean(typedSubquery[1]);
    const kindWord = typedSubquery[2].toUpperCase();
    const prefix = correlated ? "Correlated " : "";
    const kindLabel = kindWord === "SCALAR" ? "Scalar Subquery" : kindWord === "LIST" ? "List Subquery" : "Exists Subquery";
    return makeDescriptor({
      nodeType: `${prefix}${kindLabel}`,
      operation: `${correlated ? "CORRELATED " : ""}${kindWord} SUBQUERY`,
    });
  }

  const genericSubquery = trimmed.match(GENERIC_SUBQUERY_RE);
  if (genericSubquery !== null) {
    return makeDescriptor({
      nodeType: "Subquery",
      operation: "SUBQUERY",
      relationName: `SUBQUERY ${genericSubquery[1]}`,
    });
  }

  if (MULTI_INDEX_OR_RE.test(trimmed)) {
    return makeDescriptor({
      nodeType: "Multi-Index OR",
      operation: "MULTI-INDEX OR",
    });
  }

  const bloomFilter = trimmed.match(BLOOM_FILTER_RE);
  if (bloomFilter !== null) {
    const target = parseTarget(bloomFilter[1]);
    return makeDescriptor({
      nodeType: "Bloom Filter",
      operation: "BLOOM FILTER",
      relationName: target.relationName,
      alias: target.alias,
      filter: cleanOptional(bloomFilter[2]),
    });
  }

  const mergeCompound = trimmed.match(MERGE_COMPOUND_RE);
  if (mergeCompound !== null) {
    const purpose = mergeCompound[1].trim().replace(/\s+/g, " ").toUpperCase();
    return makeDescriptor({
      nodeType: `Merge (${purpose})`,
      operation: "MERGE",
    });
  }

  return makeDescriptor({
    nodeType: trimmed,
    operation: null,
    recognized: false,
  });
}

/**
 * @param {string} rawTarget
 * @returns {{ relationName: string|null, alias: string|null }}
 */
function parseTarget(rawTarget) {
  const cleaned = rawTarget.trim();
  const subMatch = cleaned.match(/^(SUBQUERY\s+\d+)(?:\s+AS\s+([^\s]+))?$/i);
  if (subMatch !== null) {
    return {
      relationName: subMatch[1].replace(/\s+/g, " ").toUpperCase(),
      alias: cleanOptional(subMatch[2]),
    };
  }
  const asMatch = cleaned.match(/^([^\s]+)\s+AS\s+([^\s]+)$/i);
  if (asMatch !== null) {
    return {
      relationName: asMatch[1].trim(),
      alias: asMatch[2].trim(),
    };
  }
  return {
    relationName: cleaned.length > 0 ? cleaned : null,
    alias: null,
  };
}

/**
 * @param {Partial<Omit<ParsedSqliteNode, "id"|"parent"|"notused"|"detail"|"children"|"extra">>} fields
 */
function makeDescriptor(fields) {
  return {
    nodeType: fields.nodeType ?? "Unknown",
    operation: fields.operation ?? null,
    recognized: fields.recognized ?? true,
    relationName: fields.relationName ?? null,
    alias: fields.alias ?? null,
    indexName: fields.indexName ?? null,
    indexCondition: fields.indexCondition ?? null,
    filter: fields.filter ?? null,
    accessStrategy: fields.accessStrategy ?? null,
    usingCoveringIndex: fields.usingCoveringIndex ?? false,
    usingAutomaticIndex: fields.usingAutomaticIndex ?? false,
    tempBTreePurpose: fields.tempBTreePurpose ?? null,
  };
}

/** @param {string|undefined} value */
function cleanOptional(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length ${value.length})`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") {
    const shown = value.length > 40 ? `${value.slice(0, 37)}...` : value;
    return `string(${JSON.stringify(shown)})`;
  }
  return `${typeof value}(${String(value)})`;
}
