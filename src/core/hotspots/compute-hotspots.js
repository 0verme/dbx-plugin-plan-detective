/**
 * Deterministic hotspot analysis.
 *
 * Pipeline position:
 *
 *     NormalizedPlan + Metrics -> computeHotspots() -> HotspotAnalysis
 *
 * A hotspot answers "which node deserves attention first in this plan", not
 * "which known risk pattern fired" (that is the rule engine's job). It
 * aggregates independent, engine-aware signals for one node:
 *
 * - engine-neutral row signals (large sequential scan, nested-loop inner
 *   amplification) read estimated row counts only, and name the native field
 *   each engine reports them in (`Plan Rows`, `rows_examined_per_scan`,
 *   `RelOp@EstimateRows`, `EST.ROWS`);
 * - PostgreSQL cost concentration reads `Total Cost` through the attribution
 *   envelope in ../cost/postgres-cost.js;
 * - MySQL signals read MySQL's own reported values: `rows_examined_per_scan`,
 *   `rows_produced_per_join`, `filtered`, access type, operation flags and
 *   `cost_info` inside one query block;
 * - SQL Server signals read `EstimateRows` from engine-specific plan nodes; no
 *   SQL Server cost is used, because `EstimatedTotalSubtreeCost` is a
 *   cumulative subtree cost in SQL Server's own cost model.
 *
 * There is no combined score and no cross-engine comparison: PostgreSQL, MySQL
 * and SQL Server cost numbers never meet. Ordering is a stated attention order
 * (`level` -> number of reasons -> plan pre-order), not a performance ranking.
 *
 * The stage is pure: it never mutates the plan or metrics, never throws on
 * missing values and leaves every unavailable value as `null` or absent.
 */

import { analyzePostgresCost } from "../cost/postgres-cost.js";
import { flattenNodes } from "../tree.js";
import { HOTSPOT } from "./thresholds.js";

/** Attention ladder, strongest first. */
const LEVEL_RANK = Object.freeze({ high: 0, warning: 1, info: 2 });

/**
 * @typedef {Object} HotspotReason
 * @property {string} code stable reason code
 * @property {"info"|"warning"|"high"} level attention level of this single signal
 * @property {string} statement neutral, evidence-based sentence
 * @property {string} source native plan field(s) the signal reads
 * @property {Record<string, unknown>} evidence signal values and thresholds
 *
 * @typedef {Object} Hotspot
 * @property {string} id deterministic `hotspot:<nodeId>`
 * @property {string} nodeId NormalizedNode id
 * @property {string} nodeType engine label
 * @property {string} kind database-neutral kind
 * @property {string|null} relation
 * @property {"info"|"warning"|"high"} level strongest reason level
 * @property {HotspotReason[]} reasons ordered strongest first
 * @property {Record<string, unknown>} evidence node snapshot plus available signal values
 * @property {true} estimateOnly every current signal comes from planner estimates
 *
 * @typedef {Object} HotspotAnalysis
 * @property {{
 *   engine: "postgresql"|"mysql"|"sqlserver"|"oceanbase-oracle",
 *   status: "available"|"withheld"|"not-applicable",
 *   reason: string|null,
 * }} cost
 * @property {Hotspot[]} items attention-ordered hotspots
 */

/**
 * @param {import("../normalize/normalize-postgres.js").NormalizedPlan} normalized
 * @param {import("../metrics/compute-metrics.js").PlanMetrics} metrics
 * @returns {HotspotAnalysis}
 */
export function computeHotspots(normalized, metrics) {
  const database = normalized.database;
  const cost = costContextFor(normalized, metrics);

  /** @type {Array<{ hotspot: Hotspot, order: number }>} */
  const found = [];

  flattenNodes(normalized.root).forEach((node, order) => {
    const reasons = [];
    if (database === "postgresql") collectPostgresReasons(node, cost, reasons);
    if (database === "mysql") collectMySqlReasons(node, cost, reasons);
    if (database === "sqlserver") collectSqlServerReasons(node, reasons);
    collectNeutralReasons(node, database, reasons);
    if (reasons.length === 0) return;

    reasons.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
    found.push({ hotspot: createHotspot(node, reasons, database, cost), order });
  });

  found.sort(
    (a, b) =>
      LEVEL_RANK[a.hotspot.level] - LEVEL_RANK[b.hotspot.level] ||
      b.hotspot.reasons.length - a.hotspot.reasons.length ||
      a.order - b.order,
  );

  return { cost: cost.summary, items: found.map((entry) => entry.hotspot) };
}

