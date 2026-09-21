/**
 * Dependency-free XML reader for the ShowPlanXML payload.
 *
 * Plan Core has to run in two places without any XML library:
 *
 * - the DBX webview (a browser, where `DOMParser` exists but a global would
 *   break the "core runs in Node" test contract), and
 * - plain Node (`node --test`), which has no `DOMParser` at all.
 *
 * Rather than branching on the environment or adding an XML dependency to a
 * frontend-only plugin, this module implements the small, well-defined subset
 * ShowPlanXML actually uses: elements, attributes, character data, CDATA,
 * comments, processing instructions and a skipped DOCTYPE. It deliberately
 * does **not** implement DTD / external entity resolution, namespace
 * resolution or schema validation — names are compared by local name only, so
 * the default ShowPlanXML namespace (and any prefix) cannot hide a node.
 *
 * The reader is iterative, not recursive: a plan is bounded by the host
 * `maxPlanBytes` limit, but a crafted payload must not blow the call stack.
 *
 * Errors are reported as `PlanParseError` with code `MALFORMED_XML` and the
 * source position, so a malformed payload degrades into a stable parser error
 * instead of a runtime crash.
 */

import { PlanParseError } from "../errors.js";

const PREDEFINED_ENTITIES = Object.freeze({
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
});

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_.:-]/;
const WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

/**
 * @typedef {Object} XmlElement
 * @property {string} name local element name (any namespace prefix stripped)
 * @property {Record<string, string>} attributes attribute names exactly as written
 * @property {XmlElement[]} children child elements, source order
 * @property {string} text concatenated character data inside this element
 */

/**
 * Parse an XML payload into one element tree.
 *
 * @param {unknown} source raw XML text
 * @returns {XmlElement} the root element
 * @throws {PlanParseError} `MALFORMED_XML` when the payload is not well-formed
 */
export function parseXmlDocument(source) {
  if (typeof source !== "string") {
    throw new PlanParseError("MALFORMED_XML", `XML payload must be a string; got ${describeValue(source)}.`);
  }
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return new XmlReader(text).readTree();
}

/**
 * All descendant elements in source order. The starting element itself is
 * not included.
 *
 * @param {XmlElement} element
 * @returns {XmlElement[]}
 */
export function descendants(element) {
  return [...descendantsOf(element)];
}

/**
 * All descendant elements with a local name, in source order. The starting
 * element itself is not included.
 *
 * @param {XmlElement} element
 * @param {string} name local element name
 * @returns {XmlElement[]}
 */
export function findElements(element, name) {
  const found = [];
  for (const descendant of descendantsOf(element)) {
    if (descendant.name === name) found.push(descendant);
  }
  return found;
}

/**
 * First descendant with a local name, or `null`.
 *
 * @param {XmlElement} element
 * @param {string} name
 * @returns {XmlElement|null}
 */
export function findFirst(element, name) {
  for (const descendant of descendantsOf(element)) {
    if (descendant.name === name) return descendant;
  }
  return null;
}

/**
 * Direct children with a local name.
 *
 * @param {XmlElement} element
 * @param {string} name
 * @returns {XmlElement[]}
 */
export function directChildren(element, name) {
  return element.children.filter((child) => child.name === name);
}

/**
 * First direct child with a local name, or `null`.
 *
 * @param {XmlElement} element
 * @param {string} name
 * @returns {XmlElement|null}
 */
export function directChild(element, name) {
  return element.children.find((child) => child.name === name) ?? null;
}

/**
 * Attribute value, or `null` when the attribute is absent.
 *
 * @param {XmlElement|null|undefined} element
 * @param {string} name
 * @returns {string|null}
 */
export function attribute(element, name) {
  if (element === null || element === undefined) return null;
  const value = element.attributes[name];
  return typeof value === "string" ? value : null;
}

/**
 * Pre-order iteration over descendants, without recursion.
 *
 * @param {XmlElement} element
 * @returns {Generator<XmlElement>}
 */
function* descendantsOf(element) {
  const stack = [...element.children].reverse();
  while (stack.length > 0) {
    const current = stack.pop();
    yield current;
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      stack.push(current.children[index]);
    }
  }
}

