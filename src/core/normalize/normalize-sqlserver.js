/**
 * SQL Server parsed plan -> database-neutral NormalizedPlan.
 *
 * The normalizer mirrors the PostgreSQL and MySQL stages: it maps SQL Server
 * `PhysicalOp` labels onto stable semantic `kind` values, promotes the fields
 * metrics and rules care about into database-neutral names, and keeps
 * everything SQL Server-specific under `engineSpecific.sqlServer`.
 *
 * Cost mapping decision (deliberate, see docs/PLAN_INPUT_AND_FIXTURES.md):
 * `EstimatedTotalSubtreeCost` is a *cumulative subtree* cost, `EstimateCPU` /
 * `EstimateIO` are per-node estimates in SQL Server's own cost model, and none
 * of them are comparable with the PostgreSQL cumulative `Total Cost` the shared
 * cost attribution assumes. This round therefore maps **no** SQL Server cost
 * onto `startupCost` / `totalCost`: those stay `null`, every server-reported
 * cost stays under `engineSpecific.sqlServer`, and the shared metrics report
 * `costAttribution.status = "not-applicable"`. As a consequence the
 * cost-based branches of the existing rules cannot fire for SQL Server; the
 * rules still work through kind / estimated rows.
 *
 * It never interprets cost, never guesses missing values and never depends on
 * the number of nodes: the same input always produces the same output.
 */

/**
 * SQL Server `PhysicalOp` -> stable semantic kind.
 *
 * The map is deliberately finite. `Hash Match` is refined through `LogicalOp`
 * (join / aggregate / other) before the lookup because one physical operator
 * serves several logical operations. Unknown or future operators become
 * `unknown`; the raw label and the whole child subtree are always preserved,
 * and the plan records which raw labels were not classified.
 *
 * Seeks map to `index_scan` like MySQL's index lookups: the shared kind
 * vocabulary has no separate seek kind, and the engine-specific
 * `physicalOp` keeps the distinction for engine-aware signals.
 */
const KIND_BY_PHYSICAL_OP = Object.freeze({
  "Table Scan": "seq_scan",
  "Clustered Index Scan": "index_scan",
  "Index Scan": "index_scan",
  "Columnstore Index Scan": "index_scan",
  "Clustered Index Seek": "index_scan",
  "Index Seek": "index_scan",
  "Key Lookup": "lookup",
  "RID Lookup": "lookup",
  "Nested Loops": "nested_loop",
  "Merge Join": "merge_join",
  Sort: "sort",
  "Top N Sort": "sort",
  "Stream Aggregate": "aggregate",
  "Compute Scalar": "compute_scalar",
  Filter: "filter",
  Concatenation: "append",
  Parallelism: "parallelism",
  "Table Spool": "spool",
  "Index Spool": "spool",
  "Row Count Spool": "spool",
  Top: "limit",
  "Constant Scan": "values_scan",
});

/** Kinds that mean "this node combines two inputs". */
const JOIN_KINDS = new Set(["nested_loop", "hash_join", "merge_join"]);

/**
 * @typedef {Object} NormalizedNode
 * @property {string} id stable path id: "0", "0.0", "0.1.0", ...
 * @property {string} kind semantic kind; "unknown" for unclassified operators
 * @property {string} nodeType raw SQL Server `PhysicalOp` (or `LogicalOp`)
 * @property {{ name: string|null, alias: string|null, indexName: string|null }|null} relation
 * @property {number|null} estimatedRows
 * @property {number|null} actualRows always null: SQL Server estimated plans have no runtime fields
 * @property {number|null} actualStartupTime always null
 * @property {number|null} actualTotalTime always null
 * @property {number|null} loops always null
 * @property {number|null} startupCost always null: SQL Server has no PostgreSQL startup cost
 * @property {number|null} totalCost always null: SQL Server costs stay under engineSpecific
 * @property {number|null} width `AvgRowSize`
 * @property {string|null} filter
 * @property {string|null} joinType `LogicalOp` for join nodes
 * @property {string|null} joinCondition always null: SQL Server residuals stay under engineSpecific
 * @property {string|null} indexCondition rendered `SeekPredicates`
 * @property {string[]|null} sortKeys
 * @property {string[]|null} groupKeys
 * @property {NormalizedNode[]} children
 * @property {Record<string, unknown>} engineSpecific SQL Server-only fields
 *
 * @typedef {Object} NormalizedPlan
 * @property {"sqlserver"} database
 * @property {"estimated"} mode
 * @property {"xml"} format
 * @property {NormalizedNode} root
 * @property {string[]} unknownNodeTypes sorted unique labels that had no kind
 */

