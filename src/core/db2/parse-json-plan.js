import { PlanInputError, PlanParseError } from "../errors.js";
import { validateRawPlanInput } from "../raw-plan-input.js";

/**
 * @typedef {Object} ParsedDb2Node
 * @property {string|null} operatorId
 * @property {string|null} referenceToOperatorId
 * @property {string} nodeType
 * @property {string|null} totalCost
 * @property {string|null} firstRowCost
 * @property {string|null} ioCost
 * @property {string|null} cpuCost
 * @property {string|null} rowCount
 * @property {Array<Record<string, unknown>>} objects
 * @property {Array<Record<string, unknown>>} predicates
 * @property {Array<Record<string, unknown>>} arguments
 * @property {Array<Record<string, unknown>>} inputStreams
 * @property {Array<Record<string, unknown>>} outputStreams
 * @property {string[]} streamIds
 * @property {Record<string, unknown>} extra
 * @property {boolean} [structural]
 * @property {string} [structuralType]
 * @property {ParsedDb2Node[]} children
 * @property {{statement: Record<string, unknown>|null, streams: Array<Record<string, unknown>>, predicates: Array<Record<string, unknown>>, arguments: Array<Record<string, unknown>>, extra: Record<string, unknown>}} [db2]
 *
 * @typedef {Object} ParsedPlan
 * @property {"db2"} database
 * @property {"json"} format
 * @property {"estimated"} mode
 * @property {ParsedDb2Node} root
 */

/** DB2 LUW Estimated JSON v1 response limits, aligned with DBX's plan viewer. */
export const DB2_PLAN_LIMITS = Object.freeze({
  rawBytes: 5 * 1024 * 1024,
  operators: 2_000,
  streams: 10_000,
  details: 10_000,
  depth: 128,
  displayNodes: 5_000,
});

const OPERATOR_FIELDS = new Set(["id", "type", "totalCost", "firstRowCost", "ioCost", "cpuCost"]);
const STREAM_FIELDS = new Set([
  "id", "sourceType", "sourceId", "targetType", "targetId", "rowCount", "objectSchema", "objectName",
]);
const PREDICATE_FIELDS = new Set(["operatorId", "text", "howApplied"]);
const ARGUMENT_FIELDS = new Set(["operatorId", "type", "value"]);
const ENVELOPE_FIELDS = new Set([
  "version", "databaseType", "requestTag", "statement", "operators", "streams", "predicates", "arguments",
]);

/**
 * Parse a DBX Db2Agent.getExplainInfo() JSON v1 payload.
 * The graph is oriented from producer to consumer in DB2 stream rows. A
 * producer is therefore displayed below its consumer. Shared producers are
 * represented as structural references after their first tree occurrence.
 *
 * @param {unknown} input RawPlanInput
 */
