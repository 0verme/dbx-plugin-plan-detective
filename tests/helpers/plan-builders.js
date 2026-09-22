/**
 * Test helpers for building parsed / normalized plans by hand.
 *
 * Unit tests for normalize / metrics / rules do not need real PostgreSQL JSON;
 * they need exact control over a few fields. These builders fill the rest with
 * `null` so a test only states what it is actually about.
 */

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {any} a parsed PostgreSQL plan node
 */
export function parsedNode(overrides = {}) {
  return {
    nodeType: "Seq Scan",
    relationName: null,
    alias: null,
    indexName: null,
    startupCost: null,
    totalCost: null,
    planRows: null,
    planWidth: null,
    filter: null,
    indexCondition: null,
    recheckCondition: null,
    hashCondition: null,
    mergeCondition: null,
    joinFilter: null,
    joinType: null,
    parentRelationship: null,
    subplanName: null,
    sortKeys: null,
    groupKeys: null,
    presortedKeys: null,
    parallelAware: null,
    asyncCapable: null,
    strategy: null,
    partialMode: null,
    actualStartupTime: null,
    actualTotalTime: null,
    actualRows: null,
    actualLoops: null,
    children: [],
    extra: {},
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {any} a parsed plan
 */
export function parsedPlan(overrides = {}) {
  return {
    database: "postgresql",
    format: "json",
    mode: "estimated",
    root: parsedNode(),
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {any} a parsed SQL Server ShowPlanXML node
 */
export function parsedSqlServerNode(overrides = {}) {
  return {
    nodeType: "Table Scan",
    physicalOp: "Table Scan",
    logicalOp: "Table Scan",
    nodeId: null,
    estimatedRows: null,
    estimatedTotalSubtreeCost: null,
    estimateCpu: null,
    estimateIo: null,
    estimateRebinds: null,
    estimateRewinds: null,
    estimateExecutions: null,
    avgRowSize: null,
    parallel: null,
    database: null,
    schema: null,
    table: null,
    index: null,
    alias: null,
    indexKind: null,
    storage: null,
    predicate: null,
    indexCondition: null,
    sortKeys: null,
    groupKeys: null,
    hashKeysBuild: null,
    hashKeysProbe: null,
    probeResidual: null,
    buildResidual: null,
    residual: null,
    definedValues: null,
    operator: null,
    children: [],
    extra: {},
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {any} a parsed SQL Server plan
 */
export function parsedSqlServerPlan(overrides = {}) {
  return {
    database: "sqlserver",
    format: "xml",
    mode: "estimated",
    root: parsedSqlServerNode(),
    statement: null,
    queryPlan: null,
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {any} a parsed OceanBase Oracle plan node
 */
export function parsedOceanBaseNode(overrides = {}) {
  return {
    nodeType: "TABLE FULL SCAN",
    operator: "TABLE FULL SCAN",
    nodeId: null,
    name: null,
    estimatedRows: null,
    estimatedTimeUs: null,
    cost: null,
    output: null,
    children: [],
    extra: {},
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {any} a parsed OceanBase Oracle plan
 */
export function parsedOceanBasePlan(overrides = {}) {
  return {
    database: "oceanbase-oracle",
    format: "json",
    mode: "estimated",
    root: parsedOceanBaseNode(),
    ...overrides,
  };
}

const ENGINE_SPECIFIC_DEFAULTS = Object.freeze({
  database: "postgresql",
  parentRelationship: null,
  subplanName: null,
  strategy: null,
  partialMode: null,
  parallelAware: null,
  asyncCapable: null,
  hashCondition: null,
  mergeCondition: null,
  joinFilter: null,
  recheckCondition: null,
  presortedKeys: null,
  extra: {},
});

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {any} a normalized plan node
 */
export function normalizedNode(overrides = {}) {
  return {
    id: "0",
    kind: "seq_scan",
    nodeType: "Seq Scan",
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
    children: [],
    engineSpecific: { ...ENGINE_SPECIFIC_DEFAULTS },
    ...overrides,
  };
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {any} a normalized plan
 */
export function normalizedPlan(overrides = {}) {
  return {
    database: "postgresql",
    mode: "estimated",
    format: "json",
    root: normalizedNode(),
    unknownNodeTypes: [],
    ...overrides,
  };
}