class XmlReader {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  /**
   * Read the whole payload. Whitespace and prolog items before the root are
   * skipped; anything else outside the root element is malformed.
   *
   * @returns {XmlElement}
   */
  readTree() {
    /** @type {XmlElement[]} */
    const stack = [];
    /** @type {XmlElement|null} */
    let root = null;

    while (this.index < this.text.length) {
      if (this.text.startsWith("<!--", this.index)) {
        this.skipComment();
        continue;
      }
      if (this.text.startsWith("<?", this.index)) {
        this.skipProcessingInstruction();
        continue;
      }
      if (this.text.startsWith("<![CDATA[", this.index)) {
        const data = this.readCdata();
        if (stack.length === 0) throw this.fail("CDATA section outside of the root element");
        stack[stack.length - 1].text += data;
        continue;
      }
      if (this.text.startsWith("<!", this.index)) {
        this.skipDeclaration();
        continue;
      }
      if (this.text.startsWith("</", this.index)) {
        const name = this.readClosingTag();
        const open = stack.pop();
        if (open === undefined) throw this.fail(`closing tag </${name}> has no matching opening tag`);
        if (open.name !== name) throw this.fail(`closing tag </${name}> does not match <${open.name}>`);
        continue;
      }
      if (this.text[this.index] === "<") {
        const { element, selfClosing } = this.readOpeningTag();
        if (stack.length === 0) {
          if (root !== null) throw this.fail("XML payload has more than one root element");
          root = element;
        } else {
          stack[stack.length - 1].children.push(element);
        }
        if (!selfClosing) stack.push(element);
        continue;
      }

      // Character data up to the next markup construct.
      const chunkEnd = this.text.indexOf("<", this.index);
      const end = chunkEnd === -1 ? this.text.length : chunkEnd;
      const raw = this.text.slice(this.index, end);
      this.index = end;
      if (stack.length === 0) {
        if (raw.trim().length > 0) throw this.fail("text outside of the root element");
        continue;
      }
      stack[stack.length - 1].text += decodeEntities(raw);
    }

    if (stack.length > 0) throw this.fail(`element <${stack[stack.length - 1].name}> is not closed`);
    if (root === null) throw this.fail("XML payload has no root element");
    return root;
  }

  /**
   * @returns {{ element: XmlElement, selfClosing: boolean }}
   */
  readOpeningTag() {
    const start = this.index;
    this.index += 1; // consume "<"
    const rawName = this.readName();

    /** @type {XmlElement} */
    const element = { name: localNameOf(rawName), attributes: {}, children: [], text: "" };

    for (;;) {
      this.skipWhitespace();
      if (this.index >= this.text.length) throw this.failAt(start, `element <${rawName}> is not closed`);
      const char = this.text[this.index];

      if (char === ">") {
        this.index += 1;
        return { element, selfClosing: false };
      }
      if (char === "/") {
        if (this.text[this.index + 1] !== ">") throw this.fail('expected "/>"');
        this.index += 2;
        return { element, selfClosing: true };
      }

      const attributeName = this.readName();
      this.skipWhitespace();
      if (this.text[this.index] !== "=") {
        throw this.fail(`attribute "${attributeName}" must be followed by "="`);
      }
      this.index += 1;
      this.skipWhitespace();

      const quote = this.text[this.index];
      if (quote !== '"' && quote !== "'") {
        throw this.fail(`attribute "${attributeName}" value must be quoted`);
      }
      const valueStart = this.index + 1;
      const valueEnd = this.text.indexOf(quote, valueStart);
      if (valueEnd === -1) throw this.fail(`attribute "${attributeName}" value is not terminated`);
      const rawValue = this.text.slice(valueStart, valueEnd);
      this.index = valueEnd + 1;

      if (Object.hasOwn(element.attributes, attributeName)) {
        throw this.fail(`duplicate attribute "${attributeName}" on <${rawName}>`);
      }
      element.attributes[attributeName] = decodeEntities(rawValue);
    }
  }

  /** @returns {string} local name of the closing tag */
  readClosingTag() {
    this.index += 2; // consume "</"
    const rawName = this.readName();
    this.skipWhitespace();
    if (this.text[this.index] !== ">") throw this.fail(`closing tag </${rawName}> is not terminated`);
    this.index += 1;
    return localNameOf(rawName);
  }

