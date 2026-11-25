import { PlanInputError, PlanParseError } from "../errors.js";
import { validateRawPlanInput } from "../raw-plan-input.js";

export const DUCKDB_PLAN_LIMITS = Object.freeze({
  rawChars: 2_000_000,
  nodes: 10_000,
  depth: 512,
});

const TOP_LEFT_CORNERS = new Set(["┌", "╭"]);
const TOP_RIGHT_CORNERS = new Set(["┐", "╮"]);
const BOTTOM_LEFT_CORNERS = new Set(["└", "╰"]);
const BOTTOM_RIGHT_CORNERS = new Set(["┘", "╯"]);
const TOP_BORDER_CHARS = new Set(["─", "┴", "┸", "┚", "┖"]);
const BOTTOM_BORDER_CHARS = new Set(["─", "┬", "┰", "┒", "┎"]);
const SIDE_WALL_CHARS = new Set(["│", "┃", "├", "┤", "┟", "┧", "╁", "┠"]);

const BOTTOM_PORT_CHARS = new Set(["┬", "┰", "┒", "┎"]);
const RIGHT_PORT_CHARS = new Set(["├", "┟", "╁", "┠"]);
const LEFT_PORT_CHARS = new Set(["┤", "┧"]);

const FLOW_DOWN_CHARS = new Set(["│", "┃", "┬", "┰", "┐", "┌", "╭", "╮", "├", "┤", "┼", "╁", "┟", "┧", "┎", "┒", "┠"]);
const FLOW_RIGHT_CHARS = new Set(["─", "┬", "┴", "┰", "┸", "┌", "╭", "├", "┼", "╁", "┟", "┎", "┠"]);
const FLOW_LEFT_CHARS = new Set(["─", "┬", "┴", "┰", "┸", "┐", "╮", "┤", "┼", "╁", "┧", "┒"]);

const PLAN_HEADER_TITLES = new Set([
  "physical plan",
  "physical_plan",
  "logical plan",
  "logical_plan",
  "optimized plan",
  "logical_opt",
]);

const KNOWN_JOIN_TYPES = new Set([
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "OUTER",
  "FULL OUTER",
  "LEFT OUTER",
  "RIGHT OUTER",
  "SEMI",
  "ANTI",
  "MARK",
  "SINGLE",
  "POSITIONAL",
  "ASOF",
  "CROSS",
]);

const SEPARATOR_LINE_RE = /^[\s─-]+$/;
const KEY_VALUE_RE = /^([A-Za-z][A-Za-z0-9 _/-]{0,31}):(?:\s*(.*))?$/;
const EC_VALUE_RE = /^(?:EC|Estimated Cardinality):\s*([0-9][0-9,_]*)\s*$/i;
const TILDE_ROWS_RE = /^~\s*([0-9][0-9,_]*)\s+rows?\s*$/i;
const ACTUAL_TIMING_TOKEN_RE = /(?:^|\s)\(?[0-9]+\.[0-9]+\s*(?:s|ms|µs|us)\)?(?:\s|$)/i;
const ACTUAL_ROWS_WITH_TIMING_RE = /^[0-9][0-9,_]*\s+rows?\s+(?:·\s*)?[0-9]+(?:\.[0-9]+)?\s*(?:s|ms|µs|us)\s*$/i;

/**
 * @typedef {{ name: string, value: string }} ParsedDuckDbProperty
 *
 * @typedef {Object} ParsedDuckDbNode
 * @property {string} nodeType display operator name as rendered in the box
 * @property {string} operator canonical uppercase snake_case operator key (for example `"SEQ_SCAN"`)
 * @property {string|null} table target table name when reported
 * @property {number|null} estimatedRows estimated cardinality (`EC` or `~N rows`) when reported
 * @property {string|null} filter filter expression when reported
 * @property {string|null} joinType join type (`INNER`, `LEFT`, ...) when reported
 * @property {string|null} joinCondition join condition expression when reported
 * @property {string[]|null} projections projected columns / expressions when reported
 * @property {string[]|null} sortKeys sort expressions when reported
 * @property {string[]|null} groupKeys grouping expressions when reported
 * @property {ParsedDuckDbProperty[]} properties structured key/value properties extracted from the box
 * @property {string[][]} sections raw text lines grouped by separator within the box
 * @property {{ topRow: number, bottomRow: number, leftCol: number, rightCol: number }} box
 * @property {ParsedDuckDbNode[]} children
 * @property {Record<string, unknown>} extra
 *
 * @typedef {Object} ParsedDuckDbPlan
 * @property {"duckdb"} database
 * @property {"text"} format
 * @property {"estimated"} mode
 * @property {string|null} planHeader optional section title (for example `"Physical Plan"`)
 * @property {ParsedDuckDbNode} root
 */

