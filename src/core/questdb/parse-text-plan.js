import { PlanInputError, PlanParseError } from "../errors.js";
import { validateRawPlanInput } from "../raw-plan-input.js";

const INLINE_NODE_TYPES = Object.freeze(
  [
    "Async JIT Filter",
    "Async Filter",
    "Async Window Fast Join",
    "Async Window Join",
    "Frame forward scan",
    "Frame backward scan",
    "Interval forward scan",
    "Row forward scan",
    "Row backward scan",
    "Index forward scan",
    "Index backward scan",
    "Cursor-order scan",
    "Table-order scan",
    "GroupByRecord",
    "Selected Record",
    "SelectedRecord",
    "Encode sort light",
    "Encode sort",
    "Hash Join Light",
    "Hash Join",
    "AsOf Join Fast",
    "AsOf Join Light",
    "Nested Loop Join",
    "Nested Loop",
    "Cross Join",
    "Splice Join",
    "SampleBy",
    "Sample By",
    "GroupBy",
    "Group By",
    "CachedWindow",
    "PageFrame",
    "VirtualRecord",
    "CoveringIndex",
    "PostingIndex",
    "Limit",
    "Filter",
    "Sort light",
    "Sort",
    "Window",
    "Count",
    "Hash",
    "Except",
    "Union",
  ].sort((left, right) => right.length - left.length),
);

const PROPERTY_LINE_RE = /^([A-Za-z_$][A-Za-z0-9_$.-]*):[ \t]*(.*)$/;
const PROPERTY_SUFFIX_RE = /^([A-Za-z_$][A-Za-z0-9_$.-]*):[ \t]*(.*)$/;
const RELATION_SCAN_RE = /^(Frame (?:forward|backward) scan|Interval forward scan) on:[ \t]*(.*)$/i;

/**
 * @typedef {{ name: string, value: string, rawLine: string, indent: number }} ParsedQuestDbProperty
 * @typedef {Object} ParsedQuestDbNode
 * @property {string} nodeType raw operator text, excluding supported inline properties
 * @property {string} rawNodeType same as nodeType; retained as an explicit engine contract field
 * @property {string} rawLine complete source line, including its indentation
 * @property {number} indent number of leading spaces / tabs; only relative comparisons are meaningful
 * @property {string|null} relation relation only from supported `... scan on: <name>` lines
 * @property {string|null} scanDirection direction stated by a forward / backward scan operator
 * @property {ParsedQuestDbProperty[]} properties standalone properties owned by this node
 * @property {ParsedQuestDbProperty[]} inlineProperties properties written on the operator line
 * @property {string|null} filter convenience value from a reported `filter` property
 * @property {string|null} condition convenience value from a reported `condition` property
 * @property {number|null} workers numeric value when the property is a plain finite number
 * @property {string|null} vectorized raw reported value, including `false`
 * @property {ParsedQuestDbNode[]} children
 * @property {Record<string, unknown>} extra reserved for unclassified future details
 *
 * @typedef {Object} QuestDbPlanLine
 * @property {number} indent
 * @property {"node"|"property"} type
 * @property {string} raw complete source line, including indentation
 * @property {string} nodeType only for node lines
 * @property {string|null} relation only when a supported scan `on:` suffix is present
 * @property {ParsedQuestDbProperty[]} inlineProperties only for node lines
 * @property {string} propertyName only for property lines
 * @property {string} propertyValue only for property lines
 * @property {boolean} inline only for property lines
 *
 * @typedef {Object} ParsedQuestDbPlan
 * @property {"questdb"} database
 * @property {"text"} format
 * @property {"estimated"} mode
 * @property {ParsedQuestDbNode} root
 * @property {ParsedQuestDbProperty[]} orphanProperties properties not structurally beneath a node
 */

/**
 * Tokenize QuestDB's line-oriented EXPLAIN tree. Operator names are not used
 * to determine parentage; the `indent` values are compared only relatively.
 * Any one-token `key: value` line is a property, so future property names do
 * not require a growing whitelist. A small list of known operator names
 * is used only to split known `operator property: value` inline forms.
 *
 * @param {string} text
 * @returns {QuestDbPlanLine[]}
 */
export function tokenizeQuestDbPlan(text) {
  const tokens = [];
  const lines = normalizeLines(text);

  for (const raw of lines) {
    const indent = leadingWhitespace(raw);
    const content = raw.slice(indent).trimEnd();
    if (content.trim().length === 0) continue;

    const property = content.match(PROPERTY_LINE_RE);
    if (property !== null) {
      tokens.push({
        indent,
        type: "property",
        raw,
        propertyName: property[1],
        propertyValue: property[2].trim(),
        inline: false,
      });
      continue;
    }

    const relationScan = content.match(RELATION_SCAN_RE);
    if (relationScan !== null) {
      const relation = relationScan[2].trim();
      tokens.push({
        indent,
        type: "node",
        raw,
        nodeType: relationScan[1],
        relation: relation.length === 0 ? null : relation,
        inlineProperties:
          relation.length === 0
            ? [makeProperty("on", "", raw, indent)]
            : [],
      });
      continue;
    }

    const inline = splitInlineProperty(content, raw, indent);
    tokens.push({
      indent,
      type: "node",
      raw,
      nodeType: inline?.nodeType ?? content.trim(),
      relation: null,
      inlineProperties: inline === null ? [] : [inline.property],
    });
  }

  return tokens;
}

