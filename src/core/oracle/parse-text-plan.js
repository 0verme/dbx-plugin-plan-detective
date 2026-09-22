import { PlanInputError, PlanParseError } from "../errors.js";
import { validateRawPlanInput } from "../raw-plan-input.js";

const PLAN_HASH_RE = /^\s*Plan hash value\s*:\s*(\d+)\s*$/i;
const PREDICATE_HEADING_RE = /^Predicate Information\b/i;
const SECTION_HEADING_RE = /^(?:Note|Outline Data|Peeked Binds|Column Projection Information|SQL Plan Management|Error|Predicate Information)\b/i;
const NUMBER_RE = /^[+-]?\d[\d,]*(?:\.\d+)?$/;
const MISSING_CELL_RE = /^(?:|-|—)$/;
const ACTUAL_COLUMN_RE = /^(?:A-ROWS|A-TIME|E-ROWS|STARTS|BUFFERS|READS|WRITES|OMem|1Mem|USED-MEM)$/i;
const DISPLAY_CURSOR_MARKER_RE = /\b(?:SQL_ID|CHILD\s+NUMBER|DISPLAY_CURSOR)\b/i;

/**
 * Oracle DBMS_XPLAN `DISPLAY(..., 'TYPICAL +PREDICATE')` text parser.
 *
 * The parser deliberately accepts only the table-shaped estimated output that
 * DBX currently asks the Oracle driver for. It does not attempt to parse
 * `DISPLAY_CURSOR`, `ALLSTATS LAST`, `ADVANCED`, or arbitrary SQL*Plus
 * formatting. Column offsets come from the returned header row, while the
 * execution tree comes from operation-column indentation rather than Oracle's
 * display id (which is only an engine-specific fact).
 */

/**
 * @typedef {Object} ParsedOracleNode
 * @property {string} nodeType normalized operation label, or `Plan` when the row has no label
 * @property {string|null} rawOperation operation label exactly as displayed, trimmed
 * @property {number|null} id Oracle display id; never used to build the tree
 * @property {string|null} name
 * @property {number|null} estimatedRows
 * @property {number|null} bytes
 * @property {number|null} cost Oracle's native cost estimate
 * @property {number|null} cpuPercent Oracle's native `%CPU` estimate
 * @property {string|null} time Oracle's native time estimate
 * @property {boolean} predicateMarker whether the table row carried `*`
 * @property {string[]|null} predicates predicate text associated with the display id
 * @property {number} indentation leading whitespace in the operation cell
 * @property {ParsedOracleNode[]} children
 * @property {Record<string, unknown>} extra unrecognised or malformed native cells
 *
 * @typedef {Object} ParsedPlan
 * @property {"oracle"} database
 * @property {"text"} format
 * @property {"estimated"} mode
 * @property {ParsedOracleNode} root
 * @property {number|null} planHashValue
 */

/**
 * Parse a RawPlanInput containing an Oracle estimated text plan.
 *
 * @param {unknown} input
 * @returns {ParsedPlan}
 * @throws {PlanInputError}
 * @throws {PlanParseError}
 */
export function parseOracleTextPlan(input) {
  const problems = validateRawPlanInput(input);
  if (problems.length > 0) {
    throw new PlanInputError("INVALID_RAW_PLAN_INPUT", `Invalid RawPlanInput: ${problems.join(" ")}`);
  }

  const rawInput = /** @type {import("../raw-plan-input.js").RawPlanInput} */ (input);
  if (rawInput.database !== "oracle" || rawInput.format !== "text") {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `Oracle DBMS_XPLAN parser expects database "oracle" with format "text"; got ${JSON.stringify(rawInput.database)} / ${JSON.stringify(rawInput.format)}.`,
    );
  }
  if (rawInput.mode !== "estimated") {
    throw new PlanParseError(
      "MODE_MISMATCH",
      `Oracle DBMS_XPLAN parser supports estimated plans only; got mode "${rawInput.mode}".`,
    );
  }
  if (typeof rawInput.plan !== "string") {
    throw new PlanParseError("MALFORMED_PLAN", `Oracle DBMS_XPLAN plan must be a text string; got ${describeValue(rawInput.plan)}.`);
  }

  const lines = normalizeLines(rawInput.plan);
  const planHashValue = readPlanHashValue(lines);
  const table = readPlanTable(lines);
  const predicateById = readPredicateSections(lines, table.headerIndex + 1);

  const rows = table.rows.map((row) => {
    const node = parseRow(row, table.columns, predicateById);
    return node;
  });

  if (rows.length === 0) {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      "Oracle DBMS_XPLAN output contains a valid header but no operation rows.",
    );
  }

  const roots = buildTree(rows);
  if (roots.length !== 1) {
    throw new PlanParseError(
      "MALFORMED_PLAN",
      `Oracle DBMS_XPLAN operation indentation produced ${roots.length} root nodes; expected exactly one root.`,
    );
  }

  return {
    database: "oracle",
    format: "text",
    mode: "estimated",
    root: roots[0],
    planHashValue,
  };
}

