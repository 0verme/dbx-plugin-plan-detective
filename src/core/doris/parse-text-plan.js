import { PlanInputError, PlanParseError } from "../errors.js";
import { validateRawPlanInput } from "../raw-plan-input.js";

const FRAGMENT_LINE_RE = /^PLAN\s+FRAGMENT\s+(\d+)\b(.*)$/i;
const OPERATOR_LINE_RE = /^([ \t]*(?:\|[ \t]*(?:-{2,})?[ \t]*)*)(\d+)\s*:\s*(.*?)\s*$/;
const PROPERTY_LINE_RE = /^([A-Za-z][A-Za-z0-9 _./()#-]*?)\s*(?::|=)\s*(.*)$/;
const DISTRIBUTIONS = new Set([
  "UNPARTITIONED",
  "RANDOM",
  "HASH_PARTITIONED",
  "BUCKET_SHUFFLE_HASH_PARTITIONED",
  "BROADCAST",
  "COLOCATE",
]);

/**
 * @typedef {{ name: string|null, value: string|null, rawLine: string, lineNumber: number }} ParsedDorisProperty
 * @typedef {Object} ParsedDorisSink
 * @property {string} type
 * @property {string|null} exchangeId
 * @property {string|null} distribution
 * @property {ParsedDorisProperty[]} properties
 * @property {string[]} rawLines
 * @property {Record<string, unknown>} extra
 *
 * @typedef {Object} ParsedDorisNode
 * @property {string} operationId operation identity only; never used to infer parentage
 * @property {string} operator display operator text
 * @property {string} rawOperator exact operator label as printed after the id
 * @property {ParsedDorisProperty[]} properties all recognized and unknown property rows
 * @property {ParsedDorisNode[]} children fragment-local children in Doris logical left-to-right order
 * @property {string[]} rawLines operator header and owned property / unknown lines
 * @property {Record<string, unknown>} extra
 *
 * @typedef {Object} ParsedDorisFragment
 * @property {string} id
 * @property {string[]} outputExpressions
 * @property {string|null} partition
 * @property {boolean|null} hasColoPlanNode
 * @property {ParsedDorisSink|null} sink
 * @property {ParsedDorisNode|null} root
 * @property {ParsedDorisProperty[]} properties
 * @property {string[]} rawLines
 * @property {Record<string, unknown>} extra
 *
 * @typedef {Object} ParsedDorisPlan
 * @property {"doris"} database
 * @property {"text"} format
 * @property {"estimated"} mode
 * @property {ParsedDorisFragment[]} fragments
 * @property {Array<Record<string, unknown>>} exchangeEdges metadata-only producer→receiver edges
 * @property {string} raw
 * @property {string[]} extraLines
 */

/**
 * Tokenize Doris EXPLAIN text without treating indentation as the whole tree
 * grammar. Operator IDs, branch connectors (`|----`), vertical rails, relative
 * columns and the owning section are retained for the local-tree builder.
 *
 * @param {string} text
 * @returns {Array<Record<string, any>>}
 */
export function tokenizeDorisPlan(text) {
  const lines = normalizeLines(text);
  const tokens = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const lineNumber = index + 1;
    if (raw.trim().length === 0) {
      tokens.push({ type: "blank", raw, lineNumber });
      continue;
    }

    const content = stripLeadingRail(raw).trim();
    if (/^PLAN\s+FRAGMENT\b/i.test(content)) {
      const fragment = content.match(FRAGMENT_LINE_RE);
      if (fragment === null) {
        throw parseError("MALFORMED_FRAGMENT", `Malformed Doris PLAN FRAGMENT header on line ${lineNumber}.`);
      }
      tokens.push({
        type: "fragment",
        id: fragment[1],
        description: fragment[2].trim() || null,
        raw,
        lineNumber,
      });
      continue;
    }

    const operator = parseOperatorLine(raw, lineNumber);
    if (operator !== null) {
      tokens.push({ type: "operator", ...operator });
      continue;
    }

    const display = stripLeadingRail(raw).trim();
    if (isSinkHeader(display)) {
      tokens.push({ type: "sink", sinkType: display, raw, lineNumber });
      continue;
    }

    const rails = verticalRailColumns(raw);
    if (rails.length > 0 && stripVerticalRails(raw).trim().length === 0) {
      tokens.push({ type: "branch", rails, raw, lineNumber });
      continue;
    }

    const property = parsePropertyLine(raw, lineNumber);
    if (property !== null) {
      tokens.push({ type: "property", ...property });
      continue;
    }

    tokens.push({ type: "other", content: display, raw, lineNumber });
  }

  return tokens;
}

/**
 * Parse a DBX Doris Estimated Plan RawPlanInput.
 *
 * Fragment headers and plan nodes are required at plan scope. A fragment may
 * have no visible root (for example, an explicitly abridged official EXPLAIN
 * excerpt); its metadata is retained and other fragments remain usable.
 *
 * @param {unknown} input
 * @returns {ParsedDorisPlan}
 * @throws {PlanInputError|PlanParseError}
 */
export function parseDorisTextPlan(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }

  const rawInput = /** @type {import("../raw-plan-input.js").RawPlanInput} */ (input);
  if (rawInput.database !== "doris" || rawInput.format !== "text") {
    throw parseError(
      "MALFORMED_PLAN",
      `Doris text parser expects database "doris" with format "text"; got ${JSON.stringify(rawInput.database)} / ${JSON.stringify(rawInput.format)}.`,
    );
  }
  if (rawInput.mode !== "estimated") {
    throw parseError("MODE_MISMATCH", `Doris EXPLAIN parser accepts mode "estimated" only; got "${rawInput.mode}".`);
  }
  if (typeof rawInput.plan !== "string" || rawInput.plan.trim().length === 0) {
    throw parseError("MALFORMED_PLAN", "Doris EXPLAIN payload must be a non-empty text string.");
  }

  const tokens = tokenizeDorisPlan(rawInput.plan);
  /** @type {ParsedDorisFragment[]} */
  const fragments = [];
  const fragmentIds = new Set();
  /** @type {ParsedDorisFragment|null} */
  let fragment = null;
  /** @type {ParsedDorisSink|null} */
  let sink = null;
  /** @type {ParsedDorisNode|null} */
  let currentNode = null;
  let section = "preamble";
  let outputExpressionsOpen = false;
  /** @type {ParsedDorisNode|null} explicit parent indicated by the latest vertical rail */
  let branchParentHint = null;
  /** @type {Array<{ node: ParsedDorisNode, headerColumn: number }>} */
  let stack = [];
  let operatorCount = 0;
  const extraLines = [];

  for (const token of tokens) {
    if (token.type === "fragment") {
      const fragmentKey = canonicalId(token.id);
      if (fragmentIds.has(fragmentKey)) {
        throw parseError("MALFORMED_FRAGMENT", `Doris EXPLAIN repeats PLAN FRAGMENT ${token.id}.`);
      }
      fragmentIds.add(fragmentKey);
      fragment = createFragment(token.id, token.description, token.raw, token.lineNumber);
      fragments.push(fragment);
      sink = null;
      currentNode = null;
      section = "fragment";
      outputExpressionsOpen = false;
      branchParentHint = null;
      stack = [];
      continue;
    }

    if (fragment === null) {
      if (token.type !== "blank") extraLines.push(token.raw);
      continue;
    }
    if (token.type === "blank") continue;

    if (token.type === "sink") {
      sink = createSink(token.sinkType, token.raw, token.lineNumber);
      if (fragment.sink === null) fragment.sink = sink;
      else {
        // Preserve additional/future sink descriptors without inventing an operator.
        fragment.extra.additionalSinks ??= [];
        fragment.extra.additionalSinks.push(sink);
      }
      currentNode = null;
      section = "sink";
      outputExpressionsOpen = false;
      branchParentHint = null;
      stack = [];
      continue;
    }

    if (token.type === "operator") {
      const node = createNode(token);
      attachLocalOperator(fragment, node, token, stack, branchParentHint);
      stack = token.nextStack;
      branchParentHint = null;
      currentNode = node;
      section = "tree";
      sink = null;
      outputExpressionsOpen = false;
      operatorCount += 1;
      continue;
    }

    if (token.type === "branch") {
      if (section === "tree") {
        const rail = token.rails[token.rails.length - 1];
        while (stack.length > 0 && stack[stack.length - 1].headerColumn > rail) stack.pop();
        currentNode = stack[stack.length - 1]?.node ?? null;
        branchParentHint = currentNode;
      }
      continue;
    }

    if (token.type === "property") {
      if (section === "sink" && sink !== null) {
        sink.properties.push(token.property);
        sink.rawLines.push(token.raw);
        updateSinkFields(sink, token.property);
      } else if (section === "tree" && currentNode !== null) {
        currentNode.properties.push(token.property);
        currentNode.rawLines.push(token.raw);
      } else {
        fragment.properties.push(token.property);
        fragment.rawLines.push(token.raw);
        updateFragmentFields(fragment, token.property);
        outputExpressionsOpen = normalizeName(token.property.name ?? "") === "output exprs";
      }
      continue;
    }

    if (section === "tree" && currentNode !== null) {
      currentNode.rawLines.push(token.raw);
      currentNode.extra.unclassifiedLines ??= [];
      currentNode.extra.unclassifiedLines.push(token.raw);
    } else if (section === "sink" && sink !== null) {
      sink.rawLines.push(token.raw);
      sink.properties.push({ name: null, value: token.content || null, rawLine: token.raw, lineNumber: token.lineNumber });
      updateSinkFields(sink, sink.properties[sink.properties.length - 1]);
    } else if (outputExpressionsOpen) {
      fragment.outputExpressions.push(token.content);
      fragment.rawLines.push(token.raw);
    } else {
      fragment.extra.rawLines ??= [];
      fragment.extra.rawLines.push(token.raw);
      fragment.rawLines.push(token.raw);
    }
  }

  if (fragments.length === 0) {
    throw parseError("MALFORMED_PLAN", "Doris EXPLAIN output does not contain a PLAN FRAGMENT.");
  }
  if (operatorCount === 0) {
    throw parseError("MALFORMED_PLAN", "Doris EXPLAIN output does not contain any PLAN NODE operator.");
  }
  for (const item of fragments) {
    if (item.root !== null) reverseChildrenToLogicalOrder(item.root);
  }

  const exchangeEdges = buildExchangeEdges(fragments);
  return {
    database: "doris",
    format: "text",
    mode: "estimated",
    fragments,
    exchangeEdges,
    raw: rawInput.plan,
    extraLines,
  };
}

