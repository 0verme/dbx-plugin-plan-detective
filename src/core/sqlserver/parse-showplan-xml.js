/**
 * SQL Server `SET SHOWPLAN_XML ON` parser (ShowPlanXML -> ParsedPlan).
 *
 * Pipeline position:
 *
 *     RawPlanInput --(this parser)--> ParsedPlan --(normalizer)--> NormalizedPlan
 *
 * The parser is the only SQL Server-aware stage before normalization. It maps
 * the ShowPlanXML elements onto typed fields, keeps SQL Server's own cost
 * vocabulary (`EstimatedTotalSubtreeCost`, `EstimateCPU`, `EstimateIO`) out of
 * the PostgreSQL-style fields, and never drops a node: an operator the kind map
 * does not know keeps its `PhysicalOp` label and its whole subtree.
 *
 * Structure assumptions are deliberately minimal:
 *
 * - a plan is one `StmtSimple` + `QueryPlan` + one root `RelOp`; a payload with
 *   several statements that carry a query plan fails closed with
 *   `MULTIPLE_STATEMENTS` instead of silently analyzing only the first;
 * - every `RelOp`'s inputs are the `RelOp` descendants of its own operator
 *   element, stopping at nested `RelOp` boundaries. That covers
 *   `NestedLoops` / `Hash` / `Merge` / `Sort` / `Concat` / `Spool` /
 *   `Parallelism` and the `IndexScan Lookup="1"` child without a per-operator
 *   table, so an unknown operator container still yields its children.
 *
 * SQL Server costs are *subtree* costs. They are preserved under
 * `engineSpecific.sqlServer` and are never promoted to `startupCost` /
 * `totalCost`: the shared metrics and rules treat those fields as PostgreSQL
 * cumulative costs, and subtracting child subtree costs would fabricate
 * precision this round does not verify.
 */

import { PlanInputError, PlanParseError } from "../errors.js";
import { validateRawPlanInput } from "../raw-plan-input.js";
import { attribute, descendants, directChild, findElements, parseXmlDocument } from "./xml.js";

/** RelOp attributes the parser maps onto typed fields. */
const RELOP_ATTRIBUTES = new Set([
  "NodeId",
  "PhysicalOp",
  "LogicalOp",
  "EstimateRows",
  "EstimatedTotalSubtreeCost",
  "EstimateCPU",
  "EstimateIO",
  "EstimateRebinds",
  "EstimateRewinds",
  "EstimateExecutions",
  "AvgRowSize",
  "Parallel",
  "Lookup",
]);

/** Mapped attributes that must parse as finite numbers / SQL Server booleans. */
const NUMERIC_RELOP_ATTRIBUTES = new Set([
  "NodeId",
  "EstimateRows",
  "EstimatedTotalSubtreeCost",
  "EstimateCPU",
  "EstimateIO",
  "EstimateRebinds",
  "EstimateRewinds",
  "EstimateExecutions",
  "AvgRowSize",
]);
const BOOLEAN_RELOP_ATTRIBUTES = new Set(["Parallel", "Lookup"]);

/** Runtime-counter elements only an actual plan carries. */
const ACTUAL_ONLY_ELEMENTS = Object.freeze(["RunTimeInformation", "QueryTimeStats"]);