/* ------------------------------------------------------------ cost context -- */

/**
 * Cost context for the plan's engine. Only PostgreSQL runs cumulative-cost
 * attribution; MySQL has its own block-scoped model; SQL Server and OceanBase
 * Oracle do not feed their own cost / time estimates into any cost signal this
 * round, so the stage reports `not-applicable` instead of inventing an
 * attribution.
 *
 * @param {import("../normalize/normalize-postgres.js").NormalizedPlan} normalized
 * @param {import("../metrics/compute-metrics.js").PlanMetrics} metrics
 */
function costContextFor(normalized, metrics) {
  if (normalized.database === "postgresql") return postgresCost(normalized.root, metrics);
  if (normalized.database === "mysql") return mysqlCost(normalized.root);
  return {
    summary: { engine: normalized.database, status: "not-applicable", reason: "NOT_POSTGRES_COST_MODEL" },
    byNodeId: new Map(),
  };
}

/**
 * PostgreSQL attribution summary for the plan. The per-node map is consumed by
 * the cost-concentration signal.
 *
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} root
 * @param {import("../metrics/compute-metrics.js").PlanMetrics} metrics
 */
function postgresCost(root, metrics) {
  const attribution = analyzePostgresCost(root, metrics.totalEstimatedCost);
  return {
    summary: { engine: "postgresql", status: attribution.status, reason: attribution.reason },
    byNodeId: attribution.byNodeId,
  };
}

/**
 * MySQL cost context.
 *
 * MySQL reports `read_cost` already scaled to the join prefix and
 * `eval_cost = row_evaluate_cost(prefix_rowcount)`; `prefix_cost` is their
 * running total. So `read_cost + eval_cost` is this access step's own
 * contribution to its query block, and no PostgreSQL-style child subtraction
 * is needed or allowed. A share is only meaningful when the block contains at
 * least two costed table accesses; a single-access block is always 100% and
 * carries no information.
 *
 * Only nodes whose native structure is `table` count as costed accesses:
 * MySQL also reports `read_cost` on `ordering_operation` /
 * `grouping_operation` entries when a filesort cost is attributed to them
 * (`sql/opt_explain.cc`), which is an operation cost, not a table access.
 *
 * The block denominator is the reported `query_cost`; shares are not claimed
 * to sum to 1 because the block cost can include operation costs as well.
 *
 * @param {import("../normalize/normalize-mysql.js").NormalizedNode} root
 */
function mysqlCost(root) {
  /** @type {Array<{ nodeId: string, queryCost: number|null, entries: Array<{ nodeId: string, readCost: number|null, evalCost: number|null }> }>} */
  const blocks = [];
  let sawQueryCost = false;

  /**
   * @param {import("../normalize/normalize-mysql.js").NormalizedNode} node
   * @param {{ nodeId: string, queryCost: number|null, entries: Array<{ nodeId: string, readCost: number|null, evalCost: number|null }> }|null} block
   */
  function visit(node, block) {
    const mysql = node.engineSpecific?.mysql ?? {};
    let current = block;

    if (node.kind === "query_block") {
      const queryCost = numberOrNull(mysql.queryCost);
      current = { nodeId: node.id, queryCost, entries: [] };
      blocks.push(current);
      if (queryCost !== null && queryCost > 0) sawQueryCost = true;
    }

    const readCost = numberOrNull(mysql.readCost);
    const evalCost = numberOrNull(mysql.evalCost);
    const isTableAccess = mysql.structure === "table";
    if (current !== null && isTableAccess && (readCost !== null || evalCost !== null)) {
      current.entries.push({ nodeId: node.id, readCost, evalCost });
    }

    for (const child of node.children) visit(child, current);
  }

  visit(root, null);

  /** @type {Map<string, { accessCost: number, queryCost: number, costShare: number, blockNodeRef: string }>} */
  const byNodeId = new Map();

  for (const block of blocks) {
    if (block.queryCost === null || block.queryCost <= 0) continue;
    if (block.entries.length < HOTSPOT.mysqlCost.minCostedAccessesPerBlock) continue;

    for (const entry of block.entries) {
      const accessCost = (entry.readCost ?? 0) + (entry.evalCost ?? 0);
      if (accessCost < HOTSPOT.mysqlCost.minAccessCost) continue;
      byNodeId.set(entry.nodeId, {
        accessCost,
        queryCost: block.queryCost,
        costShare: round4(accessCost / block.queryCost),
        blockNodeRef: block.nodeId,
      });
    }
  }

  return {
    summary: sawQueryCost
      ? { engine: "mysql", status: "available", reason: null }
      : { engine: "mysql", status: "withheld", reason: "NO_QUERY_COST" },
    byNodeId,
  };
}