export function parseDb2JsonPlan(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }
  if (input.database !== "db2") {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Expected database "db2"; got ${JSON.stringify(input.database)}.`);
  }
  if (input.mode !== "estimated") {
    throw new PlanParseError("MODE_MISMATCH", 'DB2 LUW JSON parsing supports mode "estimated" only; Actual Plan is not supported.');
  }
  if (input.format !== "json") {
    throw new PlanParseError("UNSUPPORTED_FORMAT", `DB2 LUW parser accepts format "json" only; got ${JSON.stringify(input.format)}.`);
  }

  const payload = readPayload(input.plan);
  if (payload.version !== 1) {
    throw new PlanParseError("UNSUPPORTED_VERSION", `DB2 JSON plan version ${describeValue(payload.version)} is not supported; expected 1.`);
  }
  if (payload.databaseType !== "db2") {
    throw new PlanParseError("DATABASE_TYPE_MISMATCH", `DB2 JSON plan databaseType must be "db2"; got ${describeValue(payload.databaseType)}.`);
  }
  requiredText(payload.requestTag, "requestTag", "plan");

  const statement = payload.statement === undefined ? null : record(payload.statement, "statement", "plan");
  const operatorRows = records(payload.operators, "operators", DB2_PLAN_LIMITS.operators);
  const streamRows = records(payload.streams, "streams", DB2_PLAN_LIMITS.streams);
  const predicateRows = records(payload.predicates, "predicates", DB2_PLAN_LIMITS.details);
  const argumentRows = records(payload.arguments, "arguments", DB2_PLAN_LIMITS.details, true);

  const operators = new Map();
  const operatorOrder = [];
  for (const [index, row] of operatorRows.entries()) {
    const path = `plan.operators[${index}]`;
    const id = requiredText(row.id, "id", path);
    if (operators.has(id)) throw parseError("DUPLICATE_OPERATOR_ID", `${path}.id duplicates operator ${JSON.stringify(id)}.`);
    const nodeType = requiredText(row.type, "type", path);
    const operator = {
      operatorId: id,
      nodeType,
      totalCost: optionalNumericText(row.totalCost, "totalCost", path),
      firstRowCost: optionalNumericText(row.firstRowCost, "firstRowCost", path),
      ioCost: optionalNumericText(row.ioCost, "ioCost", path),
      cpuCost: optionalNumericText(row.cpuCost, "cpuCost", path),
      rowCount: null,
      objects: [],
      predicates: [],
      arguments: [],
      inputStreams: [],
      outputStreams: [],
      childEdges: [],
      extra: unknownFields(row, OPERATOR_FIELDS),
    };
    operators.set(id, operator);
    operatorOrder.push(id);
  }
  if (operators.size === 0) throw parseError("MALFORMED_PLAN", "DB2 JSON plan contains no operators.");

  const streamIds = new Set();
  const streams = streamRows.map((row, index) => {
    const path = `plan.streams[${index}]`;
    const id = requiredText(row.id, "id", path);
    if (streamIds.has(id)) throw parseError("DUPLICATE_STREAM_ID", `${path}.id duplicates stream ${JSON.stringify(id)}.`);
    streamIds.add(id);

    const sourceType = requiredEndpointType(row.sourceType, "sourceType", path);
    const targetType = requiredEndpointType(row.targetType, "targetType", path);
    const sourceId = requiredText(row.sourceId, "sourceId", path);
    const targetId = requiredText(row.targetId, "targetId", path);
    const rowCount = optionalNumericText(row.rowCount, "rowCount", path);
    const stream = {
      id,
      sourceType,
      sourceId,
      targetType,
      targetId,
      rowCount,
      objectSchema: optionalText(row.objectSchema, "objectSchema", path),
      objectName: optionalText(row.objectName, "objectName", path),
      extra: unknownFields(row, STREAM_FIELDS),
    };

    const source = sourceType === "O" ? getOperator(operators, sourceId, `${path}.sourceId`) : null;
    const target = targetType === "O" ? getOperator(operators, targetId, `${path}.targetId`) : null;
    if (source !== null) source.outputStreams.push(stream);
    if (target !== null) target.inputStreams.push(stream);

    // DB2 stream direction is producer (source) -> consumer (target).
    if (source !== null && target !== null) {
      const edge = target.childEdges.find((candidate) => candidate.operatorId === sourceId);
      if (edge === undefined) target.childEdges.push({ operatorId: sourceId, streamIds: [id] });
      else edge.streamIds.push(id);
    }

    // D is a data object, O is an operator. Keep object names as evidence and
    // promote only a single unambiguous object in the normalizer.
    const objectOperator = source !== null && target === null ? source : target !== null && source === null ? target : null;
    if (objectOperator !== null && stream.objectName !== null) {
      const object = {
        schema: stream.objectSchema,
        name: stream.objectName,
        endpoint: sourceType === "D" ? "source" : "target",
        streamId: id,
      };
      objectOperator.objects.push(object);
    }
    return stream;
  });

  for (const [index, row] of predicateRows.entries()) {
    const path = `plan.predicates[${index}]`;
    const operatorId = requiredText(row.operatorId, "operatorId", path);
    const operator = getOperator(operators, operatorId, `${path}.operatorId`);
    operator.predicates.push({
      text: optionalText(row.text, "text", path),
      howApplied: optionalText(row.howApplied, "howApplied", path),
      extra: unknownFields(row, PREDICATE_FIELDS),
    });
  }

  const args = argumentRows.map((row, index) => {
    const path = `plan.arguments[${index}]`;
    const operatorId = requiredText(row.operatorId, "operatorId", path);
    const operator = getOperator(operators, operatorId, `${path}.operatorId`);
    const argument = {
      type: optionalText(row.type, "type", path),
      value: optionalText(row.value, "value", path),
      extra: unknownFields(row, ARGUMENT_FIELDS),
    };
    operator.arguments.push(argument);
    return { operatorId, ...argument };
  });

  for (const operator of operators.values()) {
    const outputRows = operator.outputStreams.map((stream) => stream.rowCount);
    const distinctRows = new Set(outputRows);
    if (outputRows.length > 0 && outputRows.every((value) => value !== null) && distinctRows.size === 1) {
      operator.rowCount = outputRows[0];
    }
  }

  validateGraph(operators, operatorOrder);
  const childOperatorIds = new Set();
  for (const operator of operators.values()) {
    for (const edge of operator.childEdges) childOperatorIds.add(edge.operatorId);
  }
  const rootIds = operatorOrder.filter((id) => !childOperatorIds.has(id));
  if (rootIds.length === 0) throw parseError("MALFORMED_PLAN", "DB2 operator graph has no root operators.");

  const displayed = new Set();
  let displayCount = 1; // the structural plan root
  function displayOperator(id) {
    if (++displayCount > DB2_PLAN_LIMITS.displayNodes) {
      throw parseError("PLAN_TOO_LARGE", `DB2 plan exceeds the display node limit (${DB2_PLAN_LIMITS.displayNodes}).`);
    }
    const source = getOperator(operators, id, "operator graph");
    if (displayed.has(id)) {
      return {
        operatorId: null,
        referenceToOperatorId: id,
        nodeType: `${source.nodeType} (shared reference)`,
        totalCost: null,
        firstRowCost: null,
        ioCost: null,
        cpuCost: null,
        rowCount: null,
        objects: [],
        predicates: [],
        arguments: [],
        inputStreams: [],
        outputStreams: [],
        streamIds: [],
        extra: {},
        structural: true,
        structuralType: "reference",
        children: [],
      };
    }
    displayed.add(id);
    return {
      ...source,
      streamIds: [],
      structural: false,
      children: source.childEdges.map((edge) => ({
        ...displayOperator(edge.operatorId),
        streamIds: [...edge.streamIds],
      })),
    };
  }

  const root = {
    operatorId: null,
    referenceToOperatorId: null,
    nodeType: "DB2 Estimated Plan",
    totalCost: null,
    firstRowCost: null,
    ioCost: null,
    cpuCost: null,
    rowCount: null,
    objects: [],
    predicates: [],
    arguments: [],
    inputStreams: [],
    outputStreams: [],
    streamIds: [],
    structural: true,
    structuralType: "plan",
    children: rootIds.map((id) => displayOperator(id)),
    db2: {
      statement,
      streams,
      predicates: predicateRows.map((row) => ({ ...row })),
      arguments: args,
      extra: unknownFields(payload, ENVELOPE_FIELDS),
    },
  };
  return { database: "db2", format: "json", mode: "estimated", root };
}

/** @param {unknown} raw */
function readPayload(raw) {
  let payload = raw;
  if (typeof raw === "string") {
    assertSize(raw);
    try {
      payload = JSON.parse(raw);
    } catch {
      throw parseError("INVALID_JSON", "DB2 plan is not valid JSON.");
    }
  } else {
    let serialized;
    try {
      serialized = JSON.stringify(raw);
    } catch {
      throw parseError("INVALID_JSON", "DB2 plan is not JSON-serializable.");
    }
    if (typeof serialized !== "string") throw parseError("MALFORMED_PLAN", "DB2 plan must be a JSON object.");
    assertSize(serialized);
  }
  return record(payload, "plan", "plan");
}

/** @param {string} serialized */
function assertSize(serialized) {
  if (new TextEncoder().encode(serialized).byteLength > DB2_PLAN_LIMITS.rawBytes) {
    throw parseError("PLAN_TOO_LARGE", `DB2 plan exceeds the supported size (${DB2_PLAN_LIMITS.rawBytes} bytes).`);
  }
}

/** @param {unknown} value @param {string} label @param {string} path */
function record(value, label, path) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw parseError("MALFORMED_PLAN", `${path} must be an object (${label}).`);
  }
  return value;
}

/** @param {unknown} value @param {string} label @param {number} limit @param {boolean} [optional] */
function records(value, label, limit, optional = false) {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) throw parseError("MALFORMED_PLAN", `plan.${label} must be an array.`);
  if (value.length > limit) throw parseError("PLAN_TOO_LARGE", `DB2 plan ${label} exceed the supported size (${limit}).`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`, `plan.${label}[${index}]`));
}

