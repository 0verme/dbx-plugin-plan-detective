/**
 * OceanBase `EXPLAIN FORMAT=JSON` parser (JSON -> ParsedPlan).
 *
 * Pipeline position:
 *
 *     RawPlanInput --(this parser)--> ParsedPlan --(normalizer)--> NormalizedPlan
 *
 * The parser is the only OceanBase-aware stage before normalization. It maps
 * the JSON keys the engine actually reports onto typed fields and keeps every
 * other key verbatim, because OceanBase's JSON explain carries the whole
 * "Outputs & filters" (extended / partition) block as additional members.
 *
 * Shape is shared by OceanBase Oracle and MySQL compatibility modes. The
 * Oracle-mode reference and engine JSON plan writer establish the common
 * fields; real MySQL-mode evidence is pinned by its sanitized fixture.
 *
 * ```json
 * {
 *   "ID": 0,
 *   "OPERATOR": "HASH JOIN ",
 *   "NAME": "",
 *   "EST.ROWS": 1,
 *   "EST.TIME(us)": 8,
 *   "output": "output([T101.C1], [T102.C1])",
 *   "CHILD_1": { "ID": 1, "OPERATOR": "TABLE FULL SCAN", "NAME": "T102", ... },
 *   "CHILD_2": { ... }
 * }
 * ```
 *
 * Structural decisions:
 *
 * - the payload is a bare node, not an envelope: the root object *is* the first
 *   operator. There is no `Plan` / `query_block` wrapper to unwrap;
 * - children are `CHILD_<n>` members, where `<n>` is the child's position in the
 *   plan. Positions are not guaranteed to be contiguous or lexicographically
 *   ordered, so children are sorted by the numeric suffix, and any number of
 *   children is accepted (a join may have two, a UNION ALL may have more);
 * - `OPERATOR` is trimmed: the engine pads it (`"HASH JOIN "`), and a trailing
 *   space is not part of the operator name;
 * - a node whose `OPERATOR` is missing or blank keeps its subtree and gets the
 *   placeholder label `"Plan"` — the same fallback DBX's own plan viewer uses.
 *   Unknown operators are never dropped and never turned into a parse error.
 *
 * Numeric fields are strict: `EST.ROWS` / `EST.TIME(us)` / `COST` / `ID` are
 * mapped only when the payload holds a finite JSON number. The engine writes
 * them as JSON numbers, so a string or an unparseable value is preserved in
 * `extra` as evidence instead of being coerced into a number the plan did not
 * report.
 *
 * `COST` is kept as an OceanBase-native value. It is *not* mapped to the
 * PostgreSQL cumulative cost fields: OceanBase cost units are its own cost
 * model, and the shared metrics / rules must not compare them.
 */

import { PlanInputError, PlanParseError } from "../errors.js";
import { validateRawPlanInput } from "../raw-plan-input.js";

/** OceanBase compatibility-mode families handled by the shared JSON plan pipeline. */
const OCEANBASE_DATABASES = new Set(["oceanbase-oracle", "oceanbase-mysql"]);

/** Child member name. `<n>` is the child's plan position, not a tree index. */
const CHILD_KEY = /^CHILD_(\d+)$/;

/** JSON keys this parser maps onto typed fields. */
const MAPPED_KEYS = Object.freeze(["ID", "OPERATOR", "NAME", "EST.ROWS", "EST.TIME(us)", "COST", "output"]);
const MAPPED_KEY_SET = new Set(MAPPED_KEYS);

/** Placeholder operator label for a node the engine did not label. */
const PLACEHOLDER_OPERATOR = "Plan";

/**
 * @typedef {Object} ParsedOceanBaseNode
 * @property {string} nodeType `OPERATOR` trimmed, or `"Plan"` when absent
 * @property {string|null} operator the raw `OPERATOR` label, `null` when the engine reported none
 * @property {number|null} nodeId `ID`
 * @property {string|null} name raw `NAME` (`""` when the engine reports none)
 * @property {number|null} estimatedRows `EST.ROWS`
 * @property {number|null} estimatedTimeUs `EST.TIME(us)`
 * @property {number|null} cost `COST`
 * @property {string|null} output `output`
 * @property {ParsedOceanBaseNode[]} children `CHILD_<n>` members, numeric order
 * @property {Record<string, unknown>} extra every unmapped member, verbatim
 *
 * @typedef {Object} ParsedPlan
 * @property {"oceanbase-oracle"|"oceanbase-mysql"} database
 * @property {"json"} format
 * @property {"estimated"} mode
 * @property {ParsedOceanBaseNode} root
 */

/**
 * Parse an OceanBase JSON estimated plan while preserving its compatibility-mode family.
 *
 * @param {unknown} input a RawPlanInput
 * @returns {ParsedPlan}
 * @throws {PlanInputError} when the RawPlanInput contract is not satisfied
 * @throws {PlanParseError} when the payload is not a plan node object or the
 *   declared mode is not `estimated`
 */