/* -------------------------------------------------------- reason collection -- */

/**
 * Engine-neutral row signals.
 *
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} node
 * @param {string} database
 * @param {HotspotReason[]} reasons
 */
function collectNeutralReasons(node, database, reasons) {
  const largeScan = largeSequentialScanReason(node, database);
  if (largeScan !== null) reasons.push(largeScan);

  const amplification = nestedLoopAmplificationReason(node, database);
  if (amplification !== null) reasons.push(amplification);
}

/**
 * SQL Server row signals. Both read `EstimateRows` and stay inside the nodes
 * that carry it; a seek is deliberately not signalled, because a seek is not
 * evidence of a problem.
 *
 * @param {import("../normalize/normalize-sqlserver.js").NormalizedNode} node
 * @param {HotspotReason[]} reasons
 */
function collectSqlServerReasons(node, reasons) {
  const sqlServer = node.engineSpecific?.sqlServer ?? {};
  const { warningEstimatedRows, highEstimatedRows } = HOTSPOT.sqlserverLargeOperations;

  const physicalOp = sqlServer.physicalOp;
  if (node.kind === "index_scan" && (physicalOp === "Index Scan" || physicalOp === "Clustered Index Scan")) {
    const estimatedRows = numberOrNull(node.estimatedRows);
    const level = estimatedRows === null ? null : levelFor(estimatedRows, warningEstimatedRows, highEstimatedRows);
    if (level !== null) {
      reasons.push({
        code: "sqlserver-large-index-scan",
        level,
        statement:
          `${describeNode(node)} is estimated to read ${estimatedRows} rows through a full ${physicalOp} ` +
          "(a seek is not reported as a scan signal).",
        source: "RelOp@EstimateRows",
        evidence: {
          physicalOp,
          estimatedRows,
          thresholds: { warningEstimatedRows, highEstimatedRows },
        },
      });
    }
  }

  if (node.kind === "sort") {
    const estimatedRows = numberOrNull(node.estimatedRows);
    const level = estimatedRows === null ? null : levelFor(estimatedRows, warningEstimatedRows, highEstimatedRows);
    if (level !== null) {
      reasons.push({
        code: "sqlserver-sort",
        level,
        statement:
          `${describeNode(node)} is estimated to sort ${estimatedRows} rows. ` +
          "The estimate alone does not say whether the sort is required.",
        source: "RelOp@EstimateRows",
        evidence: {
          sortKeys: node.sortKeys,
          estimatedRows,
          thresholds: { warningEstimatedRows, highEstimatedRows },
        },
      });
    }
  }
}

/**
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} node
 * @param {{ byNodeId: Map<string, { selfCost: number, selfCostShare: number }> }} cost
 * @param {HotspotReason[]} reasons
 */
function collectPostgresReasons(node, cost, reasons) {
  const attribution = cost.byNodeId.get(node.id);
  if (attribution === undefined) return;

  const { minSelfCost, warningShare, highShare } = HOTSPOT.postgresCost;
  if (attribution.selfCost < minSelfCost) return;

  const level = levelFor(attribution.selfCostShare, warningShare, highShare);
  if (level === null) return;

  reasons.push({
    code: "cost-concentration",
    level,
    statement:
      `${describeNode(node)} accounts for ${formatShare(attribution.selfCostShare)} of the plan's ` +
      `estimated self cost (${formatCost(attribution.selfCost)} PostgreSQL cost units).`,
    source: "Total Cost",
    evidence: {
      selfCost: attribution.selfCost,
      selfCostShare: attribution.selfCostShare,
      thresholds: { minSelfCost, warningShare, highShare },
    },
  });
}