/**
 * Find the DBMS_XPLAN table header and the rows up to its closing separator.
 * Header-derived fixed offsets tolerate omitted optional columns and labels
 * whose width changes with the server version.
 *
 * @param {string[]} lines
 * @returns {{ headerIndex: number, columns: Array<{ header: string, key: string|null, start: number, end: number }>, rows: string[] }}
 */
function readPlanTable(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes("|")) continue;

    const columns = columnsFromHeader(line);
    const operation = columns.find((column) => column.key === "operation");
    const id = columns.find((column) => column.key === "id");
    if (operation === undefined || id === undefined) continue;
    if (columns.some((column) => ACTUAL_COLUMN_RE.test(column.header)) || DISPLAY_CURSOR_MARKER_RE.test(lines.slice(0, index).join("\n"))) {
      throw new PlanParseError(
        "MODE_MISMATCH",
        "Oracle DBMS_XPLAN output contains DISPLAY_CURSOR or runtime columns; only estimated DISPLAY TYPICAL output is supported.",
      );
    }

    const rows = [];
    let sawRow = false;
    let endIndex = lines.length;
    for (let rowIndex = index + 1; rowIndex < lines.length; rowIndex += 1) {
      const rowLine = lines[rowIndex];
      if (isTableBorder(rowLine)) {
        if (sawRow) {
          endIndex = rowIndex;
          break;
        }
        continue;
      }
      if (!rowLine.includes("|")) {
        // A non-table line after rows is the start of the predicate / tail
        // sections. The usual closing border was absent, so stop safely.
        if (sawRow) {
          endIndex = rowIndex;
          break;
        }
        continue;
      }

      if (isRepeatedHeader(rowLine, columns)) continue;
      if (!hasRowContent(rowLine, columns)) continue;
      rows.push(rowLine);
      sawRow = true;
    }

    // A header with no rows is not the plan table we are looking for. This
    // lets a later page/header-like line be considered without guessing.
    if (rows.length === 0) continue;

    return { headerIndex: index, columns, rows };
  }

  throw new PlanParseError(
    "MALFORMED_PLAN",
    "Oracle DBMS_XPLAN output does not contain a table header with Id and Operation columns.",
  );
}

/**
 * @param {string} line
 * @returns {Array<{ header: string, key: string|null, start: number, end: number }>}
 */
function columnsFromHeader(line) {
  const bars = barPositions(line);
  const columns = [];
  for (let index = 0; index + 1 < bars.length; index += 1) {
    const start = bars[index] + 1;
    const end = bars[index + 1];
    const header = line.slice(start, end).trim();
    columns.push({ header, key: headerKey(header), start, end });
  }
  return columns;
}

/** @param {string} line @returns {number[]} */
function barPositions(line) {
  const positions = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "|") positions.push(index);
  }
  return positions;
}

/** @param {string} header @returns {string|null} */
function headerKey(header) {
  const key = header.toUpperCase().replace(/\s+/g, " ").trim();
  switch (key) {
    case "ID":
      return "id";
    case "OPERATION":
      return "operation";
    case "NAME":
      return "name";
    case "ROWS":
      return "rows";
    case "BYTES":
      return "bytes";
    case "COST":
    case "COST (%CPU)":
      return "cost";
    case "%CPU":
    case "% CPU":
    case "CPU":
      return "cpuPercent";
    case "TIME":
      return "time";
    default:
      return null;
  }
}