/** @param {unknown} value @param {string} label @param {string} path */
function requiredText(value, label, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw parseError("MALFORMED_PLAN", `${path}.${label} must be a non-empty string.`);
  }
  return value.trim();
}

/** @param {unknown} value @param {string} label @param {string} path */
function optionalText(value, label, path) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw parseError("MALFORMED_PLAN", `${path}.${label} must be a string when present.`);
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

/** @param {unknown} value @param {string} label @param {string} path */
function optionalNumericText(value, label, path) {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : null;
  if (text === null || !/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    throw parseError("MALFORMED_FIELD", `${path}.${label} must be a non-negative decimal string or finite number.`);
  }
  return text;
}

/** @param {unknown} value @param {string} label @param {string} path */
function requiredEndpointType(value, label, path) {
  const type = requiredText(value, label, path).toUpperCase();
  if (type !== "O" && type !== "D") {
    throw parseError("MALFORMED_PLAN", `${path}.${label} must be "O" (operator) or "D" (data object); got ${JSON.stringify(type)}.`);
  }
  return type;
}

/** @param {Map<string, any>} operators @param {string} id @param {string} path */
function getOperator(operators, id, path) {
  const operator = operators.get(id);
  if (operator === undefined) throw parseError("DANGLING_REFERENCE", `${path} refers to missing operator ${JSON.stringify(id)}.`);
  return operator;
}