/**
 * @param {import("../normalize/normalize-mysql.js").NormalizedNode} node
 * @param {{ byNodeId: Map<string, { accessCost: number, queryCost: number, costShare: number, blockNodeRef: string }> }} cost
 * @param {HotspotReason[]} reasons
 */
function collectMySqlReasons(node, cost, reasons) {
  const mysql = node.engineSpecific?.mysql ?? {};
  const rowsExamined = numberOrNull(mysql.rowsExaminedPerScan);

  const rowsReason = mysqlRowsExaminedReason(node, mysql, rowsExamined);
  if (rowsReason !== null) reasons.push(rowsReason);

  const filteredReason = mysqlFilteredReason(node, mysql, rowsExamined);
  if (filteredReason !== null) reasons.push(filteredReason);

  const concentration = mysqlCostConcentrationReason(node, cost.byNodeId.get(node.id));
  if (concentration !== null) reasons.push(concentration);

  const filesort = mysqlFlagReason(node, {
    code: "mysql-filesort",
    flagName: "using_filesort",
    source: "ordering_operation.using_filesort",
    present: mysql.usingFilesort === true,
    evidence: { usingFilesort: true },
  });
  if (filesort !== null) reasons.push(filesort);

  const temporaryTable = mysqlFlagReason(node, {
    code: "mysql-temporary-table",
    flagName: "using_temporary_table",
    source: "*.using_temporary_table",
    present: mysql.usingTemporaryTable === true,
    evidence: { usingTemporaryTable: true },
  });
  if (temporaryTable !== null) reasons.push(temporaryTable);

  const joinBuffer = mysqlFlagReason(node, {
    code: "mysql-join-buffer",
    flagName: "using_join_buffer",
    source: "table.using_join_buffer",
    present: typeof mysql.usingJoinBuffer === "string" && mysql.usingJoinBuffer.length > 0,
    evidence: { usingJoinBuffer: mysql.usingJoinBuffer },
  });
  if (joinBuffer !== null) reasons.push(joinBuffer);
}

/* ------------------------------------------------------------ reason builders -- */

/**
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} node
 * @param {string} database
 * @returns {HotspotReason|null}
 */
function largeSequentialScanReason(node, database) {
  if (node.kind !== "seq_scan") return null;
  const estimatedRows = numberOrNull(node.estimatedRows);
  if (estimatedRows === null) return null;

  const { warningEstimatedRows, highEstimatedRows } = HOTSPOT.largeSequentialScan;
  const level = levelFor(estimatedRows, warningEstimatedRows, highEstimatedRows);
  if (level === null) return null;

  const isMySql = database === "mysql";
  const isSqlServer = database === "sqlserver";
  const source = estimatedRowsSource(database, {
    mysql: "table.rows_examined_per_scan",
    sqlserver: "RelOp@EstimateRows",
  });
  return {
    code: "large-sequential-scan",
    level,
    statement: isMySql
      ? `${describeNode(node)} is estimated to examine ${estimatedRows} rows per scan (access_type = ALL).`
      : isSqlServer
        ? `${describeNode(node)} is estimated to read ${estimatedRows} rows through a full table scan.`
        : `${describeNode(node)} is estimated to return ${estimatedRows} rows.`,
    source,
    evidence: {
      estimatedRows,
      thresholds: { warningEstimatedRows, highEstimatedRows },
    },
  };
}

/**
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} node
 * @param {string} database
 * @returns {HotspotReason|null}
 */
function nestedLoopAmplificationReason(node, database) {
  if (node.kind !== "nested_loop") return null;
  const [outer, inner] = node.children;
  if (outer === undefined || inner === undefined) return null;

  const outerEstimatedRows = numberOrNull(outer.estimatedRows) ?? 0;
  const innerEstimatedRows = numberOrNull(inner.estimatedRows) ?? 0;

  const { minOuterEstimatedRows, warningInnerEstimatedRows, highInnerEstimatedRows } = HOTSPOT.nestedLoopAmplification;
  if (outerEstimatedRows < minOuterEstimatedRows || innerEstimatedRows < warningInnerEstimatedRows) return null;

  const level = innerEstimatedRows >= highInnerEstimatedRows ? "high" : "warning";
  const estimatedRowComparisons = outerEstimatedRows * innerEstimatedRows;

  return {
    code: "nested-loop-amplification",
    level,
    statement:
      `Nested Loop is estimated to drive ${outerEstimatedRows} outer rows into ${innerEstimatedRows} inner rows each, ` +
      `about ${estimatedRowComparisons} estimated row comparisons.`,
    source: estimatedRowsSource(database, { mysql: "Plan Rows", sqlserver: "RelOp@EstimateRows" }),
    evidence: {
      outerNodeRef: outer.id,
      innerNodeRef: inner.id,
      outerEstimatedRows,
      innerEstimatedRows,
      estimatedRowComparisons,
      thresholds: { minOuterEstimatedRows, warningInnerEstimatedRows, highInnerEstimatedRows },
    },
  };
}

