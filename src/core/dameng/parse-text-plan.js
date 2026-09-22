import { PlanInputError, PlanParseError } from "../errors.js";
import { validateRawPlanInput } from "../raw-plan-input.js";

const OPERATION_LINE_RE = /^(\s*)(\d+)([ \t]+)#([^:]+):[ \t]*(.*)$/;
const PREDICATE_HEADING_RE = /^Predicate\s+Information\s*\(\s*identified\s+by\s+operation\s+id\s*\)\s*:?\s*$/i;
const ACTUAL_PLAN_RE = /\b(?:EXPLAIN\s+ANALYZE|AUTOTRACE|A-ROWS|A-TIME|ACTUAL\s+ROWS|ACTUAL\s+TIME|RUNTIME\s+STAT(?:ISTICS)?)\b/i;
const NUMBER_RE = /^[+-]?(?:\d[\d,]*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const MISSING_VALUE_RE = /^(?:-|—|NULL)$/i;

/**
 * Dameng DM8 estimated EXPLAIN text parser.
 *
 * The host returns the driver's native text, whose operation rows look like:
 *
 *     1   #NSET2: [1, 12, 56]
 *     2     #PRJT2: [1, 12, 56]; exp_num(2)
 *
 * The three values are Dameng's native `[cost, rows, bytes-per-row]` tuple.
 * They are deliberately kept as Dameng evidence; the first value is not a
 * PostgreSQL `Total Cost`. Tree parentage comes from indentation, while
 * predicates are associated with operation ids from the trailing section.
 */

/**
 * @typedef {Object} ParsedDamengNode
 * @property {string} nodeType normalized operator label without `#`
 * @property {string} operator raw operator label without `#`
 * @property {number|null} id operation id; never used to build the tree
 * @property {number|null} cost Dameng native tuple cost
 * @property {number|null} estimatedRows Dameng native tuple row estimate
 * @property {number|null} bytesPerRow Dameng native bytes-per-row estimate
 * @property {string|null} detail text after the estimate tuple
 * @property {string[]|null} predicates predicate text associated with the operation id
 * @property {number} indentation whitespace depth before `#` (including any leading row indentation)
 * @property {ParsedDamengNode[]} children
 * @property {Record<string, unknown>} extra malformed or future native fields
 *
 * @typedef {Object} ParsedPlan
 * @property {"dameng"} database
 * @property {"text"} format
 * @property {"estimated"} mode
 * @property {ParsedDamengNode} root
 */

/**
 * Parse a RawPlanInput containing a Dameng estimated text plan.
 *
 * @param {unknown} input
 * @returns {ParsedPlan}
 * @throws {PlanInputError}
 * @throws {PlanParseError}
 */
export function parseDamengTextPlan(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }

  const rawInput = /** @type {import("../raw-plan-input.js").RawPlanInput} */ (input);
  if (rawInput.database !== "dameng" || rawInput.format !== "text") {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `Dameng text parser expects database "dameng" with format "text"; got ${JSON.stringify(rawInput.database)} / ${JSON.stringify(rawInput.format)}.`,
    );
  }
  if (rawInput.mode !== "estimated") {
    throw new PlanParseError(
      "MODE_MISMATCH",
      `Dameng plans are parsed in mode "estimated" only; got mode "${rawInput.mode}".`,
    );
  }
  if (typeof rawInput.plan !== "string") {
    throw new PlanParseError("MALFORMED_PLAN", `Dameng plan must be a text string; got ${describeValue(rawInput.plan)}.`);
  }
  if (ACTUAL_PLAN_RE.test(rawInput.plan)) {
    throw new PlanParseError(
      "MODE_MISMATCH",
      "Dameng parser accepts estimated EXPLAIN output only; runtime or autotrace markers were found.",
    );
  }

  const lines = normalizeLines(rawInput.plan);
  const firstOperationIndex = lines.findIndex((line) => OPERATION_LINE_RE.test(line));
  if (firstOperationIndex < 0) {
    throw new PlanParseError("MALFORMED_PLAN", "Dameng EXPLAIN output does not contain an operation row.");
  }

  const predicateHeadingIndex = lines.findIndex(
    (line, index) => index >= firstOperationIndex && PREDICATE_HEADING_RE.test(line.trim()),
  );
  const bodyEnd = predicateHeadingIndex < 0 ? lines.length : predicateHeadingIndex;
  const rows = [];

  for (let index = firstOperationIndex; index < bodyEnd; index += 1) {
    const line = lines[index];
    const match = line.match(OPERATION_LINE_RE);
    if (match !== null) {
      rows.push(parseOperationRow(match));
      continue;
    }

    // Once the first operation row has been found, every non-empty line in
    // the operation section must be another row or a separator. Silently
    // skipping arbitrary text would turn damaged input into a different tree.
    if (isIgnorableLine(line)) continue;
    throw new PlanParseError("MALFORMED_PLAN", `Dameng EXPLAIN operation row is malformed near line ${index + 1}.`);
  }

  if (rows.length === 0) {
    throw new PlanParseError("MALFORMED_PLAN", "Dameng EXPLAIN output contains no operation rows.");
  }

  const predicateById = predicateHeadingIndex < 0 ? new Map() : readPredicates(lines, predicateHeadingIndex + 1);
  for (const row of rows) {
    row.predicates = row.id === null ? null : predicateById.get(row.id) ?? null;
  }

  const roots = buildTree(rows);
  if (roots.length !== 1) {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `Dameng EXPLAIN operation indentation produced ${roots.length} root nodes; expected exactly one root.`,
    );
  }

  return { database: "dameng", format: "text", mode: "estimated", root: roots[0] };
}