/** @param {string} id @param {string|null} description @param {string} raw @param {number} lineNumber */
function createFragment(id, description, raw, lineNumber) {
  return {
    id,
    description,
    outputExpressions: [],
    partition: null,
    hasColoPlanNode: null,
    sink: null,
    root: null,
    properties: [],
    rawLines: [raw],
    extra: { headerLine: lineNumber },
  };
}

/** @param {string} type @param {string} raw @param {number} lineNumber */
function createSink(type, raw, lineNumber) {
  return {
    type,
    exchangeId: null,
    distribution: null,
    properties: [],
    rawLines: [raw],
    extra: { headerLine: lineNumber },
  };
}

/** @param {Record<string, any>} token */
function createNode(token) {
  return {
    operationId: token.operationId,
    operator: token.rawOperator,
    rawOperator: token.rawOperator,
    properties: [],
    children: [],
    rawLines: [token.raw],
    extra: {
      headerColumn: token.headerColumn,
      branchColumn: token.branchColumn,
      branchConnector: token.branchConnector,
    },
  };
}

/**
 * Attach a parsed operator using branch anchor / relative operator columns.
 * Operation IDs are intentionally not consulted for parentage.
 *
 * @param {ParsedDorisFragment} fragment
 * @param {ParsedDorisNode} node
 * @param {Record<string, any>} token
 * @param {Array<{ node: ParsedDorisNode, headerColumn: number }>} stack
 * @param {ParsedDorisNode|null} branchParentHint
 */