/**
 * @param {import("../normalize/normalize-mysql.js").NormalizedNode} node
 * @param {Record<string, unknown>} mysql
 * @param {number|null} rowsExamined
 * @returns {HotspotReason|null}
 */
function mysqlRowsExaminedReason(node, mysql, rowsExamined) {
  if (rowsExamined === null || node.kind === "seq_scan") return null;
  if (typeof mysql.accessType !== "string") return null;

  const { warningRowsExamined, highRowsExamined } = HOTSPOT.mysqlRows;
  const level = levelFor(rowsExamined, warningRowsExamined, highRowsExamined);
  if (level === null) return null;

  return {
    code: "mysql-rows-examined",
    level,
    statement:
      `${describeNode(node)} is estimated to examine ${rowsExamined} rows per scan without a full table scan ` +
      `(access_type = ${String(mysql.accessType)}).`,
    source: "table.rows_examined_per_scan",
    evidence: {
      rowsExaminedPerScan: rowsExamined,
      accessType: mysql.accessType ?? null,
      thresholds: { warningRowsExamined, highRowsExamined },
    },
  };
}

/**
 * @param {import("../normalize/normalize-mysql.js").NormalizedNode} node
 * @param {Record<string, unknown>} mysql
 * @param {number|null} rowsExamined
 * @returns {HotspotReason|null}
 */
function mysqlFilteredReason(node, mysql, rowsExamined) {
  const filteredPercent = numberOrNull(mysql.filteredPercent);
  if (filteredPercent === null || rowsExamined === null) return null;

  const { warningFilteredPercent, warningMinRowsExamined, highFilteredPercent, highMinRowsExamined } = HOTSPOT.mysqlFiltered;

  let level = null;
  if (filteredPercent <= highFilteredPercent && rowsExamined >= highMinRowsExamined) level = "high";
  else if (filteredPercent <= warningFilteredPercent && rowsExamined >= warningMinRowsExamined) level = "warning";
  if (level === null) return null;

  return {
    code: "mysql-filtered-out",
    level,
    statement:
      `Only ${filteredPercent}% of the estimated ${rowsExamined} examined rows are expected to pass the access condition ` +
      `(filtered = ${filteredPercent}).`,
    source: "table.filtered",
    evidence: {
      filteredPercent,
      rowsExaminedPerScan: rowsExamined,
      accessType: mysql.accessType ?? null,
      thresholds: { warningFilteredPercent, warningMinRowsExamined, highFilteredPercent, highMinRowsExamined },
    },
  };
}

/**
 * @param {import("../normalize/normalize-mysql.js").NormalizedNode} node
 * @param {{ accessCost: number, queryCost: number, costShare: number, blockNodeRef: string }|undefined} attribution
 * @returns {HotspotReason|null}
 */
function mysqlCostConcentrationReason(node, attribution) {
  if (attribution === undefined) return null;

  const { minAccessCost, warningShare, highShare } = HOTSPOT.mysqlCost;
  if (attribution.accessCost < minAccessCost) return null;

  const level = levelFor(attribution.costShare, warningShare, highShare);
  if (level === null) return null;

  const mysql = node.engineSpecific?.mysql ?? {};
  return {
    code: "mysql-cost-concentration",
    level,
    statement:
      `${describeNode(node)} accounts for ${formatShare(attribution.costShare)} of its query block's estimated MySQL cost ` +
      `(read_cost + eval_cost = ${formatCost(attribution.accessCost)} of ${formatCost(attribution.queryCost)}).`,
    source: "table.cost_info.read_cost + eval_cost / query_block.cost_info.query_cost",
    evidence: {
      readCost: numberOrNull(mysql.readCost),
      evalCost: numberOrNull(mysql.evalCost),
      accessCost: attribution.accessCost,
      queryCost: attribution.queryCost,
      costShare: attribution.costShare,
      blockNodeRef: attribution.blockNodeRef,
      thresholds: { minAccessCost, warningShare, highShare },
    },
  };
}