/** @param {string} line @returns {boolean} */
function isTableBorder(line) {
  const trimmed = line.trim();
  return trimmed.length >= 3 && trimmed.includes("-") && /^[+|\- ]+$/.test(trimmed);
}

/**
 * @param {string} line
 * @param {Array<{ header: string, key: string|null, start: number, end: number }>} columns
 * @returns {boolean}
 */
function isRepeatedHeader(line, columns) {
  const operation = cellAt(line, columns.find((column) => column.key === "operation"));
  const id = cellAt(line, columns.find((column) => column.key === "id"));
  return operation.toUpperCase() === "OPERATION" && id.toUpperCase() === "ID";
}

/**
 * @param {string} line
 * @param {Array<{ header: string, key: string|null, start: number, end: number }>} columns
 * @returns {boolean}
 */
function hasRowContent(line, columns) {
  return columns.some((column) => cellAt(line, column).length > 0);
}

/**
 * @param {string[]} lines
 * @param {number} startIndex
 * @returns {Map<number, string[]>}
 */
function readPredicateSections(lines, startIndex) {
  const result = new Map();
  const headingIndex = lines.findIndex((line, index) => index >= startIndex && PREDICATE_HEADING_RE.test(line.trim()));
  if (headingIndex < 0) return result;

  let currentId = null;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.length === 0 || isTableBorder(lines[index])) continue;
    if (SECTION_HEADING_RE.test(trimmed) && !/^Predicate Information\b/i.test(trimmed)) break;

    const predicate = trimmed.match(/^\*?\s*(\d+)\s*-\s*(.*)$/);
    if (predicate !== null) {
      currentId = Number(predicate[1]);
      const text = predicate[2].trim();
      const entries = result.get(currentId) ?? [];
      if (text.length > 0) entries.push(text);
      result.set(currentId, entries);
      continue;
    }

    // DBMS_XPLAN may wrap a long predicate onto indented continuation lines.
    // Only append after a numbered predicate; unrelated tail text is ignored
    // once a new known section begins.
    if (currentId !== null && trimmed.length > 0 && !/^[-+|]+$/.test(trimmed)) {
      const entries = result.get(currentId) ?? [];
      entries.push(trimmed);
      result.set(currentId, entries);
    }
  }
  return result;
}

/**
 * @param {{ header: string, key: string|null, start: number, end: number } & object} column
 * @param {string} line
 * @returns {string}
 */
function cellAt(line, column) {
  if (column === undefined) return "";
  return line.slice(column.start, column.end).replace(/\r$/, "").trim();
}

/**
 * @param {string} row
 * @param {Array<{ header: string, key: string|null, start: number, end: number }>} columns
 * @param {Map<number, string[]>} predicateById
 * @returns {ParsedOracleNode}
 */
function parseRow(row, columns, predicateById) {
  const idColumn = columns.find((column) => column.key === "id");
  const operationColumn = columns.find((column) => column.key === "operation");
  const nameColumn = columns.find((column) => column.key === "name");
  const rowsColumn = columns.find((column) => column.key === "rows");
  const bytesColumn = columns.find((column) => column.key === "bytes");
  const costColumn = columns.find((column) => column.key === "cost");
  const cpuColumn = columns.find((column) => column.key === "cpuPercent");
  const timeColumn = columns.find((column) => column.key === "time");

  const idCell = cellAt(row, idColumn);
  const operationCell = rawCellAt(row, operationColumn);
  const operationWithoutMarker = operationCell.replace(/^(\s*)\*\s?/, "$1");
  const nameCell = cellAt(row, nameColumn);
  const rowsCell = cellAt(row, rowsColumn);
  const bytesCell = cellAt(row, bytesColumn);
  const costCell = cellAt(row, costColumn);
  const cpuCell = cellAt(row, cpuColumn);
  const timeCell = cellAt(row, timeColumn);

  const extra = {};
  const id = parseId(idCell);
  const estimatedRows = parseNumberCell(rowsCell);
  const bytes = parseNumberCell(bytesCell);
  const costParts = parseCostCell(costCell);
  const separateCpuPercent = parseNumberCell(cpuCell);
  const time = optionalCell(timeCell);
  const rawOperation = optionalCell(operationWithoutMarker);
  const nodeType = rawOperation ?? "Plan";
  const predicateMarker = idCell.includes("*") || operationCell.includes("*");
  const predicates = id === null ? null : predicateById.get(id) ?? null;

  if (hasValue(idCell) && id === null) extra.Id = idCell;
  if (hasValue(rowsCell) && estimatedRows === null) extra.Rows = rowsCell;
  if (hasValue(bytesCell) && bytes === null) extra.Bytes = bytesCell;
  if (hasValue(costCell) && costParts.valid === false) extra[displayHeader(columns, "cost")] = costCell;
  if (hasValue(cpuCell) && separateCpuPercent === null) extra[displayHeader(columns, "cpuPercent")] = cpuCell;

  for (const column of columns) {
    if (column.key !== null) continue;
    const value = cellAt(row, column);
    if (hasValue(value)) extra[column.header || `column_${column.start}`] = value;
  }

  return {
    nodeType,
    rawOperation,
    id,
    name: optionalCell(nameCell),
    estimatedRows,
    bytes,
    cost: costParts.cost,
    cpuPercent: costParts.cpuPercent ?? separateCpuPercent,
    time,
    predicateMarker,
    predicates,
    indentation: leadingWhitespace(operationCell),
    children: [],
    extra,
  };
}