  /** Skip an XML comment, including nested-looking markup inside it. */
  skipComment() {
    const end = this.text.indexOf("-->", this.index + 4);
    if (end === -1) throw this.fail("comment is not terminated");
    this.index = end + 3;
  }

  /** Skip a processing instruction, including the XML declaration. */
  skipProcessingInstruction() {
    const end = this.text.indexOf("?>", this.index + 2);
    if (end === -1) throw this.fail("processing instruction is not terminated");
    this.index = end + 2;
  }

  /**
   * Skip a `<!DOCTYPE ...>` declaration. An internal subset (`[ ... ]`) is
   * skipped as opaque text; entities declared there are never resolved.
   */
  skipDeclaration() {
    const start = this.index;
    let cursor = this.index + 2;
    let bracketDepth = 0;
    while (cursor < this.text.length) {
      const char = this.text[cursor];
      if (char === "[") bracketDepth += 1;
      else if (char === "]") bracketDepth -= 1;
      else if (char === ">" && bracketDepth <= 0) {
        this.index = cursor + 1;
        return;
      }
      cursor += 1;
    }
    throw this.failAt(start, "declaration is not terminated");
  }

  /** @returns {string} raw CDATA content */
  readCdata() {
    const start = this.index + "<![CDATA[".length;
    const end = this.text.indexOf("]]>", start);
    if (end === -1) throw this.fail("CDATA section is not terminated");
    this.index = end + 3;
    return this.text.slice(start, end);
  }

  /** @returns {string} */
  readName() {
    const start = this.index;
    if (!NAME_START.test(this.text[this.index] ?? "")) throw this.fail("expected an XML name");
    this.index += 1;
    while (this.index < this.text.length && NAME_CHAR.test(this.text[this.index])) this.index += 1;
    return this.text.slice(start, this.index);
  }

  skipWhitespace() {
    while (WHITESPACE.has(this.text[this.index])) this.index += 1;
  }

  /**
   * @param {string} message
   * @returns {PlanParseError}
   */
  fail(message) {
    return this.failAt(this.index, message);
  }

  /**
   * @param {number} position
   * @param {string} message
   * @returns {PlanParseError}
   */
  failAt(position, message) {
    const { line, column } = positionOf(this.text, position);
    return new PlanParseError("MALFORMED_XML", `${message} (line ${line}, column ${column}).`);
  }
}

/**
 * Decode character references. The five predefined entities and numeric
 * references are decoded; an unknown entity is kept literally instead of
 * failing, because an unresolved entity must not make an otherwise readable
 * plan unparseable.
 *
 * @param {string} raw
 * @returns {string}
 */
function decodeEntities(raw) {
  if (!raw.includes("&")) return raw;

  let decoded = "";
  let cursor = 0;
  while (cursor < raw.length) {
    const ampersand = raw.indexOf("&", cursor);
    if (ampersand === -1) {
      decoded += raw.slice(cursor);
      break;
    }
    decoded += raw.slice(cursor, ampersand);

    const semicolon = raw.indexOf(";", ampersand + 1);
    if (semicolon === -1) {
      decoded += raw.slice(ampersand);
      break;
    }

    const entity = raw.slice(ampersand + 1, semicolon);
    if (Object.hasOwn(PREDEFINED_ENTITIES, entity)) {
      decoded += PREDEFINED_ENTITIES[entity];
      cursor = semicolon + 1;
      continue;
    }

    if (entity.startsWith("#")) {
      const isHex = entity.startsWith("#x") || entity.startsWith("#X");
      const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        decoded += String.fromCodePoint(codePoint);
        cursor = semicolon + 1;
        continue;
      }
    }

    decoded += raw.slice(ampersand, semicolon + 1);
    cursor = semicolon + 1;
  }
  return decoded;
}

/**
 * Strip a namespace prefix: `p:RelOp` -> `RelOp`.
 *
 * @param {string} name
 * @returns {string}
 */
function localNameOf(name) {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * @param {string} text
 * @param {number} position
 * @returns {{ line: number, column: number }}
 */
function positionOf(text, position) {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < position && index < text.length; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: position - lineStart + 1 };
}

/** @param {unknown} value */
function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length ${value.length})`;
  return typeof value;
}