/**
 * MySQL operation flag (`using_filesort`, `using_temporary_table`,
 * `using_join_buffer`). The flag alone is not a magnitude, so the threshold
 * uses the largest estimated row count in the operation's subtree.
 *
 * @param {import("../normalize/normalize-mysql.js").NormalizedNode} node
 * @param {{ code: string, flagName: string, source: string, present: boolean, evidence: Record<string, unknown> }} input
 * @returns {HotspotReason|null}
 */
function mysqlFlagReason(node, input) {
  if (!input.present) return null;

  const subtreeMaxEstimatedRows = maxSubtreeEstimatedRows(node);
  if (subtreeMaxEstimatedRows === null) return null;

  const { warningSubtreeRows, highSubtreeRows } = HOTSPOT.mysqlFlags;
  const level = levelFor(subtreeMaxEstimatedRows, warningSubtreeRows, highSubtreeRows);
  if (level === null) return null;

  const detail = input.code === "mysql-join-buffer" ? ` (using_join_buffer = ${String(input.evidence.usingJoinBuffer)})` : "";

  return {
    code: input.code,
    level,
    statement:
      `MySQL reports ${input.flagName} for this operation${detail}; the largest estimated row count in its subtree is ` +
      `${subtreeMaxEstimatedRows}.`,
    source: input.source,
    evidence: {
      ...input.evidence,
      subtreeMaxEstimatedRows,
      thresholds: { warningSubtreeRows, highSubtreeRows },
    },
  };
}

/* ------------------------------------------------------------------ helpers -- */

/**
 * Native plan field a row signal reads, per engine. A neutral row signal must
 * name the field the reader can actually find in their own plan: OceanBase's
 * `EST.ROWS` is not PostgreSQL's `Plan Rows`, even though both are planner row
 * estimates. Engines whose neutral row count comes from a derived value
 * (MySQL's nested-loop prefix count) keep the PostgreSQL wording, unchanged.
 *
 * @param {string} database
 * @param {{ mysql: string, sqlserver: string }} sources
 * @returns {string}
 */
function estimatedRowsSource(database, sources) {
  if (database === "mysql") return sources.mysql;
  if (database === "sqlserver") return sources.sqlserver;
  if (database === "oceanbase-oracle") return "EST.ROWS";
  return "Plan Rows";
}

/**
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} node
 * @param {HotspotReason[]} reasons
 * @param {string} database
 * @param {{ byNodeId: Map<string, unknown> }} cost
 * @returns {Hotspot}
 */
function createHotspot(node, reasons, database, cost) {
  return {
    id: `hotspot:${node.id}`,
    nodeId: node.id,
    nodeType: node.nodeType,
    kind: node.kind,
    relation: node.relation?.name ?? null,
    level: strongestLevel(reasons),
    reasons,
    evidence: nodeSnapshot(node, database, cost),
    estimateOnly: true,
  };
}

/**
 * Node snapshot for display. Only values the plan actually reported are copied;
 * a missing engine value is omitted instead of being turned into a meaningless
 * `null` row. Reason-level evidence keeps explicit `null`s where a signal
 * tested for them.
 *
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} node
 * @param {string} database
 * @param {{ byNodeId: Map<string, any> }} cost
 * @returns {Record<string, unknown>}
 */