/**
 * @param {RegExpMatchArray} match
 * @returns {ParsedDamengNode}
 */
function parseOperationRow(match) {
  // DM8 prints the tree depth in the whitespace between the operation id and
  // `#`; keep any leading whitespace as well for drivers that indent the full
  // row. The id itself is never used to infer parentage.
  const indentation = leadingWhitespace(match[1]) + match[3].length;
  const id = Number(match[2]);
  const operator = match[4].trim();
  if (operator.length === 0 || !Number.isSafeInteger(id)) {
    throw new PlanParseError("MALFORMED_PLAN", "Dameng EXPLAIN operation rows require a numeric id and operator.");
  }

  const tail = match[5].trim();
  const estimate = readEstimateTuple(tail);
  let detail = estimate.rest;
  if (detail.startsWith(";")) detail = detail.slice(1).trim();

  /** @type {Record<string, unknown>} */
  const extra = {};
  if (estimate.raw !== null && !estimate.valid) extra.estimate = estimate.raw;

  return {
    nodeType: operator,
    operator,
    id,
    cost: estimate.cost,
    estimatedRows: estimate.estimatedRows,
    bytesPerRow: estimate.bytesPerRow,
    detail: detail.length > 0 ? detail : null,
    predicates: null,
    indentation,
    children: [],
    extra,
  };
}

/**
 * Read the optional `[cost, rows, bytes-per-row]` tuple without coercing bad
 * values. A partially malformed tuple keeps its original text in `extra` and
 * leaves only individually usable values available to downstream stages.
 *
 * @param {string} text
 * @returns {{ cost: number|null, estimatedRows: number|null, bytesPerRow: number|null, rest: string, raw: string|null, valid: boolean }}
 */
function readEstimateTuple(text) {
  if (!text.startsWith("[")) {
    return { cost: null, estimatedRows: null, bytesPerRow: null, rest: text, raw: null, valid: true };
  }

  const closing = text.indexOf("]");
  if (closing < 0) {
    return { cost: null, estimatedRows: null, bytesPerRow: null, rest: "", raw: text, valid: false };
  }

  const raw = text.slice(0, closing + 1);
  const values = text.slice(1, closing).split(",").map((value) => parseNumber(value.trim()));
  const valid = values.length === 3 && values.every((value) => value !== null);
  return {
    cost: values[0] ?? null,
    estimatedRows: values[1] ?? null,
    bytesPerRow: values[2] ?? null,
    rest: text.slice(closing + 1).trim(),
    raw,
    valid,
  };
}

/**
 * @param {string[]} lines
 * @param {number} startIndex
 * @returns {Map<number, string[]>}
 */
function readPredicates(lines, startIndex) {
  const predicates = new Map();
  let currentId = null;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.length === 0 || isSeparator(line)) continue;
    if (index > startIndex && /^(?:Note|Warning|Warnings|Execution|Error)\b/i.test(trimmed)) break;

    const match = trimmed.match(/^(\d+)\s*-\s*(.+)$/);
    if (match !== null) {
      currentId = Number(match[1]);
      const text = match[2].trim();
      if (text.length > 0) {
        const entries = predicates.get(currentId) ?? [];
        entries.push(text);
        predicates.set(currentId, entries);
      }
      continue;
    }

    // Long predicate expressions may wrap. Keep the continuation attached to
    // the same operation id rather than interpreting it as another tree row.
    if (currentId !== null && trimmed.length > 0) {
      const entries = predicates.get(currentId) ?? [];
      if (entries.length > 0) entries[entries.length - 1] = `${entries[entries.length - 1]} ${trimmed}`;
      else entries.push(trimmed);
      predicates.set(currentId, entries);
    }
  }

  return predicates;
}

/**
 * @param {ParsedDamengNode[]} rows
 * @returns {ParsedDamengNode[]}
 */
function buildTree(rows) {
  const roots = [];
  const stack = [];
  for (const node of rows) {
    while (stack.length > 0 && stack[stack.length - 1].indentation >= node.indentation) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    stack.push({ indentation: node.indentation, node });
  }
  return roots;
}

/** @param {string} text @returns {number|null} */
function parseNumber(text) {
  if (MISSING_VALUE_RE.test(text) || !NUMBER_RE.test(text)) return null;
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/** @param {string} line @returns {boolean} */
function isIgnorableLine(line) {
  return line.trim().length === 0 || isSeparator(line);
}

/** @param {string} line @returns {boolean} */
function isSeparator(line) {
  const trimmed = line.trim();
  return trimmed.length > 0 && /^[\-+=| ]+$/.test(trimmed);
}

/** @param {string} raw @returns {number} */
function leadingWhitespace(raw) {
  const match = raw.match(/^[ \t]*/);
  return match?.[0].length ?? 0;
}

/** @param {string} text @returns {string[]} */
function normalizeLines(text) {
  return text.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
}

/** @param {unknown} value @returns {string} */
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