/**
 * @typedef {Object} ParsedSqlServerNode
 * @property {string} nodeType engine label: `PhysicalOp`, falling back to `LogicalOp`
 * @property {string|null} physicalOp raw `PhysicalOp`
 * @property {string|null} logicalOp raw `LogicalOp`
 * @property {number|null} nodeId ShowPlanXML `NodeId`
 * @property {number|null} estimatedRows `EstimateRows`
 * @property {number|null} estimatedTotalSubtreeCost cumulative subtree cost
 * @property {number|null} estimateCpu `EstimateCPU` (per-node estimate)
 * @property {number|null} estimateIo `EstimateIO` (per-node estimate)
 * @property {number|null} estimateRebinds
 * @property {number|null} estimateRewinds
 * @property {number|null} estimateExecutions
 * @property {number|null} avgRowSize `AvgRowSize`
 * @property {boolean|null} parallel
 * @property {string|null} database object `Database`
 * @property {string|null} schema object `Schema`
 * @property {string|null} table object `Table`
 * @property {string|null} index object `Index`
 * @property {string|null} alias object `Alias`
 * @property {string|null} indexKind object `IndexKind`
 * @property {string|null} storage `Storage`
 * @property {string|null} predicate `Predicate` scalar string
 * @property {string|null} indexCondition rendered `SeekPredicates`
 * @property {string[]|null} sortKeys rendered `OrderBy`
 * @property {string[]|null} groupKeys rendered `GroupBy`
 * @property {string[]|null} hashKeysBuild rendered `HashKeysBuild`
 * @property {string[]|null} hashKeysProbe rendered `HashKeysProbe`
 * @property {string|null} probeResidual
 * @property {string|null} buildResidual
 * @property {string|null} residual `Residual` (Merge Join)
 * @property {string[]|null} definedValues computed scalar strings
 * @property {Record<string, unknown>|null} operator operator configuration flags
 * @property {ParsedSqlServerNode[]} children input RelOps, source order
 * @property {Record<string, string>} extra unmapped RelOp attributes
 *
 * @typedef {Object} ParsedStatement
 * @property {string|null} type `StatementType`
 * @property {number|null} id `StatementId`
 * @property {number|null} subtreeCost `StatementSubTreeCost`
 * @property {number|null} estimatedRows `StatementEstRows`
 * @property {string|null} optimizationLevel `StatementOptmLevel`
 *
 * @typedef {Object} ParsedQueryPlan
 * @property {number|null} degreeOfParallelism
 * @property {number|null} memoryGrant
 * @property {number|null} cachedPlanSize
 *
 * @typedef {Object} ParsedPlan
 * @property {"sqlserver"} database
 * @property {"xml"} format
 * @property {"estimated"} mode
 * @property {ParsedSqlServerNode} root
 * @property {ParsedStatement} statement
 * @property {ParsedQueryPlan} queryPlan
 */

/**
 * Parse a SQL Server ShowPlanXML estimated plan.
 *
 * @param {unknown} input a RawPlanInput
 * @returns {ParsedPlan}
 * @throws {PlanInputError} when the RawPlanInput contract is not satisfied
 * @throws {PlanParseError} when the payload is malformed, is an actual plan, or
 *   contains more than one statement with a query plan
 */
export function parseSqlServerShowPlanXml(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }

  // Contract validation guarantees database "sqlserver" and format "xml".
  const { mode, plan } = /** @type {import("../raw-plan-input.js").RawPlanInput} */ (input);

  if (mode !== "estimated") {
    throw new PlanParseError(
      "MODE_MISMATCH",
      'SQL Server plans are parsed in mode "estimated" only; runtime ShowPlanXML counters are not implemented.',
    );
  }
  if (typeof plan !== "string") {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `SQL Server plan payload must be the ShowPlanXML string the host returned; got ${typeof plan}.`,
    );
  }

  const root = parseXmlDocument(plan);
  if (root.name !== "ShowPlanXML") {
    throw new PlanParseError("MALFORMED_PLAN", `expected a <ShowPlanXML> root element; got <${root.name}>.`);
  }

  const runtimeMarker = ACTUAL_ONLY_ELEMENTS.find((name) => findElements(root, name).length > 0);
  if (runtimeMarker !== undefined) {
    throw new PlanParseError(
      "MODE_MISMATCH",
      `the payload contains <${runtimeMarker}>, which only an actual plan reports; ` +
        'the declared mode is "estimated", and mixing estimate and runtime values is rejected.',
    );
  }

  const statementsWithPlan = findElements(root, "StmtSimple").filter((statement) => directChild(statement, "QueryPlan") !== null);
  if (statementsWithPlan.length === 0) {
    throw new PlanParseError("MALFORMED_PLAN", "ShowPlanXML contains no StmtSimple element with a QueryPlan.");
  }
  if (statementsWithPlan.length > 1) {
    throw new PlanParseError(
      "MULTIPLE_STATEMENTS",
      `ShowPlanXML contains ${statementsWithPlan.length} statements with a query plan; ` +
        "Plan Detective analyzes one statement at a time and does not silently pick the first.",
    );
  }

  const statement = statementsWithPlan[0];
  const queryPlan = directChild(statement, "QueryPlan");
  const rootRelOp = directChild(queryPlan, "RelOp");
  if (rootRelOp === null) {
    throw new PlanParseError("MALFORMED_PLAN", "QueryPlan contains no root RelOp.");
  }

  return {
    database: "sqlserver",
    format: "xml",
    mode,
    root: parseRelOp(rootRelOp),
    statement: readStatement(statement),
    queryPlan: readQueryPlan(queryPlan),
  };
}

/**
 * @param {import("./xml.js").XmlElement} statement
 * @returns {ParsedStatement}
 */
