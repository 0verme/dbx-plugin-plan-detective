/** DB2 LUW's finite, evidence-backed operator vocabulary. */
const KIND_BY_OPERATOR = Object.freeze({
  TBSCAN: "scan",
  IXSCAN: "index_scan",
  HSJOIN: "hash_join",
  MSJOIN: "merge_join",
  NLJOIN: "join",
  SORT: "sort",
  GRPBY: "aggregate",
  RETURN: "result",
  TEMP: "materialize",
});

/**
 * Normalize a DB2 LUW estimated plan without promoting timerons or stream
 * cardinality strings to PostgreSQL-style numeric cost / row semantics.
 *
 * @param {import("../db2/parse-json-plan.js").ParsedPlan} parsed
 */
export function normalizeDb2Plan(parsed) {
  const unknownNodeTypes = new Set();
  const firstPathByOperatorId = new Map();
  const root = normalizeNode(parsed.root, "0", unknownNodeTypes, firstPathByOperatorId);
  return {
    database: "db2",
    mode: "estimated",
    format: "json",
    root,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  };
}

/**
 * @param {import("../db2/parse-json-plan.js").ParsedDb2Node} source
 * @param {string} id A deterministic tree path, never a DB2 request or operator ID.
 * @param {Set<string>} unknownNodeTypes
 * @param {Map<string, string>} firstPathByOperatorId
 */
function normalizeNode(source, id, unknownNodeTypes, firstPathByOperatorId) {
  if (source.structural === true) {
    const isReference = source.referenceToOperatorId !== null;
    const referenceTo = isReference ? firstPathByOperatorId.get(source.referenceToOperatorId) ?? null : null;
    return {
      id,
      kind: "structural",
      nodeType: source.nodeType,
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
      children: source.children.map((child, index) => normalizeNode(child, `${id}.${index}`, unknownNodeTypes, firstPathByOperatorId)),
      engineSpecific: {
        database: "db2",
        structural: true,
        db2: {
          structuralType: source.structuralType ?? "plan",
          statement: source.db2?.statement ?? null,
          streams: source.db2?.streams ?? [],
          predicates: source.db2?.predicates ?? [],
          arguments: source.db2?.arguments ?? [],
          referenceTo,
          streamIds: [...(source.streamIds ?? [])],
        },
        extra: source.db2?.extra ?? {},
      },
    };
  }

  const kind = KIND_BY_OPERATOR[source.nodeType.trim().toUpperCase()] ?? "unknown";
  if (kind === "unknown") unknownNodeTypes.add(source.nodeType);

  const objects = uniqueObjects(source.objects);
  const object = objects.length === 1 ? objects[0] : null;
  const isIndexScan = source.nodeType.trim().toUpperCase() === "IXSCAN";
  const qualifiedObjectName = object === null ? null : qualify(object.schema, object.name);
  const relationName = !isIndexScan ? qualifiedObjectName : null;
  const indexName = isIndexScan ? qualifiedObjectName : null;
  const hasRelation = relationName !== null || indexName !== null;
  const rowCount = source.rowCount;
  const estimatedRows = safeInteger(rowCount);

  if (source.operatorId !== null) firstPathByOperatorId.set(source.operatorId, id);

  return {
    id,
    kind,
    nodeType: source.nodeType,
    relation: hasRelation ? { name: relationName, alias: null, indexName } : null,
    // DB2 rowCount is cardinality on an output stream, not rows scanned and
    // never Actual Rows. Only safe integer values fit the shared numeric IR;
    // the exact native decimal remains in engineSpecific.db2.rowCount.
    estimatedRows,
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
    children: source.children.map((child, index) => normalizeNode(child, `${id}.${index}`, unknownNodeTypes, firstPathByOperatorId)),
    engineSpecific: {
      database: "db2",
      db2: {
        operatorId: source.operatorId,
        operatorType: source.nodeType,
        totalCost: source.totalCost,
        firstRowCost: source.firstRowCost,
        ioCost: source.ioCost,
        cpuCost: source.cpuCost,
        rowCount,
        objects,
        predicates: source.predicates.map((predicate) => ({ ...predicate })),
        arguments: source.arguments.map((argument) => ({ ...argument })),
        inputStreams: source.inputStreams.map((stream) => ({ ...stream })),
        outputStreams: source.outputStreams.map((stream) => ({ ...stream })),
        streamIds: [...(source.streamIds ?? [])],
        extra: { ...source.extra },
      },
      extra: { ...source.extra },
    },
  };
}

/** @param {Array<{schema: string|null, name: string, endpoint: string, streamId: string}>} objects */
function uniqueObjects(objects) {
  const unique = new Map();
  for (const object of objects) {
    const key = `${object.schema ?? ""}\u0000${object.name}`;
    if (!unique.has(key)) unique.set(key, { ...object });
  }
  return [...unique.values()];
}

/** @param {string|null} schema @param {string} name */
function qualify(schema, name) {
  return schema === null ? name : `${schema}.${name}`;
}

/** @param {string|null} value */
function safeInteger(value) {
  if (value === null || !/^\+?\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
