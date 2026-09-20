import { PlanInputError, PlanParseError } from "../errors.js";
import { validateRawPlanInput } from "../raw-plan-input.js";

/**
 * PostgreSQL `EXPLAIN (FORMAT JSON)` parser.
 *
 * Pipeline position:
 *
 *     RawPlanInput --(this parser)--> ParsedPlan --(normalizer)--> NormalizedPlan
 *
 * The parser is the only PostgreSQL-aware stage before normalization. It maps
 * the PostgreSQL property names onto typed fields, keeps every property it does
 * not map verbatim in `extra`, and never fails on an unknown node type: the
 * node type string and the child list always survive.
 *
 * The parser intentionally does not interpret the plan. Node semantics such as
 * "is this a scan" or "is this node expensive" belong to the normalizer,
 * metrics and rules.
 */

/**
 * Properties that only `EXPLAIN ANALYZE` produces. When the caller declares
 * mode "estimated" their presence is a contract violation, because mixing
 * estimate and runtime values in one node is almost always a caller bug.
 */
const ACTUAL_ONLY_PROPERTIES = Object.freeze([
  "Actual Startup Time",
  "Actual Total Time",
  "Actual Rows",
  "Actual Loops",
  "Rows Removed by Filter",
  "Rows Removed by Join Filter",
  "Heap Fetches",
  "Workers Launched",
]);

/** PostgreSQL property -> parsed field, string valued. */
const STRING_PROPERTIES = new Map([
  ["Relation Name", "relationName"],
  ["Alias", "alias"],
  ["Index Name", "indexName"],
  ["Filter", "filter"],
  ["Index Cond", "indexCondition"],
  ["Recheck Cond", "recheckCondition"],
  ["Hash Cond", "hashCondition"],
  ["Merge Cond", "mergeCondition"],
  ["Join Filter", "joinFilter"],
  ["Join Type", "joinType"],
  ["Parent Relationship", "parentRelationship"],
  ["Subplan Name", "subplanName"],
  ["Strategy", "strategy"],
  ["Partial Mode", "partialMode"],
]);

/** PostgreSQL property -> parsed field, finite number valued. */
const NUMBER_PROPERTIES = new Map([
  ["Startup Cost", "startupCost"],
  ["Total Cost", "totalCost"],
  ["Plan Rows", "planRows"],
  ["Plan Width", "planWidth"],
  ["Actual Startup Time", "actualStartupTime"],
  ["Actual Total Time", "actualTotalTime"],
  ["Actual Rows", "actualRows"],
  ["Actual Loops", "actualLoops"],
]);

/** PostgreSQL property -> parsed field, boolean valued. */
const BOOLEAN_PROPERTIES = new Map([
  ["Parallel Aware", "parallelAware"],
  ["Async Capable", "asyncCapable"],
]);

/**
 * PostgreSQL property -> parsed field, list-of-strings valued. PostgreSQL
 * reports these as arrays; a bare string is accepted as a one-element list so
 * a server-version difference cannot break parsing, but values are never
 * invented.
 */
const STRING_LIST_PROPERTIES = new Map([
  ["Sort Key", "sortKeys"],
  ["Group Key", "groupKeys"],
  ["Presorted Key", "presortedKeys"],
]);

const CHILD_PROPERTY = "Plans";
const NODE_TYPE_PROPERTY = "Node Type";

/**
 * @typedef {Object} ParsedPlanNode
 * @property {string} nodeType raw PostgreSQL node type, always kept
 * @property {string|null} relationName
 * @property {string|null} alias
 * @property {string|null} indexName
 * @property {number|null} startupCost
 * @property {number|null} totalCost
 * @property {number|null} planRows estimated rows
 * @property {number|null} planWidth
 * @property {string|null} filter
 * @property {string|null} indexCondition
 * @property {string|null} recheckCondition
 * @property {string|null} hashCondition
 * @property {string|null} mergeCondition
 * @property {string|null} joinFilter
 * @property {string|null} joinType
 * @property {string|null} parentRelationship
 * @property {string|null} subplanName
 * @property {string[]|null} sortKeys
 * @property {string[]|null} groupKeys
 * @property {string[]|null} presortedKeys
 * @property {boolean|null} parallelAware
 * @property {boolean|null} asyncCapable
 * @property {string|null} strategy
 * @property {string|null} partialMode
 * @property {number|null} actualStartupTime
 * @property {number|null} actualTotalTime
 * @property {number|null} actualRows
 * @property {number|null} actualLoops
 * @property {ParsedPlanNode[]} children
 * @property {Record<string, unknown>} extra native properties the parser does not map
 *
 * @typedef {Object} ParsedPlan
 * @property {"postgresql"} database
 * @property {"json"} format
 * @property {"estimated"|"actual"} mode
 * @property {ParsedPlanNode} root
 */