function readStatement(statement) {
  return {
    type: attribute(statement, "StatementType"),
    id: readNumber(statement, "StatementId"),
    subtreeCost: readNumber(statement, "StatementSubTreeCost"),
    estimatedRows: readNumber(statement, "StatementEstRows"),
    optimizationLevel: attribute(statement, "StatementOptmLevel"),
  };
}

/**
 * @param {import("./xml.js").XmlElement} queryPlan
 * @returns {ParsedQueryPlan}
 */
function readQueryPlan(queryPlan) {
  return {
    degreeOfParallelism: readNumber(queryPlan, "DegreeOfParallelism"),
    memoryGrant: readNumber(queryPlan, "MemoryGrant"),
    cachedPlanSize: readNumber(queryPlan, "CachedPlanSize"),
  };
}

/**
 * @param {import("./xml.js").XmlElement} element
 * @returns {ParsedSqlServerNode}
 */
function parseRelOp(element) {
  const physicalOp = attribute(element, "PhysicalOp");
  const logicalOp = attribute(element, "LogicalOp");
  const scope = collectScope(element);

  return {
    nodeType: physicalOp ?? logicalOp ?? "RelOp",
    physicalOp,
    logicalOp,
    nodeId: readNumber(element, "NodeId"),
    estimatedRows: readNumber(element, "EstimateRows"),
    estimatedTotalSubtreeCost: readNumber(element, "EstimatedTotalSubtreeCost"),
    estimateCpu: readNumber(element, "EstimateCPU"),
    estimateIo: readNumber(element, "EstimateIO"),
    estimateRebinds: readNumber(element, "EstimateRebinds"),
    estimateRewinds: readNumber(element, "EstimateRewinds"),
    estimateExecutions: readNumber(element, "EstimateExecutions"),
    avgRowSize: readNumber(element, "AvgRowSize"),
    parallel: readBoolean(element, "Parallel"),
    database: readObjectString(scope, "Database"),
    schema: readObjectString(scope, "Schema"),
    table: readObjectString(scope, "Table"),
    index: readObjectString(scope, "Index"),
    alias: readObjectString(scope, "Alias"),
    indexKind: readObjectString(scope, "IndexKind"),
    storage: readStorage(scope),
    predicate: scalarStringOf(scope.first("Predicate")),
    indexCondition: renderSeekPredicates(scope),
    sortKeys: renderOrderBy(scope.first("OrderBy")),
    groupKeys: renderColumnList(scope.first("GroupBy")),
    hashKeysBuild: renderColumnList(scope.first("HashKeysBuild")),
    hashKeysProbe: renderColumnList(scope.first("HashKeysProbe")),
    probeResidual: scalarStringOf(scope.first("ProbeResidual")),
    buildResidual: scalarStringOf(scope.first("BuildResidual")),
    residual: scalarStringOf(scope.first("Residual")),
    definedValues: renderDefinedValues(scope),
    operator: readOperatorFlags(scope, element),
    children: scope.childRelOps.map((child) => parseRelOp(child)),
    extra: readExtraAttributes(element),
  };
}

/**
 * Walk one RelOp's subtree, collecting every descendant element by local name
 * while stopping at nested `RelOp` boundaries. Child RelOps are returned in
 * source order; the scope's own elements are everything else (operator
 * containers, object references, predicates, sort keys, ...).
 *
 * @param {import("./xml.js").XmlElement} relOp
 * @returns {{
 *   childRelOps: import("./xml.js").XmlElement[],
 *   first: (name: string) => import("./xml.js").XmlElement|null,
 *   all: (name: string) => import("./xml.js").XmlElement[],
 * }}
 */
function collectScope(relOp) {
  /** @type {Map<string, import("./xml.js").XmlElement[]>} */
  const byName = new Map();
  /** @type {import("./xml.js").XmlElement[]} */
  const childRelOps = [];

  /** @type {import("./xml.js").XmlElement[]} */
  const stack = [];
  for (let index = relOp.children.length - 1; index >= 0; index -= 1) {
    stack.push(relOp.children[index]);
  }

  while (stack.length > 0) {
    const current = stack.pop();
    if (current.name === "RelOp") {
      childRelOps.push(current);
      continue;
    }
    const list = byName.get(current.name);
    if (list === undefined) byName.set(current.name, [current]);
    else list.push(current);

    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      stack.push(current.children[index]);
    }
  }

  return {
    childRelOps,
    first: (name) => byName.get(name)?.[0] ?? null,
    all: (name) => byName.get(name) ?? [],
  };
}