/**
 * Parse a RawPlanInput containing the text returned by DBX for DuckDB `EXPLAIN`
 * (t8y2/dbx#14899).
 *
 * @param {unknown} input
 * @returns {ParsedDuckDbPlan}
 * @throws {PlanInputError|PlanParseError}
 */
export function parseDuckDbTextPlan(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }

  const rawInput = /** @type {import("../raw-plan-input.js").RawPlanInput} */ (input);
  if (rawInput.database !== "duckdb" || rawInput.format !== "text") {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `DuckDB text parser expects database "duckdb" with format "text"; got ${JSON.stringify(rawInput.database)} / ${JSON.stringify(rawInput.format)}.`,
    );
  }
  if (rawInput.mode !== "estimated") {
    throw new PlanParseError("MODE_MISMATCH", `DuckDB EXPLAIN parser accepts mode "estimated" only; got "${rawInput.mode}".`);
  }
  if (typeof rawInput.plan !== "string" || rawInput.plan.trim().length === 0) {
    throw new PlanParseError("MALFORMED_PLAN", `DuckDB plan must be a non-empty text string; got ${describeValue(rawInput.plan)}.`);
  }
  if (rawInput.plan.length > DUCKDB_PLAN_LIMITS.rawChars) {
    throw new PlanParseError(
      "PLAN_TOO_LARGE",
      `DuckDB EXPLAIN text exceeds the ${DUCKDB_PLAN_LIMITS.rawChars}-character limit.`,
    );
  }

  if (/\bEXPLAIN_ANALYZE\b/i.test(rawInput.plan) || /\bTotal Time:\s*[0-9]/i.test(rawInput.plan)) {
    throw new PlanParseError(
      "MODE_MISMATCH",
      'DuckDB EXPLAIN parser accepts estimated plans only; EXPLAIN ANALYZE output is not supported.',
    );
  }

  const rawLines = rawInput.plan.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const grid = rawLines.map((line) => Array.from(line));
  const { boxes, planHeader } = extractBoxes(grid);

  if (boxes.length === 0) {
    throw new PlanParseError("MALFORMED_PLAN", "DuckDB EXPLAIN output does not contain any recognizable operator box.");
  }
  if (boxes.length > DUCKDB_PLAN_LIMITS.nodes) {
    throw new PlanParseError(
      "PLAN_TOO_LARGE",
      `DuckDB EXPLAIN contains ${boxes.length} operator boxes, exceeding the ${DUCKDB_PLAN_LIMITS.nodes}-node limit.`,
    );
  }

  const parsedNodes = boxes.map((box) => parseOperatorBox(box));
  const childrenByIndex = traceBoxEdges(grid, boxes);
  const incomingCount = new Array(boxes.length).fill(0);

  for (let parentIdx = 0; parentIdx < boxes.length; parentIdx += 1) {
    const childIndices = childrenByIndex[parentIdx];
    childIndices.sort((left, right) => boxes[left].leftCol - boxes[right].leftCol || boxes[left].topRow - boxes[right].topRow);
    for (const childIdx of childIndices) {
      incomingCount[childIdx] += 1;
      if (incomingCount[childIdx] > 1) {
        throw new PlanParseError("MALFORMED_PLAN", `DuckDB EXPLAIN box "${parsedNodes[childIdx].nodeType}" has multiple parent connections.`);
      }
      parsedNodes[parentIdx].children.push(parsedNodes[childIdx]);
    }
  }

  const rootIndices = [];
  for (let index = 0; index < boxes.length; index += 1) {
    if (incomingCount[index] === 0) rootIndices.push(index);
  }

  if (rootIndices.length !== 1) {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `DuckDB EXPLAIN produced ${rootIndices.length} root operator boxes; expected exactly one connected operator tree.`,
    );
  }

  let visitedCount = 0;
  /**
   * @param {ParsedDuckDbNode} node
   * @param {number} depth
   * @param {Set<ParsedDuckDbNode>} ancestors
   */
  function verifyTree(node, depth, ancestors) {
    if (ancestors.has(node)) {
      throw new PlanParseError("MALFORMED_PLAN", "DuckDB EXPLAIN operator boxes contain a cycle.");
    }
    if (depth > DUCKDB_PLAN_LIMITS.depth) {
      throw new PlanParseError("PLAN_TOO_DEEP", `DuckDB EXPLAIN tree depth exceeds the ${DUCKDB_PLAN_LIMITS.depth}-level limit.`);
    }
    visitedCount += 1;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(node);
    for (const child of node.children) {
      verifyTree(child, depth + 1, nextAncestors);
    }
  }

  const root = parsedNodes[rootIndices[0]];
  verifyTree(root, 1, new Set());

  if (visitedCount !== parsedNodes.length) {
    throw new PlanParseError("MALFORMED_PLAN", "DuckDB EXPLAIN contains disconnected operator boxes.");
  }

  return {
    database: "duckdb",
    format: "text",
    mode: "estimated",
    planHeader,
    root,
  };
}

