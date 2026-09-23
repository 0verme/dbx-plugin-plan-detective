const OPERATOR_KIND_BY_KEY = new Map([
  ["VOLAPSCANNODE", "scan"],
  ["OLAPSCANNODE", "scan"],
  ["VSCANNODE", "scan"],
  ["SCANNODE", "scan"],
  ["HIVESCANNODE", "scan"],
  ["HUDISCANNODE", "scan"],
  ["ICEBERGSCANNODE", "scan"],
  ["PAIMONSCANNODE", "scan"],
  ["JDBCSCANNODE", "scan"],
  ["ESSCANNODE", "scan"],
  ["VHASHJOIN", "hash_join"],
  ["HASHJOIN", "hash_join"],
  ["VNESTEDLOOPJOIN", "nested_loop"],
  ["NESTEDLOOPJOIN", "nested_loop"],
  ["VAGGREGATE", "aggregate"],
  ["AGGREGATE", "aggregate"],
  ["ANALYTIC", "analytic"],
  ["SORT", "sort"],
  ["TOPN", "sort"],
  ["PARTITIONTOPN", "sort"],
  ["SELECT", "filter"],
  ["UNION", "append"],
  ["EXCEPT", "setop"],
  ["INTERSECT", "setop"],
  ["VEXCHANGE", "exchange"],
  ["EXCHANGE", "exchange"],
  ["MERGINGEXCHANGE", "exchange"],
  ["VMERGINGEXCHANGE", "exchange"],
  ["REPEATNODE", "repeat"],
  ["ASSERTNUMBEROFROWS", "assert"],
  ["TABLEFUNCTIONNODE", "table_function"],
  ["DATAGENSCANNODE", "table_function"],
]);

/**
 * Doris distributed plan -> the existing single-root NormalizedPlan tree.
 * The root and Fragment nodes are generic structural containers. Only local
 * Plan Nodes are operators; Fragment exchange relationships stay metadata.
 *
 * @param {import("../doris/parse-text-plan.js").ParsedDorisPlan} parsed
 * @returns {import("./normalize-postgres.js").NormalizedPlan}
 */
export function normalizeDorisPlan(parsed) {
  const unknownNodeTypes = new Set();
  const exchangeEdges = parsed.exchangeEdges.map((edge) => ({ ...edge }));
  const root = makeStructuralNode("0", "Doris Distributed Plan", "distributed-plan", {
    fragmentCount: parsed.fragments.length,
    exchangeEdges,
    extraLines: [...parsed.extraLines],
  });

  root.children = parsed.fragments.map((fragment, index) => {
    const fragmentNode = makeStructuralNode(`0.${index}`, `Fragment ${fragment.id}`, "fragment", {
      fragmentId: fragment.id,
      description: fragment.description,
      partition: fragment.partition,
      outputExpressions: [...fragment.outputExpressions],
      hasColoPlanNode: fragment.hasColoPlanNode,
      sinkType: fragment.sink?.type ?? null,
      sinkExchangeId: fragment.sink?.exchangeId ?? null,
      sinkDistribution: fragment.sink?.distribution ?? null,
      sinkProperties: fragment.sink?.properties.map((property) => ({ ...property })) ?? [],
      sinkRawLines: fragment.sink === null ? [] : [...fragment.sink.rawLines],
      properties: fragment.properties.map((property) => ({ ...property })),
      rawLines: [...fragment.rawLines],
      extra: { ...fragment.extra },
    });
    if (fragment.root !== null) {
      fragmentNode.children.push(normalizeOperatorNode(fragment.root, `${fragmentNode.id}.0`, fragment.id, unknownNodeTypes));
    }
    return fragmentNode;
  });

  return {
    database: "doris",
    mode: "estimated",
    format: "text",
    root,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  };
}

/**
 * @param {string} id
 * @param {string} nodeType
 * @param {string} structuralType
 * @param {Record<string, unknown>} doris
 */
function makeStructuralNode(id, nodeType, structuralType, doris) {
  const nativeFields = { structuralType, ...doris };
  return {
    id,
    kind: "structural",
    nodeType,
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
    engineSpecific: {
      database: "doris",
      structural: true,
      doris: nativeFields,
      // The generic inspector consumes `extra`; keep this engine evidence
      // visible without adding a Doris-only component branch.
      extra: nativeFields,
    },
  };
}

/**
 * @param {import("../doris/parse-text-plan.js").ParsedDorisNode} node
 * @param {string} id
 * @param {string} fragmentId
 * @param {Set<string>} unknownNodeTypes
 */