/**
 * First `<Object>` element in the operator's own scope. The scan stops at
 * nested RelOps, so a wrapper operator never borrows its child's table.
 *
 * @param {ReturnType<typeof collectScope>} scope
 * @param {string} name
 * @returns {string|null}
 */
function readObjectString(scope, name) {
  return attribute(scope.first("Object"), name);
}

/**
 * `Storage` is reported on the scan operator element and sometimes on
 * `<Object>`; take the first value that exists.
 *
 * @param {ReturnType<typeof collectScope>} scope
 * @returns {string|null}
 */
function readStorage(scope) {
  const objectStorage = attribute(scope.first("Object"), "Storage");
  if (objectStorage !== null) return objectStorage;

  for (const operatorName of ["IndexScan", "TableScan", "ColumnstoreIndexScan"]) {
    const storage = attribute(scope.first(operatorName), "Storage");
    if (storage !== null) return storage;
  }
  return null;
}

/**
 * Operator configuration flags worth keeping as evidence. A plan-node wrapper
 * (`Sort`, `Top`, ...) carries a handful of meaningful attributes; copying the
 * whole XML would be noise, so only a fixed, interpreted set is kept.
 *
 * @param {ReturnType<typeof collectScope>} scope
 * @param {import("./xml.js").XmlElement} relOp the RelOp element itself, which
 *   carries some configuration attributes (for example `Lookup`)
 * @returns {Record<string, unknown>|null}
 */
function readOperatorFlags(scope, relOp) {
  /** @type {Record<string, unknown>} */
  const flags = {};

  const sort = scope.first("Sort");
  const distinct = readBoolean(sort, "Distinct");
  if (distinct !== null) flags.distinct = distinct;

  const top = scope.first("Top") ?? scope.first("TopSort");
  const topRowCount = readNumber(top, "RowCount");
  if (topRowCount !== null) flags.topRowCount = topRowCount;
  const topIsPercent = readBoolean(top, "IsPercent");
  if (topIsPercent !== null) flags.topIsPercent = topIsPercent;

  const merge = scope.first("Merge");
  const manyToMany = readBoolean(merge, "ManyToMany");
  if (manyToMany !== null) flags.manyToMany = manyToMany;

  const parallelism = scope.first("Parallelism");
  const partitioningType = attribute(parallelism, "PartitioningType");
  if (partitioningType !== null) flags.partitioningType = partitioningType;

  const indexScan = scope.first("IndexScan");
  const lookup = readBoolean(relOp, "Lookup") ?? readBoolean(indexScan, "Lookup");
  if (lookup !== null) flags.lookup = lookup;
  const ordered = readBoolean(indexScan, "Ordered");
  if (ordered !== null) flags.ordered = ordered;

  return Object.keys(flags).length > 0 ? flags : null;
}

/**
 * Unmapped RelOp attributes, plus mapped attributes whose value could not be
 * interpreted (for example `EstimateRows="unknown"`). Keeping the raw string
 * means a corrupt attribute degrades to "not usable" instead of being lost.
 *
 * @param {import("./xml.js").XmlElement} element
 * @returns {Record<string, string>}
 */
function readExtraAttributes(element) {
  /** @type {Record<string, string>} */
  const extra = {};
  for (const [name, value] of Object.entries(element.attributes)) {
    if (!RELOP_ATTRIBUTES.has(name)) {
      extra[name] = value;
      continue;
    }
    if (NUMERIC_RELOP_ATTRIBUTES.has(name) && !isFiniteNumberText(value)) extra[name] = value;
    if (BOOLEAN_RELOP_ATTRIBUTES.has(name) && value !== "0" && value !== "1") extra[name] = value;
  }
  return extra;
}

/**
 * Mirrors `readNumber`: an empty or non-numeric attribute is not a number.
 *
 * @param {string} value
 */
function isFiniteNumberText(value) {
  const trimmed = value.trim();
  return trimmed.length > 0 && Number.isFinite(Number(trimmed));
}

/**
 * Numeric RelOp/statement/query-plan attribute. A present but non-numeric value
 * stays `null`; the raw string is preserved in `extra` for RelOp attributes.
 *
 * @param {import("./xml.js").XmlElement|null|undefined} element
 * @param {string} name
 * @returns {number|null}
 */