/** @param {Map<string, any>} operators @param {string[]} operatorOrder */
function validateGraph(operators, operatorOrder) {
  const heights = new Map();
  const visiting = new Set();
  function visit(id, depth) {
    if (depth > DB2_PLAN_LIMITS.depth) {
      throw parseError("PLAN_TOO_DEEP", `DB2 plan exceeds the supported depth (${DB2_PLAN_LIMITS.depth}).`);
    }
    if (visiting.has(id)) throw parseError("PLAN_CYCLE", `DB2 plan contains a cycle involving operator ${JSON.stringify(id)}.`);
    const knownHeight = heights.get(id);
    if (knownHeight !== undefined) {
      if (depth + knownHeight - 1 > DB2_PLAN_LIMITS.depth) {
        throw parseError("PLAN_TOO_DEEP", `DB2 plan exceeds the supported depth (${DB2_PLAN_LIMITS.depth}).`);
      }
      return knownHeight;
    }
    visiting.add(id);
    let height = 1;
    const operator = getOperator(operators, id, "operator graph");
    for (const edge of operator.childEdges) height = Math.max(height, 1 + visit(edge.operatorId, depth + 1));
    visiting.delete(id);
    if (height > DB2_PLAN_LIMITS.depth) {
      throw parseError("PLAN_TOO_DEEP", `DB2 plan exceeds the supported depth (${DB2_PLAN_LIMITS.depth}).`);
    }
    heights.set(id, height);
    return height;
  }
  for (const id of operatorOrder) visit(id, 1);
}

/** @param {Record<string, unknown>} row @param {Set<string>} known */
function unknownFields(row, known) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !known.has(key)));
}

/** @param {string} code @param {string} message */
function parseError(code, message) {
  return new PlanParseError(code, message);
}

/** @param {unknown} value */
function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length ${value.length})`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}...` : value);
  return `${typeof value}(${String(value)})`;
}