function attachLocalOperator(fragment, node, token, stack, branchParentHint) {
  let parent = null;
  let nextStack = [...stack];

  if (token.branchConnector) {
    let parentIndex = -1;
    for (let index = nextStack.length - 1; index >= 0; index -= 1) {
      if (nextStack[index].headerColumn <= token.branchColumn) {
        parentIndex = index;
        break;
      }
    }
    if (parentIndex < 0) {
      throw parseError(
        "MALFORMED_BRANCH_TREE",
        `Doris operator ${token.operationId}:${token.rawOperator} on line ${token.lineNumber} has a branch connector without a local parent.`,
      );
    }
    parent = nextStack[parentIndex].node;
    nextStack = nextStack.slice(0, parentIndex + 1);
  } else {
    while (nextStack.length > 0 && nextStack[nextStack.length - 1].headerColumn > token.headerColumn) nextStack.pop();
    const stackParent = nextStack[nextStack.length - 1] ?? null;
    if (stackParent !== null && token.headerColumn <= stackParent.headerColumn) {
      if (branchParentHint === stackParent.node) parent = branchParentHint;
      else {
        throw parseError(
          "AMBIGUOUS_BRANCH_TREE",
          `Doris operator ${token.operationId}:${token.rawOperator} on line ${token.lineNumber} has no branch connector or unambiguous parent indentation.`,
        );
      }
    } else {
      parent = stackParent?.node ?? null;
    }
  }

  if (parent === null) {
    if (fragment.root !== null) {
      throw parseError("MALFORMED_BRANCH_TREE", `Doris Fragment ${fragment.id} contains multiple local operator roots.`);
    }
    fragment.root = node;
  } else {
    parent.children.push(node);
  }

  nextStack.push({ node, headerColumn: token.headerColumn });
  token.nextStack = nextStack;
}