/**
 * @param {import("../sqlserver/parse-showplan-xml.js").ParsedPlan} parsed
 * @returns {NormalizedPlan}
 */
export function normalizeSqlServerPlan(parsed) {
  const unknownNodeTypes = new Set();
  const root = normalizeNode(parsed.root, "0", unknownNodeTypes);

  const sqlServer = root.engineSpecific.sqlServer;
  if (parsed.statement !== null) sqlServer.statement = parsed.statement;
  if (parsed.queryPlan !== null) sqlServer.queryPlan = parsed.queryPlan;

  return {
    database: "sqlserver",
    mode: parsed.mode,
    format: parsed.format,
    root,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  };
}

/**
 * @param {import("../sqlserver/parse-showplan-xml.js").ParsedSqlServerNode} node
 * @param {string} id
 * @param {Set<string>} unknownNodeTypes
 * @returns {NormalizedNode}
 */
function normalizeNode(node, id, unknownNodeTypes) {
  const kind = kindOf(node);
  if (kind === "unknown") unknownNodeTypes.add(node.nodeType);

  const hasRelation = node.table !== null || node.alias !== null || node.index !== null;

  return {
    id,
    kind,
    nodeType: node.nodeType,
    relation: hasRelation
      ? { name: identifierOf(node.table), alias: identifierOf(node.alias), indexName: identifierOf(node.index) }
      : null,
    estimatedRows: node.estimatedRows,
    // Estimated ShowPlanXML never carries runtime values; nothing to map.
    actualRows: null,
    actualStartupTime: null,
    actualTotalTime: null,
    loops: null,
    // SQL Server subtree / per-node costs are a different cost model; see the
    // module header for why nothing is promoted here.
    startupCost: null,
    totalCost: null,
    width: node.avgRowSize,
    filter: node.predicate,
    joinType: JOIN_KINDS.has(kind) ? node.logicalOp : null,
    // Residuals and hash keys are SQL Server-specific evidence and stay under
    // engineSpecific instead of being coerced into one neutral string.
    joinCondition: null,
    indexCondition: node.indexCondition,
    sortKeys: node.sortKeys,
    groupKeys: node.groupKeys,
    children: node.children.map((child, index) => normalizeNode(child, `${id}.${index}`, unknownNodeTypes)),
    engineSpecific: {
      database: "sqlserver",
      sqlServer: {
        nodeId: node.nodeId,
        physicalOp: node.physicalOp,
        logicalOp: node.logicalOp,
        estimatedTotalSubtreeCost: node.estimatedTotalSubtreeCost,
        estimateCpu: node.estimateCpu,
        estimateIo: node.estimateIo,
        estimateRebinds: node.estimateRebinds,
        estimateRewinds: node.estimateRewinds,
        estimateExecutions: node.estimateExecutions,
        avgRowSize: node.avgRowSize,
        parallel: node.parallel,
        database: node.database,
        schema: node.schema,
        table: node.table,
        index: node.index,
        alias: node.alias,
        indexKind: node.indexKind,
        storage: node.storage,
        operator: node.operator,
        hashKeysBuild: node.hashKeysBuild,
        hashKeysProbe: node.hashKeysProbe,
        probeResidual: node.probeResidual,
        buildResidual: node.buildResidual,
        residual: node.residual,
        definedValues: node.definedValues,
      },
      extra: node.extra,
    },
  };
}

/**
 * @param {import("../sqlserver/parse-showplan-xml.js").ParsedSqlServerNode} node
 * @returns {string}
 */
function kindOf(node) {
  if (node.physicalOp === "Hash Match") {
    const logicalOp = node.logicalOp ?? "";
    if (logicalOp.includes("Join")) return "hash_join";
    if (logicalOp.includes("Aggregate")) return "aggregate";
    // Hash Match also serves union / distinct / flow-distinct operations; the
    // dedicated kind keeps the label out of `unknownNodeTypes` without
    // pretending it is a join.
    return "hash_match";
  }
  return KIND_BY_PHYSICAL_OP[node.physicalOp] ?? "unknown";
}

/**
 * SQL Server quotes identifiers as `[Name]`, with `]]` escaping a literal `]`.
 * The neutral `relation` fields follow the bare-name style the other engines
 * use, so a label like `Table Scan · Customers` reads the same everywhere; the
 * raw bracketed values stay under `engineSpecific.sqlServer`.
 *
 * @param {string|null} value
 * @returns {string|null}
 */
function identifierOf(value) {
  if (value === null || value.length < 2) return value;
  if (!value.startsWith("[") || !value.endsWith("]")) return value;
  return value.slice(1, -1).replaceAll("]]", "]");
}