export function parseOceanBaseJsonPlan(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }

  const rawInput = /** @type {import("../raw-plan-input.js").RawPlanInput} */ (input);
  if (!OCEANBASE_DATABASES.has(rawInput.database) || rawInput.format !== "json") {
    throw new PlanInputError(
      "INVALID_RAW_PLAN_INPUT",
      'OceanBase JSON parser requires database "oceanbase-oracle" or "oceanbase-mysql" and format "json".',
    );
  }
  const { database, mode, plan } = rawInput;
  const databaseLabel = database === "oceanbase-oracle" ? "OceanBase Oracle" : "OceanBase MySQL";

  if (mode !== "estimated") {
    throw new PlanParseError(
      "MODE_MISMATCH",
      `${databaseLabel} plans are parsed in mode "estimated" only; the host never returns runtime counters for them.`,
    );
  }

  const root = asPlanNode(plan);
  if (root === null) {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `${databaseLabel} plan payload must be the JSON plan object the host returned; got ${describeValue(plan)}.`,
    );
  }

  if (!looksLikePlanNode(root)) {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `${databaseLabel} plan payload is an object but carries none of the plan members ` +
        `(${MAPPED_KEYS.join(", ")}) or a CHILD_<n> member; it is not a plan node.`,
    );
  }

  return { database, format: "json", mode, root: parseNode(root) };
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>|null} the value when it is a plain object
 */
function asPlanNode(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * A root object is accepted as a plan node when it carries the operator label or
 * at least one object-valued child. This rejects unrelated JSON (an empty
 * object, a config blob, a result row) without demanding fields the engine may
 * legitimately omit on a node.
 *
 * @param {Record<string, unknown>} node
 */
function looksLikePlanNode(node) {
  const operator = node.OPERATOR;
  if (typeof operator === "string" && operator.trim().length > 0) return true;
  return childEntries(node).some(({ child }) => child !== null);
}

/**
 * @param {Record<string, unknown>} node
 * @returns {ParsedOceanBaseNode}
 */
function parseNode(node) {
  /** @type {Record<string, unknown>} */
  const extra = {};

  for (const [key, value] of Object.entries(node)) {
    if (MAPPED_KEY_SET.has(key)) {
      // A mapped member whose value could not be used (a string ID, a numeric
      // string estimate) is kept as evidence: a corrupt value must degrade to
      // "not usable" instead of disappearing. An explicit null is already
      // represented by the typed field's null and carries nothing extra.
      if (value !== null && value !== undefined && !isMapped(key, value)) extra[key] = value;
      continue;
    }
    // Object-valued CHILD_<n> members become tree children below; anything else
    // (a null, a string, an array) is preserved as evidence instead of being
    // silently dropped.
    const childMatch = CHILD_KEY.exec(key);
    if (childMatch !== null && asPlanNode(value) !== null) continue;
    if (value !== undefined) extra[key] = value;
  }

  const children = childEntries(node)
    .filter(({ child }) => child !== null)
    .sort((left, right) => left.position - right.position)
    .map(({ child }) => parseNode(/** @type {Record<string, unknown>} */ (child)));

  return {
    nodeType: operatorLabel(node.OPERATOR),
    operator: rawOperator(node.OPERATOR),
    nodeId: numeric(node.ID),
    name: typeof node.NAME === "string" ? node.NAME : null,
    estimatedRows: numeric(node["EST.ROWS"]),
    estimatedTimeUs: numeric(node["EST.TIME(us)"]),
    cost: numeric(node.COST),
    output: typeof node.output === "string" ? node.output : null,
    children,
    extra,
  };
}

/**
 * `CHILD_<n>` members in payload order, with the numeric position and the value
 * when it is an object. Ordering happens in `parseNode`; this only collects
 * candidates.
 *
 * @param {Record<string, unknown>} node
 * @returns {Array<{ position: number, child: Record<string, unknown>|null }>}
 */
function childEntries(node) {
  const entries = [];
  for (const [key, value] of Object.entries(node)) {
    const match = CHILD_KEY.exec(key);
    if (match === null) continue;
    entries.push({ position: Number(match[1]), child: asPlanNode(value) });
  }
  return entries;
}

/**
 * Whether a mapped member was actually consumed by its typed field. Anything
 * that fails here is preserved in `extra` instead.
 *
 * @param {string} key
 * @param {unknown} value
 */
function isMapped(key, value) {
  if (key === "OPERATOR") return rawOperator(value) !== null;
  if (key === "NAME" || key === "output") return typeof value === "string";
  return numeric(value) !== null;
}

/**
 * @param {unknown} value
 * @returns {string|null} the trimmed operator label the engine reported
 */
function rawOperator(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * @param {unknown} value
 * @returns {string} trimmed operator label, or the placeholder
 */
function operatorLabel(value) {
  return rawOperator(value) ?? PLACEHOLDER_OPERATOR;
}

/**
 * @param {unknown} value
 * @returns {number|null} a finite JSON number, or `null` for anything else
 */
function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Describe an arbitrary value for error messages without dumping payloads. */
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
