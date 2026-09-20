import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { parsePostgresJsonPlan } from "../../src/core/postgres/parse-json-plan.js";
import { loadAllFixtures } from "../helpers/fixtures.js";
import { depthOf, flattenNodes } from "../helpers/plan-tree.js";

const fixtures = await loadAllFixtures();

test("fixture set covers both estimated and actual plans", () => {
  const modes = new Set(fixtures.map((fixture) => fixture.mode));
  assert.deepEqual([...modes].sort(), ["actual", "estimated"]);
});

test("every fixture parses and matches the behavior recorded in its metadata", async (t) => {
  for (const fixture of fixtures) {
    await t.test(`${fixture.mode}/${fixture.name}`, () => {
      const parsed = parsePostgresJsonPlan(fixture.input);
      const nodes = flattenNodes(parsed.root);

      assert.equal(parsed.root.nodeType, fixture.meta.expect.rootNodeType, "root node type");
      assert.ok(
        depthOf(parsed.root) >= fixture.meta.expect.minDepth,
        `expected depth >= ${fixture.meta.expect.minDepth}, got ${depthOf(parsed.root)}`,
      );
      assert.ok(nodes.length >= 1);

      const nodesWithActualRows = nodes.filter((node) => node.actualRows !== null);
      assert.equal(
        nodesWithActualRows.length > 0,
        fixture.meta.expect.hasActualFields,
        "actual-execution fields present in the parsed tree",
      );
    });
  }
});

test("findings match the expected rule ids recorded in fixture metadata", async (t) => {
  for (const fixture of fixtures) {
    await t.test(`${fixture.mode}/${fixture.name}`, () => {
      const ruleIds = analyzePlan(fixture.input).findings.map((finding) => finding.ruleId);
      assert.deepEqual(
        [...new Set(ruleIds)].sort(),
        [...new Set(fixture.meta.expect.findingRuleIds)].sort(),
        "rule ids in fixture metadata must match the rules that actually fired",
      );
    });
  }
});

test("estimated fixtures never carry actual-execution values", async (t) => {
  for (const fixture of fixtures.filter((candidate) => candidate.mode === "estimated")) {
    await t.test(`${fixture.mode}/${fixture.name}`, () => {
      for (const node of flattenNodes(parsePostgresJsonPlan(fixture.input).root)) {
        assert.equal(node.actualRows, null);
        assert.equal(node.actualTotalTime, null);
        assert.equal(node.actualLoops, null);
        assert.equal("Actual Rows" in node.extra, false);
        assert.equal("Actual Total Time" in node.extra, false);
        assert.equal("Actual Loops" in node.extra, false);
      }
    });
  }
});

test("actual fixtures map actual-execution values without touching Plan Rows", async (t) => {
  for (const fixture of fixtures.filter((candidate) => candidate.mode === "actual")) {
    await t.test(`${fixture.mode}/${fixture.name}`, () => {
      const root = parsePostgresJsonPlan(fixture.input).root;
      assert.notEqual(root.actualRows, null, "root Actual Rows must be mapped");
      assert.notEqual(root.actualTotalTime, null, "root Actual Total Time must be mapped");
      assert.notEqual(root.actualLoops, null, "root Actual Loops must be mapped");
      assert.notEqual(root.planRows, null, "root Plan Rows must stay available");
    });
  }
});

test("the estimate-mismatch fixture keeps Plan Rows and Actual Rows separate", () => {
  const fixture = fixtures.find((candidate) => candidate.name === "estimate-mismatch");
  assert.ok(fixture, "estimate-mismatch fixture must exist");

  const root = parsePostgresJsonPlan(fixture.input).root;
  assert.ok(root.planRows > 0 && root.actualRows > 0);
  assert.ok(root.actualRows > root.planRows * 10, "fixture must exercise a visible estimate deviation");
});

test("nested-loop-loops fixture exercises Actual Loops > 1 on inner nodes", () => {
  const fixture = fixtures.find((candidate) => candidate.name === "nested-loop-loops");
  assert.ok(fixture, "nested-loop-loops fixture must exist");

  const loops = flattenNodes(parsePostgresJsonPlan(fixture.input).root)
    .map((node) => node.actualLoops)
    .filter((value) => value !== null);

  assert.ok(Math.max(...loops) > 1, `expected an inner node with Actual Loops > 1, got ${loops.join(", ")}`);
});

test("the offline core covers every PostgreSQL node type named in the vertical slice", () => {
  const kinds = new Set();
  let sawUnknownNodeType = false;

  for (const fixture of fixtures) {
    const normalized = analyzePlan(fixture.input).normalized;
    for (const node of flattenNodes(normalized.root)) {
      kinds.add(node.kind);
    }
    sawUnknownNodeType ||= normalized.unknownNodeTypes.length > 0;
  }

  for (const expected of [
    "seq_scan",
    "index_scan",
    "index_only_scan",
    "bitmap_heap_scan",
    "bitmap_index_scan",
    "nested_loop",
    "hash_join",
    "merge_join",
    "hash",
    "sort",
    "aggregate",
    "group",
    "limit",
  ]) {
    assert.ok(kinds.has(expected), `fixture set must exercise normalized kind "${expected}"`);
  }

  assert.ok(sawUnknownNodeType, "at least one fixture must exercise an unclassified node type");
});

test("real fixtures exercise arbitrary tree depth, not only root/child", () => {
  const maxDepth = Math.max(...fixtures.map((fixture) => depthOf(parsePostgresJsonPlan(fixture.input).root)));
  assert.ok(maxDepth >= 4, `expected at least one fixture with depth >= 4, got ${maxDepth}`);
});