/** @param {ParsedDorisNode} node */
function reverseChildrenToLogicalOrder(node) {
  node.children.reverse();
  for (const child of node.children) reverseChildrenToLogicalOrder(child);
}

/** @param {ParsedDorisFragment[]} fragments */
function buildExchangeEdges(fragments) {
  const exchangeNodes = [];
  for (const fragment of fragments) {
    if (fragment.root === null) continue;
    visitParsedNodes(fragment.root, (node) => {
      if (isExchangeOperator(node.rawOperator)) exchangeNodes.push({ fragmentId: fragment.id, operationId: node.operationId });
    });
  }

  const edges = [];
  for (const fragment of fragments) {
    const sink = fragment.sink;
    if (sink === null || sink.exchangeId === null) continue;
    const wanted = canonicalId(sink.exchangeId);
    const candidates = exchangeNodes.filter(
      (node) => node.fragmentId !== fragment.id && canonicalId(node.operationId) === wanted,
    );
    const target = candidates.length === 1 ? candidates[0] : null;
    edges.push({
      fromFragment: fragment.id,
      exchangeId: sink.exchangeId,
      distribution: sink.distribution,
      sinkType: sink.type,
      targetExchangeNode: target === null ? null : { ...target },
      resolution: target !== null ? "matched" : candidates.length > 1 ? "ambiguous" : "unmatched",
      candidates: candidates.map((candidate) => ({ ...candidate })),
    });
  }
  return edges;
}

/** @param {ParsedDorisNode} root @param {(node: ParsedDorisNode) => void} visit */
function visitParsedNodes(root, visit) {
  visit(root);
  for (const child of root.children) visitParsedNodes(child, visit);
}

/** @param {string} operator */
function isExchangeOperator(operator) {
  const key = normalizeOperator(operator);
  return key === "VEXCHANGE" || key === "EXCHANGE" || key === "MERGING-EXCHANGE" || key === "VMERGING-EXCHANGE";
}

/** @param {string} id */
function canonicalId(id) {
  return /^\d+$/.test(id) ? id.replace(/^0+(?=\d)/, "") : id;
}

/** @param {string} raw @param {number} lineNumber */
function parseOperatorLine(raw, lineNumber) {
  const match = raw.match(OPERATOR_LINE_RE);
  if (match === null) return null;
  const rawOperator = match[3].trimEnd();
  if (rawOperator.length === 0) {
    throw parseError("MALFORMED_PLAN_NODE", `Doris PLAN NODE on line ${lineNumber} has an empty operator label.`);
  }
  const prefix = match[1];
  const lastRail = prefix.lastIndexOf("|");
  return {
    operationId: match[2],
    rawOperator,
    raw,
    lineNumber,
    headerColumn: prefix.length,
    branchColumn: lastRail < 0 ? null : lastRail,
    branchConnector: /-{2,}[ \t]*$/.test(prefix),
  };
}