/**
 * Parse a RawPlanInput containing the estimated text returned by QuestDB EXPLAIN.
 *
 * @param {unknown} input
 * @returns {ParsedQuestDbPlan}
 * @throws {PlanInputError|PlanParseError}
 */
export function parseQuestDbTextPlan(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }

  const rawInput = /** @type {import("../raw-plan-input.js").RawPlanInput} */ (input);
  if (rawInput.database !== "questdb" || rawInput.format !== "text") {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `QuestDB text parser expects database "questdb" with format "text"; got ${JSON.stringify(rawInput.database)} / ${JSON.stringify(rawInput.format)}.`,
    );
  }
  if (rawInput.mode !== "estimated") {
    throw new PlanParseError("MODE_MISMATCH", `QuestDB EXPLAIN parser accepts mode "estimated" only; got "${rawInput.mode}".`);
  }
  if (typeof rawInput.plan !== "string") {
    throw new PlanParseError("MALFORMED_PLAN", `QuestDB plan must be a text string; got ${describeValue(rawInput.plan)}.`);
  }

  const tokens = tokenizeQuestDbPlan(rawInput.plan);
  const nodes = [];
  const roots = [];
  const orphanProperties = [];
  const stack = [];

  for (const token of tokens) {
    if (token.type === "property") {
      const owner = propertyOwner(stack, token.indent);
      const property = makeProperty(token.propertyName, token.propertyValue, token.raw, token.indent);
      if (owner === null) orphanProperties.push(property);
      else owner.properties.push(property);
      continue;
    }

    while (stack.length > 0 && stack[stack.length - 1].indent >= token.indent) stack.pop();
    const node = {
      nodeType: token.nodeType,
      rawNodeType: token.nodeType,
      rawLine: token.raw,
      indent: token.indent,
      relation: token.relation,
      scanDirection: scanDirectionOf(token.nodeType),
      properties: [],
      inlineProperties: token.inlineProperties,
      filter: null,
      condition: null,
      workers: null,
      vectorized: null,
      children: [],
      extra: {},
    };

    const parent = stack[stack.length - 1]?.node;
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    nodes.push(node);
    stack.push({ indent: token.indent, node });
  }

  if (nodes.length === 0) {
    throw new PlanParseError("MALFORMED_PLAN", "QuestDB EXPLAIN output does not contain any plan node.");
  }
  if (roots.length !== 1) {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `QuestDB EXPLAIN indentation produced ${roots.length} root nodes; expected exactly one.`,
    );
  }

  for (const node of nodes) {
    const allProperties = [...node.inlineProperties, ...node.properties];
    node.filter = firstProperty(allProperties, "filter");
    node.condition = firstProperty(allProperties, "condition");
    node.workers = numericProperty(allProperties, "workers");
    node.vectorized = firstProperty(allProperties, "vectorized");
  }

  return {
    database: "questdb",
    format: "text",
    mode: "estimated",
    root: roots[0],
    orphanProperties,
  };
}

/** @param {string} content @param {string} raw @param {number} indent */
function splitInlineProperty(content, raw, indent) {
  for (const nodeType of INLINE_NODE_TYPES) {
    if (content.length <= nodeType.length || content[nodeType.length] !== " ") continue;
    if (content.slice(0, nodeType.length).toLowerCase() !== nodeType.toLowerCase()) continue;

    const suffix = content.slice(nodeType.length).trimStart().match(PROPERTY_SUFFIX_RE);
    if (suffix === null) continue;
    return {
      nodeType: content.slice(0, nodeType.length),
      property: makeProperty(suffix[1], suffix[2].trim(), raw, indent),
    };
  }
  return null;
}

/** @param {Array<{ indent: number, node: ParsedQuestDbNode }>} stack @param {number} indent */
function propertyOwner(stack, indent) {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index].indent <= indent) return stack[index].node;
  }
  return null;
}

/** @param {string} name @param {string} value @param {string} rawLine @param {number} indent */
function makeProperty(name, value, rawLine, indent) {
  return { name, value, rawLine, indent };
}

/** @param {ParsedQuestDbProperty[]} properties @param {string} name */
function firstProperty(properties, name) {
  return properties.find((property) => property.name.toLowerCase() === name)?.value ?? null;
}

/** @param {ParsedQuestDbProperty[]} properties @param {string} name */
function numericProperty(properties, name) {
  const value = firstProperty(properties, name);
  if (value === null || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {string} nodeType */
function scanDirectionOf(nodeType) {
  return /\bbackward\s+scan\b/i.test(nodeType) ? "backward" : /\bforward\s+scan\b/i.test(nodeType) ? "forward" : null;
}

/** @param {string} text */
function normalizeLines(text) {
  return text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
}

/** @param {string} line */
function leadingWhitespace(line) {
  return line.match(/^[ \t]*/)?.[0].length ?? 0;
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
