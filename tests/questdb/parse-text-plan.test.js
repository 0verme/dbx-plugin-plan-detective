import assert from "node:assert/strict";
import test from "node:test";
import { PlanParseError } from "../../src/core/errors.js";
import { parseQuestDbTextPlan, tokenizeQuestDbPlan } from "../../src/core/questdb/parse-text-plan.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";

function input(plan, overrides = {}) {
  return createRawPlanInput({ database: "questdb", mode: "estimated", format: "text", plan, ...overrides });
}

test("tokenizer separates nodes, standalone properties, inline properties, and documented relations", () => {
  const tokens = tokenizeQuestDbPlan(
    [
      "Async JIT Filter workers: 7",
      "  filter: a > b",
      "  futureFlag: preserved",
      "    PageFrame futurePageFlag: yes",
      "      Row forward scan",
      "      Frame forward scan on: trades",
    ].join("\n"),
  );

  assert.deepEqual(tokens.map((token) => token.type), ["node", "property", "property", "node", "node", "node"]);
  assert.equal(tokens[0].nodeType, "Async JIT Filter");
  assert.deepEqual(tokens[0].inlineProperties.map(({ name, value }) => ({ name, value })), [{ name: "workers", value: "7" }]);
  assert.equal(tokens[1].propertyName, "filter");
  assert.equal(tokens[2].propertyName, "futureFlag", "unknown property names do not need a whitelist");
  assert.equal(tokens[3].nodeType, "PageFrame");
  assert.equal(tokens[3].inlineProperties[0].name, "futurePageFlag");
  assert.equal(tokens[5].nodeType, "Frame forward scan");
  assert.equal(tokens[5].relation, "trades");
});

test("tree construction uses relative indentation and ignores property rows on the node stack", () => {
  const parsed = parseQuestDbTextPlan(
    input(["Root", "   Child", "        Grandchild", "  Sibling", "    future_prop: retained", "      Sibling child"].join("\n")),
  );

  assert.deepEqual(parsed.root.children.map((node) => node.nodeType), ["Child", "Sibling"]);
  assert.deepEqual(parsed.root.children[0].children.map((node) => node.nodeType), ["Grandchild"]);
  assert.deepEqual(parsed.root.children[1].children.map((node) => node.nodeType), ["Sibling child"]);
  assert.deepEqual(parsed.root.children[1].properties.map((property) => [property.name, property.value]), [["future_prop", "retained"]]);
  assert.equal(parsed.root.children[1].children[0].indent, 6);
});

test("a property aligned with a node belongs to that node", () => {
  const parsed = parseQuestDbTextPlan(input(["Root", "  Child", "  aligned: retained"].join("\n")));
  assert.deepEqual(parsed.root.properties, []);
  assert.deepEqual(parsed.root.children[0].properties.map(({ name, value }) => [name, value]), [["aligned", "retained"]]);
});

test("CRLF text is tokenized and parsed without changing tree structure", () => {
  const parsed = parseQuestDbTextPlan(input("PageFrame\r\n  Row forward scan\r\n  Frame forward scan on: trades\r\n"));
  assert.deepEqual(parsed.root.children.map((node) => node.nodeType), ["Row forward scan", "Frame forward scan"]);
  assert.equal(parsed.root.children[1].relation, "trades");
});

test("inline and standalone properties are preserved, including unknown future keys", () => {
  const parsed = parseQuestDbTextPlan(
    input(["Limit lo: 10", "   GroupByRecord vectorized: false", "      workers: 3", "      future_group_option: value"].join("\n")),
  );

  const [group] = parsed.root.children;
  assert.deepEqual(parsed.root.inlineProperties.map(({ name, value }) => [name, value]), [["lo", "10"]]);
  assert.deepEqual(group.inlineProperties.map(({ name, value }) => [name, value]), [["vectorized", "false"]]);
  assert.deepEqual(group.properties.map(({ name, value }) => [name, value]), [
    ["workers", "3"],
    ["future_group_option", "value"],
  ]);
  assert.equal(group.workers, 3);
  assert.equal(group.vectorized, "false");
  assert.equal(group.rawLine, "   GroupByRecord vectorized: false");
});

test("relation parsing is limited to documented scan-on forms", () => {
  const parsed = parseQuestDbTextPlan(
    input(["Filter filter: condition on: orders", "  Hash Join", "    Frame backward scan on: trades"].join("\n")),
  );
  assert.equal(parsed.root.relation, null);
  assert.equal(parsed.root.filter, "condition on: orders");
  assert.equal(parsed.root.children[0].relation, null);
  assert.equal(parsed.root.children[0].children[0].relation, "trades");
  assert.equal(parsed.root.children[0].children[0].scanDirection, "backward");
});

test("unknown operators and inline properties fail soft with their raw text intact", () => {
  const parsed = parseQuestDbTextPlan(
    input(["QuestDB Future Operator", " future_root_property: keep", "    PageFrame futureFrameFlag: unknown-value", "       Row forward scan"].join("\n")),
  );
  assert.equal(parsed.root.rawLine, "QuestDB Future Operator");
  assert.deepEqual(parsed.root.properties.map(({ name, value }) => [name, value]), [["future_root_property", "keep"]]);
  assert.equal(parsed.root.children[0].inlineProperties[0].value, "unknown-value");
  assert.equal(parsed.root.children[0].rawLine, "    PageFrame futureFrameFlag: unknown-value");
  assert.equal(parsed.root.children[0].children[0].nodeType, "Row forward scan");
});

test("empty plans, property-only payloads, multiple roots, and actual mode fail closed", () => {
  for (const plan of ["", "  \n", "filter: x"]) {
    assert.throws(() => parseQuestDbTextPlan(input(plan)), (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN");
  }
  assert.throws(
    () => parseQuestDbTextPlan(input("Root A\nRoot B")),
    (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN" && /2 root/.test(error.message),
  );
  assert.throws(
    () => parseQuestDbTextPlan(input("PageFrame", { mode: "actual" })),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
});