/** @param {string} raw @param {number} lineNumber */
function parsePropertyLine(raw, lineNumber) {
  const content = stripLeadingRail(raw).trim();
  const match = content.match(PROPERTY_LINE_RE);
  if (match === null) return null;
  return {
    property: { name: match[1].trim(), value: match[2].trim(), rawLine: raw, lineNumber },
    raw,
    lineNumber,
  };
}

/** @param {string} raw */
function stripLeadingRail(raw) {
  return raw.replace(/^[ \t]*(?:\|[ \t]*(?:-{2,})?[ \t]*)+/, (prefix) => " ".repeat(prefix.replace(/[^ \t]/g, "").length));
}

/** @param {string} raw */
function verticalRailColumns(raw) {
  const columns = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === "|") columns.push(index);
  }
  return columns;
}

/** @param {string} raw */
function stripVerticalRails(raw) {
  return raw.replace(/[|]/g, " ");
}

/** @param {string} content */
function isSinkHeader(content) {
  return /^(?:V?RESULT SINK|STREAM DATA SINK|OLAP TABLE SINK|MULTICAST DATA SINK|[A-Z][A-Z0-9 _-]* SINK)$/i.test(content);
}

/** @param {ParsedDorisFragment} fragment @param {ParsedDorisProperty} property */
function updateFragmentFields(fragment, property) {
  const key = normalizeName(property.name ?? "");
  if (key === "partition") fragment.partition = property.value;
  else if (key === "has colo plan node") {
    const value = property.value.toLowerCase();
    fragment.hasColoPlanNode = value === "true" ? true : value === "false" ? false : null;
  } else if (key === "output exprs") {
    if (property.value.length > 0) fragment.outputExpressions.push(property.value);
  } else if (key === "output expr") {
    if (property.value.length > 0) fragment.outputExpressions.push(property.value);
  } else if (!new Set(["partition", "has colo plan node", "output exprs", "output expr"]).has(key)) {
    fragment.extra.properties ??= [];
    fragment.extra.properties.push(property);
  }
}

/** @param {ParsedDorisSink} sink @param {ParsedDorisProperty} property */
function updateSinkFields(sink, property) {
  const key = normalizeName(property.name ?? "");
  const standalone = normalizeName(property.value ?? "");
  if (key === "exchange id") sink.exchangeId = property.value;
  const candidates = [key, standalone];
  const distribution = candidates.find((candidate) => DISTRIBUTIONS.has(candidate.toUpperCase().replaceAll(" ", "_")));
  if (distribution !== undefined) sink.distribution = distribution.toUpperCase().replaceAll(" ", "_");
}

/** @param {string|null} value */
function normalizeName(value) {
  return value.trim().toLowerCase().replace(/[_\s]+/g, " ");
}

/** @param {string} value */
function normalizeOperator(value) {
  return value.trim().replace(/\s*\(\d+\)\s*$/, "").replace(/[\s_-]+/g, "-").toUpperCase();
}

/** @param {string} text */
function normalizeLines(text) {
  return stripAsciiResultFrame(text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/));
}

/** @param {string[]} lines */
function stripAsciiResultFrame(lines) {
  const nonEmpty = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim().length > 0);
  if (nonEmpty.length < 3) return lines;
  const border = /^\s*\+[+-]+\+\s*$/;
  if (!border.test(nonEmpty[0].line) || !border.test(nonEmpty[nonEmpty.length - 1].line)) return lines;
  const inner = lines.slice(nonEmpty[0].index + 1, nonEmpty[nonEmpty.length - 1].index);
  if (!inner.every((line) => line.trim().length === 0 || /^\s*\|.*\|\s*$/.test(line))) return lines;
  return inner.map((line) => {
    if (line.trim().length === 0) return "";
    const start = line.indexOf("|");
    const end = line.lastIndexOf("|");
    return line.slice(start + 1, end);
  });
}

/** @param {string} text @param {string} message */
function parseError(code, message) {
  return new PlanParseError(code, message);
}