/**
 * Parse a PostgreSQL `EXPLAIN (FORMAT JSON)` payload.
 *
 * Accepted input is the complete array envelope exactly as returned by the
 * server (`[{ "Plan": { ... } }]`). The inner `Plan` object alone is rejected
 * with a hint about the expected shape.
 *
 * @param {unknown} input a RawPlanInput
 * @returns {ParsedPlan}
 * @throws {PlanInputError} when the RawPlanInput contract is not satisfied
 * @throws {PlanParseError} when the payload is malformed or contradicts `mode`
 */
export function parsePostgresJsonPlan(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }

  // Contract validation guarantees database "postgresql" and format "json".
  // The adapter picks the parser per database, so no second dispatch layer.
  const { mode, plan } = /** @type {import("../raw-plan-input.js").RawPlanInput} */ (input);

  const envelope = readEnvelope(plan);
  const root = parseNode(envelope[0].Plan, "plan[0].Plan", mode);

  return { database: "postgresql", format: "json", mode, root };
}

/**
 * Verify the PostgreSQL JSON envelope and return it.
 *
 * @param {unknown} plan
 * @returns {Array<Record<string, unknown>>}
 */
function readEnvelope(plan) {
  if (Array.isArray(plan)) {
    if (plan.length !== 1) {
      throw new PlanParseError(
        "MALFORMED_PLAN",
        `PostgreSQL EXPLAIN (FORMAT JSON) returns a single-element array envelope; got an array of length ${plan.length}.`,
      );
    }
    const entry = plan[0];
    if (!isPlainObject(entry) || !Object.hasOwn(entry, "Plan")) {
      throw new PlanParseError(
        "MALFORMED_PLAN",
        `plan[0] must be an object with a "Plan" property (the PostgreSQL JSON envelope); got ${describeValue(entry)}.`,
      );
    }
    return /** @type {Array<Record<string, unknown>>} */ (plan);
  }

  if (isPlainObject(plan) && Object.hasOwn(plan, "Plan")) {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      'plan is the inner envelope entry ({ "Plan": ... }), not the full payload. Pass the array returned by EXPLAIN (FORMAT JSON) unchanged.',
    );
  }

  throw new PlanParseError(
    "MALFORMED_PLAN",
    `plan must be the array envelope returned by EXPLAIN (FORMAT JSON); got ${describeValue(plan)}.`,
  );
}

/**
 * @param {unknown} raw
 * @param {string} path location used in error messages, e.g. `plan[0].Plan.Plans[1]`
 * @param {"estimated"|"actual"} mode
 * @returns {ParsedPlanNode}
 */