/**
 * Scan the 2D character grid for DuckDB operator boxes, skipping outer frame
 * wrappers around section headers such as "Physical Plan".
 *
 * @param {string[][]} grid
 */
function extractBoxes(grid) {
  /** @type {Array<{ topRow: number, bottomRow: number, leftCol: number, rightCol: number, inlineTitle: string|null, interiorLines: string[] }>} */
  const rawBoxes = [];

  for (let r = 0; r < grid.length; r += 1) {
    const row = grid[r];
    for (let c = 0; c < row.length; c += 1) {
      if (!TOP_LEFT_CORNERS.has(row[c])) continue;

      const match = matchBoxAt(grid, r, c);
      if (match !== null) {
        rawBoxes.push(match);
      }
    }
  }

  // Filter out outer decorative frame boxes that immediately wrap an inner box
  // (`│┌───...───┐│`) and section header boxes (`Physical Plan`).
  let planHeader = null;
  for (const line of grid) {
    const text = line.join("").trim();
    if (PLAN_HEADER_TITLES.has(text.toLowerCase())) {
      planHeader = text;
      break;
    }
  }

  const filtered = [];
  for (let i = 0; i < rawBoxes.length; i += 1) {
    const box = rawBoxes[i];
    const wrapsInnerBox = rawBoxes.some(
      (other, j) =>
        j !== i &&
        other.topRow === box.topRow + 1 &&
        other.bottomRow === box.bottomRow - 1 &&
        other.leftCol === box.leftCol + 1 &&
        other.rightCol === box.rightCol - 1,
    );
    if (wrapsInnerBox) continue;

    const nonEmptyInterior = box.interiorLines.map((line) => line.trim()).filter((line) => line.length > 0);
    if (
      box.inlineTitle === null &&
      nonEmptyInterior.length === 1 &&
      PLAN_HEADER_TITLES.has(nonEmptyInterior[0].toLowerCase())
    ) {
      planHeader = nonEmptyInterior[0];
      continue;
    }

    filtered.push(box);
  }

  return { boxes: filtered, planHeader };
}

/**
 * Check if `(topRow, leftCol)` is the top-left corner of a valid DuckDB box.
 *
 * @param {string[][]} grid
 * @param {number} topRow
 * @param {number} leftCol
 */
function matchBoxAt(grid, topRow, leftCol) {
  const row = grid[topRow];
  let rightCol = -1;
  for (let c = leftCol + 2; c < row.length; c += 1) {
    if (TOP_RIGHT_CORNERS.has(row[c])) {
      rightCol = c;
      break;
    }
    if (TOP_LEFT_CORNERS.has(row[c])) break;
  }
  if (rightCol === -1) return null;

  const topSlice = row.slice(leftCol + 1, rightCol).join("");
  let inlineTitle = null;
  if (!Array.from(topSlice).every((ch) => TOP_BORDER_CHARS.has(ch))) {
    // Modern DuckDB `╭─ Title ──────╮` top border with embedded title
    const titleMatch = topSlice.match(/^─+\s+(.+?)\s+─+$/);
    if (titleMatch === null) return null;
    inlineTitle = titleMatch[1].trim();
  }

  let bottomRow = -1;
  for (let r = topRow + 1; r < grid.length; r += 1) {
    const leftCh = grid[r][leftCol] ?? "";
    const rightCh = grid[r][rightCol] ?? "";
    if (BOTTOM_LEFT_CORNERS.has(leftCh)) {
      if (!BOTTOM_RIGHT_CORNERS.has(rightCh)) return null;
      const bottomChars = grid[r].slice(leftCol + 1, rightCol);
      if (bottomChars.length !== rightCol - leftCol - 1) return null;
      if (!bottomChars.every((ch) => BOTTOM_BORDER_CHARS.has(ch))) return null;
      bottomRow = r;
      break;
    }
    if (!SIDE_WALL_CHARS.has(leftCh) || !SIDE_WALL_CHARS.has(rightCh)) {
      return null;
    }
  }

  if (bottomRow === -1) return null;

  const interiorLines = [];
  for (let r = topRow + 1; r < bottomRow; r += 1) {
    interiorLines.push(grid[r].slice(leftCol + 1, rightCol).join(""));
  }

  return {
    topRow,
    bottomRow,
    leftCol,
    rightCol,
    inlineTitle,
    interiorLines,
  };
}