function nodeSnapshot(node, database, cost) {
  /** @type {Record<string, unknown>} */
  const evidence = {
    nodeId: node.id,
    nodeType: node.nodeType,
    kind: node.kind,
  };
  if (node.relation?.name) evidence.relation = node.relation.name;
  if (typeof node.estimatedRows === "number") evidence.estimatedRows = node.estimatedRows;

  if (database === "postgresql") {
    if (typeof node.startupCost === "number") evidence.startupCost = node.startupCost;
    if (typeof node.totalCost === "number") evidence.estimatedTotalCost = node.totalCost;
    const attribution = cost.byNodeId.get(node.id);
    if (attribution !== undefined) {
      evidence.selfCost = attribution.selfCost;
      evidence.selfCostShare = attribution.selfCostShare;
    }
    return evidence;
  }

  if (database === "sqlserver") {
    const sqlServer = node.engineSpecific?.sqlServer ?? {};
    const engineValues = {
      nodeId: sqlServer.nodeId,
      physicalOp: sqlServer.physicalOp,
      logicalOp: sqlServer.logicalOp,
      estimatedTotalSubtreeCost: sqlServer.estimatedTotalSubtreeCost,
      estimateCpu: sqlServer.estimateCpu,
      estimateIo: sqlServer.estimateIo,
      avgRowSize: sqlServer.avgRowSize,
      parallel: sqlServer.parallel,
      database: sqlServer.database,
      schema: sqlServer.schema,
      table: sqlServer.table,
      index: sqlServer.index,
      alias: sqlServer.alias,
    };
    for (const [key, value] of Object.entries(engineValues)) {
      if (value !== null && value !== undefined) evidence[key] = value;
    }
    return evidence;
  }

  const mysql = node.engineSpecific?.mysql ?? {};
  const engineValues = {
    accessType: mysql.accessType,
    rowsExaminedPerScan: mysql.rowsExaminedPerScan,
    rowsProducedPerJoin: mysql.rowsProducedPerJoin,
    filteredPercent: mysql.filteredPercent,
    usingFilesort: mysql.usingFilesort,
    usingTemporaryTable: mysql.usingTemporaryTable,
    usingJoinBuffer: mysql.usingJoinBuffer,
    queryCost: mysql.queryCost,
    readCost: mysql.readCost,
    evalCost: mysql.evalCost,
    prefixCost: mysql.prefixCost,
  };
  for (const [key, value] of Object.entries(engineValues)) {
    if (value !== null && value !== undefined) evidence[key] = value;
  }

  const attribution = cost.byNodeId.get(node.id);
  if (attribution !== undefined) {
    evidence.accessCost = attribution.accessCost;
    evidence.costShare = attribution.costShare;
    evidence.blockNodeRef = attribution.blockNodeRef;
    if (evidence.queryCost === undefined) evidence.queryCost = attribution.queryCost;
  }
  return evidence;
}

/**
 * Strongest level of a non-empty reason list.
 *
 * @param {HotspotReason[]} reasons
 * @returns {"info"|"warning"|"high"}
 */
function strongestLevel(reasons) {
  return reasons.reduce((level, reason) => (LEVEL_RANK[reason.level] < LEVEL_RANK[level] ? reason.level : level), "info");
}

/**
 * `levelFor(value, warning, high)` -> warning/high/null. Used with either an
 * absolute magnitude or a dimensionless share; both thresholds must belong to
 * the same unit as `value`.
 *
 * @param {number} value
 * @param {number} warning
 * @param {number} high
 * @returns {"warning"|"high"|null}
 */
function levelFor(value, warning, high) {
  if (value >= high) return "high";
  if (value >= warning) return "warning";
  return null;
}

/**
 * Largest estimated row count in a subtree, or `null` when the subtree reports
 * no row estimate at all. Used as the magnitude for MySQL operation flags whose
 * own node carries no row estimate (for example `ordering_operation`).
 *
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} node
 * @returns {number|null}
 */
function maxSubtreeEstimatedRows(node) {
  let max = numberOrNull(node.estimatedRows);
  for (const child of node.children) {
    const childMax = maxSubtreeEstimatedRows(child);
    if (childMax !== null && (max === null || childMax > max)) max = childMax;
  }
  return max;
}

/**
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} node
 * @returns {string}
 */
function describeNode(node) {
  return node.relation?.name ? `${node.nodeType} on ${node.relation.name}` : node.nodeType;
}

/** @param {number} share @returns {string} */
function formatShare(share) {
  return `${round4(share * 100)}%`;
}

/**
 * Cost statements show two decimals; the underlying evidence keeps the raw
 * arithmetic result.
 *
 * @param {number} value
 * @returns {number}
 */
function formatCost(value) {
  return Number(value.toFixed(2));
}

/** @param {unknown} value @returns {number|null} */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** @param {number} value */
function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}