function parseNode(raw, path, mode) {
  if (!isPlainObject(raw)) {
    throw new PlanParseError("MALFORMED_NODE", `${path} must be an object; got ${describeValue(raw)}.`);
  }

  const nodeType = raw[NODE_TYPE_PROPERTY];
  if (typeof nodeType !== "string" || nodeType.length === 0) {
    throw new PlanParseError(
      "MALFORMED_NODE",
      `${path}["Node Type"] must be a non-empty string; got ${describeValue(nodeType)}.`,
    );
  }

  if (mode === "estimated") {
    const unexpected = ACTUAL_ONLY_PROPERTIES.filter((property) => Object.hasOwn(raw, property));
    if (unexpected.length > 0) {
      throw new PlanParseError(
        "MODE_MISMATCH",
        `${path} is declared mode "estimated" but contains actual-execution propert${unexpected.length === 1 ? "y" : "ies"} (${unexpected.join(", ")}). Use mode "actual" for EXPLAIN ANALYZE output; do not mix Plan Rows with Actual Rows.`,
      );
    }
  }

  /** @type {Record<string, unknown>} */
  const mapped = {};
  for (const [key, field] of STRING_PROPERTIES) mapped[field] = optionalString(raw, key, path);
  for (const [key, field] of NUMBER_PROPERTIES) mapped[field] = optionalNumber(raw, key, path);
  for (const [key, field] of BOOLEAN_PROPERTIES) mapped[field] = optionalBoolean(raw, key, path);
  for (const [key, field] of STRING_LIST_PROPERTIES) mapped[field] = optionalStringList(raw, key, path);

  /** @type {ParsedPlanNode[]} */
  const children = [];
  if (Object.hasOwn(raw, CHILD_PROPERTY)) {
    if (!Array.isArray(raw[CHILD_PROPERTY])) {
      throw new PlanParseError(
        "MALFORMED_NODE",
        `${path}.${CHILD_PROPERTY} must be an array when present; got ${describeValue(raw[CHILD_PROPERTY])}.`,
      );
    }
    raw[CHILD_PROPERTY].forEach((child, index) => {
      children.push(parseNode(child, `${path}.${CHILD_PROPERTY}[${index}]`, mode));
    });
  }

  const extra = collectExtra(raw);

  return {
    nodeType,
    relationName: /** @type {string|null} */ (mapped.relationName),
    alias: /** @type {string|null} */ (mapped.alias),
    indexName: /** @type {string|null} */ (mapped.indexName),
    startupCost: /** @type {number|null} */ (mapped.startupCost),
    totalCost: /** @type {number|null} */ (mapped.totalCost),
    planRows: /** @type {number|null} */ (mapped.planRows),
    planWidth: /** @type {number|null} */ (mapped.planWidth),
    filter: /** @type {string|null} */ (mapped.filter),
    indexCondition: /** @type {string|null} */ (mapped.indexCondition),
    recheckCondition: /** @type {string|null} */ (mapped.recheckCondition),
    hashCondition: /** @type {string|null} */ (mapped.hashCondition),
    mergeCondition: /** @type {string|null} */ (mapped.mergeCondition),
    joinFilter: /** @type {string|null} */ (mapped.joinFilter),
    joinType: /** @type {string|null} */ (mapped.joinType),
    parentRelationship: /** @type {string|null} */ (mapped.parentRelationship),
    subplanName: /** @type {string|null} */ (mapped.subplanName),
    sortKeys: /** @type {string[]|null} */ (mapped.sortKeys),
    groupKeys: /** @type {string[]|null} */ (mapped.groupKeys),
    presortedKeys: /** @type {string[]|null} */ (mapped.presortedKeys),
    parallelAware: /** @type {boolean|null} */ (mapped.parallelAware),
    asyncCapable: /** @type {boolean|null} */ (mapped.asyncCapable),
    strategy: /** @type {string|null} */ (mapped.strategy),
    partialMode: /** @type {string|null} */ (mapped.partialMode),
    actualStartupTime: /** @type {number|null} */ (mapped.actualStartupTime),
    actualTotalTime: /** @type {number|null} */ (mapped.actualTotalTime),
    actualRows: /** @type {number|null} */ (mapped.actualRows),
    actualLoops: /** @type {number|null} */ (mapped.actualLoops),
    children,
    extra,
  };
}

/**
 * Keep every native property the parser does not map, so no server information
 * is lost to the typed model.
 *
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
function collectExtra(raw) {
  const mapped = new Set([NODE_TYPE_PROPERTY, CHILD_PROPERTY]);
  for (const key of STRING_PROPERTIES.keys()) mapped.add(key);
  for (const key of NUMBER_PROPERTIES.keys()) mapped.add(key);
  for (const key of BOOLEAN_PROPERTIES.keys()) mapped.add(key);
  for (const key of STRING_LIST_PROPERTIES.keys()) mapped.add(key);

  /** @type {Record<string, unknown>} */
  const extra = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!mapped.has(key)) extra[key] = value;
  }
  return extra;
}

/**
 * Missing / null -> null. A present value of the wrong type is malformed input:
 * coercing or zero-filling would invent values the server never reported.
 *
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {number|null}
 */
function optionalNumber(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PlanParseError(
      "MALFORMED_NODE",
      `${path}[${JSON.stringify(key)}] must be a finite number when present; got ${describeValue(value)}.`,
    );
  }
  return value;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {string|null}
 */
function optionalString(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new PlanParseError(
      "MALFORMED_NODE",
      `${path}[${JSON.stringify(key)}] must be a string when present; got ${describeValue(value)}.`,
    );
  }
  return value;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {boolean|null}
 */
function optionalBoolean(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw new PlanParseError(
      "MALFORMED_NODE",
      `${path}[${JSON.stringify(key)}] must be a boolean when present; got ${describeValue(value)}.`,
    );
  }
  return value;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @returns {string[]|null}
 */
function optionalStringList(raw, key, path) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return [...value];
  }
  throw new PlanParseError(
    "MALFORMED_NODE",
    `${path}[${JSON.stringify(key)}] must be a string or an array of strings when present; got ${describeValue(value)}.`,
  );
}

/** @param {unknown} value */
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
