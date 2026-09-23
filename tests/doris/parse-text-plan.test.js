import assert from "node:assert/strict";
import test from "node:test";
import { PlanParseError } from "../../src/core/errors.js";
import { parseDorisTextPlan, tokenizeDorisPlan } from "../../src/core/doris/parse-text-plan.js";
import { parseDorisTextPlan as parseDorisFromPublicSurface } from "../../src/core/index.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";

function input(plan, overrides = {}) {
  return createRawPlanInput({ database: "doris", mode: "estimated", format: "text", plan, ...overrides });
}

test("Doris tokenizer retains operator branch connectors, rails and property rows", () => {
  const tokens = tokenizeDorisPlan(`PLAN FRAGMENT 0\n6:VHASH JOIN\n|  join op: INNER JOIN(BROADCAST)[]\n|----4:VEXCHANGE\n|\n5:VEXCHANGE\n`);
  assert.deepEqual(
    tokens.filter((token) => token.type === "operator").map((token) => [token.operationId, token.headerColumn, token.branchColumn, token.branchConnector]),
    [
      ["6", 0, null, false],
      ["4", 5, 0, true],
      ["5", 0, null, false],
    ],
  );
  assert.ok(tokens.some((token) => token.type === "property" && token.property.name === "join op"));
  assert.ok(tokens.some((token) => token.type === "branch"));
});

test("Doris text parser strips result-table borders and restores multi-child logical order", () => {
  const framed = `+-----------------------+\n| PLAN FRAGMENT 0       |\n| VRESULT SINK          |\n| 6:VHASH JOIN          |\n| |----4:VEXCHANGE      |\n| |                     |\n| 5:VEXCHANGE           |\n+-----------------------+`;
  const parsed = parseDorisTextPlan(input(framed));
  assert.equal(parsed.fragments.length, 1);
  assert.equal(parsed.fragments[0].root.operationId, "6");
  assert.deepEqual(parsed.fragments[0].root.children.map((node) => node.operationId), ["5", "4"]);
});

test("Doris tree reconstruction uses branch rails and relative columns, never operation-id order", () => {
  const plan = `PLAN FRAGMENT 3\n0:ROOT\n  90:CHILD\n  |----4:LEFT\n  |\n|----50:RIGHT\n`;
  const parsed = parseDorisTextPlan(input(plan));
  assert.equal(parsed.fragments[0].root.operationId, "0");
  assert.deepEqual(parsed.fragments[0].root.children.map((node) => node.operationId), ["50", "90"]);
  assert.deepEqual(parsed.fragments[0].root.children[1].children.map((node) => node.operationId), ["4"]);
});

test("Doris parser fails closed on missing fragments, malformed branches, ambiguous indentation and duplicate fragments", () => {
  const invalidPlans = [
    ["missing fragment", "1:VEXCHANGE", "MALFORMED_PLAN"],
    ["missing operator", "PLAN FRAGMENT 0\nVRESULT SINK", "MALFORMED_PLAN"],
    ["branch with no parent", "PLAN FRAGMENT 0\n|----1:VEXCHANGE", "MALFORMED_BRANCH_TREE"],
    ["ambiguous same-column node", "PLAN FRAGMENT 0\n0:ROOT\n1:OTHER", "AMBIGUOUS_BRANCH_TREE"],
    ["duplicate fragment", "PLAN FRAGMENT 0\n0:ROOT\nPLAN FRAGMENT 0\n1:OTHER", "MALFORMED_FRAGMENT"],
    ["equivalent zero-padded fragment id", "PLAN FRAGMENT 0\n0:ROOT\nPLAN FRAGMENT 00\n1:OTHER", "MALFORMED_FRAGMENT"],
  ];

  for (const [label, plan, code] of invalidPlans) {
    assert.throws(
      () => parseDorisTextPlan(input(plan)),
      (error) => error instanceof PlanParseError && error.code === code,
      label,
    );
  }
});

test("Doris parser is exported from the public Plan Core surface", () => {
  const rawInput = input("PLAN FRAGMENT 0\n0:VEXCHANGE");
  assert.deepEqual(parseDorisFromPublicSurface(rawInput), parseDorisTextPlan(rawInput));
});

test("Doris parser accepts Estimated text only", () => {
  assert.throws(
    () => parseDorisTextPlan(input("PLAN FRAGMENT 0\n0:VEXCHANGE", { mode: "actual" })),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
  assert.throws(
    () => parseDorisTextPlan(createRawPlanInput({ database: "doris", mode: "estimated", format: "json", plan: {} })),
    (error) => error instanceof PlanParseError && error.code === "MALFORMED_PLAN",
  );
});
