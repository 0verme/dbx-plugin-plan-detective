import assert from "node:assert/strict";
import test from "node:test";
import { PlanParseError } from "../../src/core/errors.js";
import {
  attribute,
  descendants,
  directChild,
  directChildren,
  findElements,
  findFirst,
  parseXmlDocument,
} from "../../src/core/sqlserver/xml.js";

/**
 * The XML reader is Plan Core's dependency-free ShowPlanXML front door: it must
 * run in Node (`node --test`) and in the browser without `DOMParser`, resolve
 * names by local name so the ShowPlanXML namespace cannot hide a node, and turn
 * malformed payloads into a stable `MALFORMED_XML` error.
 */

/** @param {string} xml */
function parse(xml) {
  return parseXmlDocument(xml);
}

/** @param {unknown} input */
function malformed(input) {
  try {
    parseXmlDocument(input);
  } catch (error) {
    assert.ok(error instanceof PlanParseError, `expected PlanParseError, got ${error?.name ?? typeof error}`);
    assert.equal(error.code, "MALFORMED_XML", error.message);
    if (typeof input === "string") {
      assert.match(error.message, /line \d+, column \d+/, "the error must carry the source position");
    }
    return error;
  }
  assert.fail("expected the payload to be rejected");
}

test("parses elements, attributes, self-closing tags and text", () => {
  const root = parse(`<root a="1" b='2'><child>x</child><child/><leaf/></root>`);

  assert.equal(root.name, "root");
  assert.deepEqual(root.attributes, { a: "1", b: "2" });
  assert.deepEqual(
    root.children.map((child) => child.name),
    ["child", "child", "leaf"],
  );
  assert.equal(root.children[0].text, "x");
  assert.equal(root.children[1].children.length, 0);
});

test("strips namespace prefixes and keeps the raw attribute names", () => {
  const root = parse(
    `<?xml version="1.0"?>` +
      `<p:ShowPlanXML xmlns:p="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.539">` +
      `<p:BatchSequence><p:Batch/></p:BatchSequence></p:ShowPlanXML>`,
  );

  assert.equal(root.name, "ShowPlanXML");
  assert.equal(root.attributes.Version, "1.539");
  assert.equal(root.attributes["xmlns:p"], "http://schemas.microsoft.com/sqlserver/2004/07/showplan");
  assert.equal(directChild(root, "BatchSequence").name, "BatchSequence");
  assert.equal(findFirst(root, "Batch").name, "Batch");
});

test("decodes predefined and numeric entities, skips CDATA-preserving comments", () => {
  const root = parse(`<a><![CDATA[&<>]]><!-- ignored -->&amp;&#65;&#x42;&unknown;</a>`);

  assert.equal(root.text, "&<>&AB&unknown;");
});

test("skips the XML declaration, comments, processing instructions and DOCTYPE", () => {
  const xml =
    `\uFEFF<!DOCTYPE ShowPlanXML [<!ENTITY x "y">]>` +
    `<?xml-stylesheet?>` +
    `<!-- leading --><root att="v"><!-- inner -->text</root><!-- trailing -->`;

  const root = parse(xml);
  assert.equal(root.name, "root");
  assert.equal(root.attributes.att, "v");
  assert.equal(root.text, "text");
});

test("traversal helpers stay deterministic and non-recursive", () => {
  const root = parse(`<a><b id="1"><c/></b><b id="2"/><d><c/></d></a>`);

  assert.deepEqual(
    descendants(root).map((element) => element.name),
    ["b", "c", "b", "d", "c"],
  );
  assert.deepEqual(
    findElements(root, "b").map((element) => element.attributes.id),
    ["1", "2"],
  );
  assert.deepEqual(findElements(root, "c").length, 2);
  assert.equal(findFirst(root, "c").name, "c");
  assert.equal(findFirst(root, "missing"), null);
  assert.deepEqual(directChildren(root, "b").length, 2);
  assert.equal(directChild(root, "b"), root.children[0]);
  assert.equal(attribute(root.children[0], "id"), "1");
  assert.equal(attribute(null, "id"), null);
  assert.equal(attribute(root.children[0], "missing"), null);
});

test("malformed payloads fail closed with a stable error code", () => {
  malformed("");
  malformed("   \n  ");
  malformed("not xml");
  malformed("<a>");
  malformed("<a></b>");
  malformed("<a></a><b></b>");
  malformed("text<a/>");
  malformed("<a><b></a>");
  malformed("<a x=y/>");
  malformed("<a x='unterminated/>");
  malformed("<a x='1' x='2'/>");
  malformed("<a><!-- unterminated </a>");
  malformed(`<a><![CDATA[unterminated</a>`);
  malformed("<a></a>tail");
  malformed(`<a xmlns:x="urn"><x:b></a>`);
  malformed(42);
  malformed(null);
});

test("a malformed entity does not crash the reader", () => {
  const root = parse("<a>&#xZZ;&#;plain</a>");
  assert.equal(root.text, "&#xZZ;&#;plain");
});