function normalizeOperatorNode(node, id, fragmentId, unknownNodeTypes) {
  const kind = kindOf(node.rawOperator);
  if (kind === "unknown") unknownNodeTypes.add(node.rawOperator);

  const cardinalityProperty = firstProperty(node, "cardinality");
  const parsedCardinality = cardinalityProperty === null ? null : parseDorisNumber(cardinalityProperty.value);
  const cardinality = parsedCardinality !== null && parsedCardinality >= 0 ? parsedCardinality : null;
  const avgRowSize = firstProperty(node, "avgRowSize");
  const table = firstProperty(node, "TABLE");
  const relationName = kind === "scan" && table !== null && table.value.trim().length > 0 ? table.value.trim() : null;
  const joinProperty = firstProperty(node, "join op");
  const parsedJoin = parseJoinOperation(joinProperty?.value ?? null);
  const predicates = allProperties(node, "equal join conjunct");
  const filterProperty = firstProperty(node, "conjuncts");
  const groupBy = firstProperty(node, "group by");
  const orderBy = firstProperty(node, "order by");
  const nativeFields = {
    fragmentId,
    operationId: node.operationId,
    operator: node.rawOperator,
    cardinality: cardinalityProperty?.value ?? null,
    avgRowSize: avgRowSize?.value ?? null,
    table: table?.value ?? null,
    joinOp: joinProperty?.value ?? null,
    joinStrategy: parsedJoin.strategy,
    distributionMode: parsedJoin.strategy,
    equalJoinConjuncts: predicates.map((property) => property.value),
    otherJoinPredicates: valuesFor(node, "other join predicates"),
    runtimeFilters: valuesFor(node, "runtime filters"),
    preaggregation: firstProperty(node, "PREAGGREGATION")?.value ?? null,
    partitions: firstProperty(node, "partitions")?.value ?? null,
    tablets: firstProperty(node, "tablets")?.value ?? null,
    tabletList: firstProperty(node, "tabletList")?.value ?? null,
    numNodes: numericProperty(node, "numNodes"),
    output: valuesFor(node, "output"),
    projections: valuesFor(node, "projections"),
    limit: firstProperty(node, "limit")?.value ?? null,
    offset: firstProperty(node, "offset")?.value ?? null,
    properties: node.properties.map((property) => ({ ...property })),
    rawLines: [...node.rawLines],
    extra: { ...node.extra },
  };

  return {
    id,
    kind,
    nodeType: node.rawOperator,
    relation: relationName === null ? null : { name: relationName, alias: null, indexName: null },
    estimatedRows: cardinality,
    actualRows: null,
    actualStartupTime: null,
    actualTotalTime: null,
    loops: null,
    startupCost: null,
    totalCost: null,
    // Doris describes avgRowSize as an estimate but does not specify a
    // sufficiently clear shared unit; keep it engine-specific, not width.
    width: null,
    filter: filterProperty?.value ?? null,
    joinType: parsedJoin.joinType,
    joinCondition: predicates[0]?.value ?? null,
    indexCondition: null,
    sortKeys: orderBy === null ? null : [orderBy.value],
    groupKeys: groupBy === null ? null : [groupBy.value],
    children: node.children.map((child, index) =>
      normalizeOperatorNode(child, `${id}.${index}`, fragmentId, unknownNodeTypes),
    ),
    engineSpecific: {
      database: "doris",
      doris: nativeFields,
      extra: nativeFields,
    },
  };
}

/** @param {string} operator */
function kindOf(operator) {
  const key = operator.trim().replace(/\s*\(\d+\)\s*$/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return OPERATOR_KIND_BY_KEY.get(key) ?? "unknown";
}

/** @param {string|null} raw */
function parseJoinOperation(raw) {
  if (raw === null) return { joinType: null, strategy: null };
  const match = raw.match(/^\s*(.+?\bJOIN)\s*(?:\(([^)]*)\))?/i);
  if (match === null) return { joinType: null, strategy: null };
  const strategy = match[2]?.trim() || null;
  return { joinType: match[1].trim().toUpperCase(), strategy };
}

/** @param {import("../doris/parse-text-plan.js").ParsedDorisNode} node @param {string} name */
function firstProperty(node, name) {
  const target = normalizeName(name);
  return node.properties.find((property) => normalizeName(property.name ?? "") === target) ?? null;
}

/** @param {import("../doris/parse-text-plan.js").ParsedDorisNode} node @param {string} name */
function allProperties(node, name) {
  const target = normalizeName(name);
  return node.properties.filter((property) => normalizeName(property.name ?? "") === target);
}

/** @param {import("../doris/parse-text-plan.js").ParsedDorisNode} node @param {string} name */
function valuesFor(node, name) {
  return allProperties(node, name).map((property) => property.value);
}

/** @param {import("../doris/parse-text-plan.js").ParsedDorisNode} node @param {string} name */
function numericProperty(node, name) {
  const property = firstProperty(node, name);
  return property === null ? null : parseDorisNumber(property.value);
}

/** @param {string} value */
function parseDorisNumber(value) {
  const normalized = value.trim();
  if (!/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {string} value */
function normalizeName(value) {
  return value.trim().toLowerCase().replace(/[_\s]+/g, " ");
}