/** @param {Array<{ header: string, key: string|null }>} columns @param {string} key @returns {string} */
function displayHeader(columns, key) {
  return columns.find((column) => column.key === key)?.header ?? key;
}

/** @param {string} raw @returns {number|null} */
function parseId(raw) {
  const value = raw.replace(/\*/g, "").trim();
  if (!hasValue(value)) return null;
  const match = value.match(/^\d+$/);
  return match === null ? null : Number(value);
}

/** @param {string} raw @returns {number|null} */
function parseNumberCell(raw) {
  if (!hasValue(raw) || MISSING_CELL_RE.test(raw)) return null;
  if (!NUMBER_RE.test(raw)) return null;
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/**
 * @param {string} raw
 * @returns {{ cost: number|null, cpuPercent: number|null, valid: boolean|null }}
 */
function parseCostCell(raw) {
  if (!hasValue(raw) || MISSING_CELL_RE.test(raw)) return { cost: null, cpuPercent: null, valid: null };
  const match = raw.match(
    /^([+-]?\d[\d,]*(?:\.\d+)?)\s*(?:\(\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*%?\s*\))?$/,
  );
  if (match === null) return { cost: null, cpuPercent: null, valid: false };

  const cost = Number(match[1].replace(/,/g, ""));
  const cpuPercent = match[2] === undefined ? null : Number(match[2].replace(/,/g, ""));
  if (!Number.isFinite(cost) || (cpuPercent !== null && !Number.isFinite(cpuPercent))) {
    return { cost: null, cpuPercent: null, valid: false };
  }
  return { cost, cpuPercent, valid: true };
}

/** @param {string} raw @returns {string|null} */
function optionalCell(raw) {
  return hasValue(raw) && !MISSING_CELL_RE.test(raw) ? raw.trim() : null;
}

/** @param {string} raw @returns {boolean} */
function hasValue(raw) {
  return typeof raw === "string" && raw.trim().length > 0;
}

/** @param {string} raw @returns {number} */
function leadingWhitespace(raw) {
  const match = raw.match(/^[ \t]*/);
  return match?.[0].length ?? 0;
}

/**
 * @param {string} line
 * @param {{ start: number, end: number }|undefined} column
 * @returns {string}
 */
function rawCellAt(line, column) {
  if (column === undefined) return "";
  return line.slice(column.start, column.end).replace(/\r$/, "");
}

/** @param {string[]} lines @returns {number|null} */
function readPlanHashValue(lines) {
  for (const line of lines) {
    const match = line.match(PLAN_HASH_RE);
    if (match === null) continue;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** @param {string} text @returns {string[]} */
function normalizeLines(text) {
  return text.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
}

/**
 * Build a tree from display indentation. Ids can be missing, repeated, or out
 * of order without affecting parentage.
 *
 * @param {ParsedOracleNode[]} rows
 * @returns {ParsedOracleNode[]}
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

/** @param {unknown} value @returns {string} */
function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length ${value.length})`;
  return `${typeof value}(${String(value)})`;
}