/**
 * Trace connectors outside boxes from each parent box's output ports (`┬` on the
 * bottom border, `├` on the right wall, `┤` on the left wall) down to child boxes'
 * top borders.
 *
 * @param {string[][]} grid
 * @param {Array<{ topRow: number, bottomRow: number, leftCol: number, rightCol: number }>} boxes
 * @returns {number[][]}
 */
function traceBoxEdges(grid, boxes) {
  /** @type {Map<string, number>} */
  const topBorderOwner = new Map();
  /** @type {Set<string>} */
  const occupiedByBox = new Set();

  boxes.forEach((box, index) => {
    for (let r = box.topRow; r <= box.bottomRow; r += 1) {
      for (let c = box.leftCol; c <= box.rightCol; c += 1) {
        const key = `${r}:${c}`;
        occupiedByBox.add(key);
        if (r === box.topRow && c > box.leftCol && c < box.rightCol) {
          topBorderOwner.set(key, index);
        }
      }
    }
  });

  return boxes.map((box, parentIdx) => {
    /** @type {Array<[number, number]>} */
    const queue = [];

    for (let c = box.leftCol + 1; c < box.rightCol; c += 1) {
      const ch = grid[box.bottomRow][c] ?? "";
      if (BOTTOM_PORT_CHARS.has(ch)) {
        queue.push([box.bottomRow + 1, c]);
      }
    }
    for (let r = box.topRow + 1; r < box.bottomRow; r += 1) {
      const rightCh = grid[r][box.rightCol] ?? "";
      if (RIGHT_PORT_CHARS.has(rightCh)) {
        queue.push([r, box.rightCol + 1]);
      }
      const leftCh = grid[r][box.leftCol] ?? "";
      if (LEFT_PORT_CHARS.has(leftCh)) {
        queue.push([r, box.leftCol - 1]);
      }
    }

    const visited = new Set();
    const childSet = new Set();

    while (queue.length > 0) {
      const [r, c] = /** @type {[number, number]} */ (queue.shift());
      if (r < 0 || r >= grid.length || c < 0 || c >= (grid[r]?.length ?? 0)) continue;
      const key = `${r}:${c}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const hitChild = topBorderOwner.get(key);
      if (hitChild !== undefined && hitChild !== parentIdx) {
        childSet.add(hitChild);
        continue;
      }

      if (occupiedByBox.has(key)) continue;

      const ch = grid[r][c] ?? "";
      if (FLOW_DOWN_CHARS.has(ch)) {
        queue.push([r + 1, c]);
      }
      if (FLOW_RIGHT_CHARS.has(ch)) {
        queue.push([r, c + 1]);
      }
      if (FLOW_LEFT_CHARS.has(ch)) {
        queue.push([r, c - 1]);
      }
    }

    return [...childSet];
  });
}

/**
 * Parse the interior sections of one DuckDB operator box.
 *
 * @param {{ topRow: number, bottomRow: number, leftCol: number, rightCol: number, inlineTitle: string|null, interiorLines: string[] }} rawBox
 * @returns {ParsedDuckDbNode}
 */
function parseOperatorBox(rawBox) {
  /** @type {string[][]} */
  const rawSections = [];
  /** @type {string[]} */
  let currentSection = [];

  for (const line of rawBox.interiorLines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && SEPARATOR_LINE_RE.test(trimmed)) {
      if (currentSection.length > 0) {
        rawSections.push(currentSection);
        currentSection = [];
      }
      continue;
    }
    if (trimmed.length > 0) {
      currentSection.push(trimmed);
    }
  }
  if (currentSection.length > 0) {
    rawSections.push(currentSection);
  }

  let nodeType = rawBox.inlineTitle;
  const detailSections = [...rawSections];
  if (nodeType === null) {
    const titleSection = detailSections.shift();
    if (titleSection === undefined || titleSection.length === 0) {
      throw new PlanParseError("MALFORMED_PLAN", `DuckDB operator box at row ${rawBox.topRow + 1} has no operator name.`);
    }
    nodeType = titleSection[0].trim();
    if (titleSection.length > 1) {
      detailSections.unshift(titleSection.slice(1));
    }
  }

  if (nodeType.length === 0) {
    throw new PlanParseError("MALFORMED_PLAN", `DuckDB operator box at row ${rawBox.topRow + 1} has an empty operator name.`);
  }

  const operator = canonicalOperatorName(nodeType);
  if (operator === "EXPLAIN_ANALYZE") {
    throw new PlanParseError(
      "MODE_MISMATCH",
      'DuckDB EXPLAIN parser accepts estimated plans only; EXPLAIN_ANALYZE operator is not supported.',
    );
  }

  /** @type {ParsedDuckDbProperty[]} */
  const properties = [];
  /** @type {string[][]} */
  const positionalSections = [];
  let estimatedRows = null;

  for (const section of detailSections) {
    for (const line of section) {
      if (ACTUAL_ROWS_WITH_TIMING_RE.test(line) || ACTUAL_TIMING_TOKEN_RE.test(line)) {
        throw new PlanParseError(
          "MODE_MISMATCH",
          'DuckDB EXPLAIN parser accepts estimated plans only; runtime timing metrics from EXPLAIN ANALYZE are not supported.',
        );
      }
    }

    if (section.length === 1) {
      const ecMatch = section[0].match(EC_VALUE_RE) ?? section[0].match(TILDE_ROWS_RE);
      if (ecMatch !== null) {
        estimatedRows = parseCount(ecMatch[1]);
        properties.push({ name: "EC", value: String(estimatedRows ?? ecMatch[1]) });
        continue;
      }
    }

    // Parse key-value lines (with wrapped continuation support inside a section)
    const sectionItems = parseSectionLines(section);
    const nonMetricPositionals = [];

    for (const item of sectionItems) {
      if (item.type === "kv") {
        if (/^(?:EC|Estimated Cardinality)$/i.test(item.name)) {
          estimatedRows = parseCount(item.value);
          properties.push({ name: "EC", value: String(estimatedRows ?? item.value) });
        } else {
          properties.push({ name: item.name, value: item.value });
        }
      } else {
        const ecMatch = item.text.match(EC_VALUE_RE) ?? item.text.match(TILDE_ROWS_RE);
        if (ecMatch !== null) {
          estimatedRows = parseCount(ecMatch[1]);
          properties.push({ name: "EC", value: String(estimatedRows ?? ecMatch[1]) });
        } else {
          nonMetricPositionals.push(item.text);
        }
      }
    }

    if (nonMetricPositionals.length > 0) {
      positionalSections.push(nonMetricPositionals);
    }
  }

  let table = findProperty(properties, ["Table"]);
  let filter = findProperty(properties, ["Filters", "Filter"]);
  let joinType = findProperty(properties, ["Join Type"]);
  let joinCondition = findProperty(properties, ["Conditions", "Condition", "Join Condition"]);
  let projections = splitPropertyList(findProperty(properties, ["Projections", "Output", "Expressions"]));
  let sortKeys = splitPropertyList(findProperty(properties, ["Order By", "Sort Keys"]));
  let groupKeys = splitPropertyList(findProperty(properties, ["Groups", "Group By"]));

  const isScan = /SCAN|GET/.test(operator);
  const isJoin = /JOIN|CROSS_PRODUCT/.test(operator);
  const isFilter = operator === "FILTER";
  const isProjection = operator === "PROJECTION";
  const isSort = operator === "ORDER_BY" || operator === "TOP_N";
  const isAggregate = /GROUP_BY|AGGREGATE/.test(operator);

  if (isScan && positionalSections.length > 0) {
    if (table === null && positionalSections[0].length === 1 && isLikelyTableName(positionalSections[0][0])) {
      table = positionalSections[0][0];
      if (projections === null && positionalSections.length > 1) {
        projections = positionalSections.slice(1).flat();
      }
    } else if (projections === null) {
      projections = positionalSections.flat();
    }
  } else if (isJoin && positionalSections.length > 0) {
    for (const posSection of positionalSections) {
      const firstUpper = posSection[0].toUpperCase();
      if (joinType === null && KNOWN_JOIN_TYPES.has(firstUpper)) {
        joinType = firstUpper;
        if (joinCondition === null && posSection.length > 1) {
          joinCondition = posSection.slice(1).join(" AND ");
        }
      } else if (joinCondition === null) {
        joinCondition = posSection.join(" AND ");
      }
    }
  } else if (isFilter && filter === null && positionalSections.length > 0) {
    filter = positionalSections.map((sec) => sec.join(" ")).join(" AND ");
  } else if (isProjection && projections === null && positionalSections.length > 0) {
    projections = positionalSections.flat();
  } else if (isSort && sortKeys === null && positionalSections.length > 0) {
    sortKeys = positionalSections.flat();
  } else if (isAggregate && groupKeys === null && positionalSections.length > 0) {
    groupKeys = positionalSections.flat();
  }

  return {
    nodeType,
    operator,
    table,
    estimatedRows,
    filter,
    joinType,
    joinCondition,
    projections,
    sortKeys,
    groupKeys,
    properties,
    sections: rawSections,
    box: {
      topRow: rawBox.topRow,
      bottomRow: rawBox.bottomRow,
      leftCol: rawBox.leftCol,
      rightCol: rawBox.rightCol,
    },
    children: [],
    extra: {},
  };
}

/**
 * Parse lines inside one box section, joining wrapped continuation lines of a
 * `Key: value` entry (for example `Filters: name>=Ma AND name` followed by
 * `<Mb AND name IS NOT NULL`).
 *
 * @param {string[]} lines
 * @returns {Array<{ type: "kv", name: string, value: string } | { type: "positional", text: string }>}
 */
function parseSectionLines(lines) {
  /** @type {Array<{ type: "kv", name: string, value: string } | { type: "positional", text: string }>} */
  const items = [];

  for (const line of lines) {
    const kvMatch = line.match(KEY_VALUE_RE);
    if (kvMatch !== null) {
      items.push({
        type: "kv",
        name: kvMatch[1].trim(),
        value: (kvMatch[2] ?? "").trim(),
      });
      continue;
    }

    const last = items[items.length - 1];
    if (last !== undefined && last.type === "kv" && !TILDE_ROWS_RE.test(line) && !EC_VALUE_RE.test(line)) {
      last.value = joinWrappedText(last.value, line);
    } else {
      items.push({ type: "positional", text: line });
    }
  }

  return items;
}

/**
 * Join a box-wrapped line continuation without inserting a spurious space when
 * a comparison operator was split across lines (e.g. `name` + `<Mb`).
 *
 * @param {string} left
 * @param {string} right
 */
function joinWrappedText(left, right) {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  if (/[A-Za-z0-9_]$/.test(left) && /^[<>=!]/.test(right)) {
    return `${left}${right}`;
  }
  if (/[<>=!]$/.test(left) && /^[A-Za-z0-9_'"]/.test(right)) {
    return `${left}${right}`;
  }
  return `${left} ${right}`;
}

/** @param {string} nodeType */
function canonicalOperatorName(nodeType) {
  return nodeType
    .trim()
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
}

/** @param {string} raw */
function parseCount(raw) {
  const cleaned = raw.replace(/[,_]/g, "").trim();
  if (!/^\d+$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * @param {ParsedDuckDbProperty[]} properties
 * @param {string[]} names
 */
function findProperty(properties, names) {
  const targets = new Set(names.map((name) => name.toLowerCase()));
  for (const prop of properties) {
    if (targets.has(prop.name.toLowerCase()) && prop.value.trim().length > 0) {
      return prop.value.trim();
    }
  }
  return null;
}

/** @param {string|null} value */
function splitPropertyList(value) {
  if (value === null || value.trim().length === 0) return null;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : null;
}

/** @param {string} candidate */
function isLikelyTableName(candidate) {
  return /^[…A-Za-z0-9_$.]+$/.test(candidate) && !KNOWN_JOIN_TYPES.has(candidate.toUpperCase());
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