function readNumber(element, name) {
  const raw = attribute(element, name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * SQL Server booleans are `0` / `1` attributes.
 *
 * @param {import("./xml.js").XmlElement|null|undefined} element
 * @param {string} name
 * @returns {boolean|null}
 */
function readBoolean(element, name) {
  const raw = attribute(element, name);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

/**
 * First `ScalarOperator@ScalarString` inside an element (or the element
 * itself).
 *
 * @param {import("./xml.js").XmlElement|null} element
 * @returns {string|null}
 */
function scalarStringOf(element) {
  if (element === null) return null;
  const own = attribute(element, "ScalarString");
  if (own !== null) return own;

  for (const scalar of findElements(element, "ScalarOperator")) {
    const value = attribute(scalar, "ScalarString");
    if (value !== null) return value;
  }
  return null;
}

/**
 * Human-readable column reference: `[alias].[column]`, falling back to
 * `[table].[column]`, then to a scalar expression string.
 *
 * @param {import("./xml.js").XmlElement} element
 * @returns {string|null}
 */
function renderColumnReference(element) {
  const column = attribute(element, "Column");
  const qualifier = attribute(element, "Alias") ?? attribute(element, "Table") ?? attribute(element, "Schema");
  if (column !== null) return qualifier === null ? column : `${qualifier}.${column}`;
  return attribute(element, "ScalarString");
}

/**
 * @param {import("./xml.js").XmlElement} container
 * @returns {string|null}
 */
function renderColumnReferenceOrExpression(container) {
  const column = findElements(container, "ColumnReference")[0];
  if (column !== undefined) {
    const rendered = renderColumnReference(column);
    if (rendered !== null) return rendered;
  }
  return scalarStringOf(container);
}

/**
 * Column-reference list container (`GroupBy`, `HashKeysBuild`,
 * `HashKeysProbe`, ...). Returns `null` when the container is absent or empty.
 *
 * @param {import("./xml.js").XmlElement|null} container
 * @returns {string[]|null}
 */
function renderColumnList(container) {
  if (container === null) return null;
  const values = [];
  for (const column of findElements(container, "ColumnReference")) {
    const rendered = renderColumnReference(column);
    if (rendered !== null) values.push(rendered);
  }
  return values.length > 0 ? values : null;
}

/**
 * ``Sort`` / ``TopSort`` ordering. Direction is part of the rendered key
 * because losing `ASC` / `DESC` would change the meaning of the plan.
 *
 * @param {import("./xml.js").XmlElement|null} orderBy
 * @returns {string[]|null}
 */
function renderOrderBy(orderBy) {
  if (orderBy === null) return null;

  const keys = [];
  for (const column of orderBy.children.filter((child) => child.name === "OrderByColumn")) {
    const rendered = renderColumnReferenceOrExpression(column);
    if (rendered === null) continue;
    const ascending = attribute(column, "Ascending");
    const direction = ascending === "1" ? " ASC" : ascending === "0" ? " DESC" : "";
    keys.push(`${rendered}${direction}`);
  }
  return keys.length > 0 ? keys : null;
}

/**
 * ``SeekPredicates`` rendered as one deterministic string. The structure stays
 * SQL Server's: every `Prefix` / `StartRange` / `EndRange` keeps its
 * `ScanType`, its range columns and its range expressions.
 *
 * @param {ReturnType<typeof collectScope>} scope
 * @returns {string|null}
 */
function renderSeekPredicates(scope) {
  const seekPredicates = scope.first("SeekPredicates");
  if (seekPredicates === null) return null;

  const parts = [];
  for (const range of descendants(seekPredicates)) {
    if (range.name !== "Prefix" && range.name !== "StartRange" && range.name !== "EndRange") continue;
    const scanType = attribute(range, "ScanType") ?? "";
    const columns = renderColumnList(range);
    const values = [];
    for (const scalar of findElements(range, "ScalarOperator")) {
      const value = attribute(scalar, "ScalarString");
      if (value !== null) values.push(value);
    }

    let text = `${range.name}(${scanType})`;
    if (columns !== null) text += ` ${columns.join(", ")}`;
    if (values.length > 0) text += ` = ${values.join(", ")}`;
    parts.push(text);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Computed scalar expressions of one node (`ComputeScalar`, ...).
 *
 * @param {ReturnType<typeof collectScope>} scope
 * @returns {string[]|null}
 */
function renderDefinedValues(scope) {
  const values = [];
  for (const definedValue of scope.all("DefinedValue")) {
    const value = scalarStringOf(definedValue);
    if (value !== null) values.push(value);
  }
  return values.length > 0 ? values : null;
}
