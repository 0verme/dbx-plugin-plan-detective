import assert from "node:assert/strict";
import test from "node:test";
import { depthOf, flattenNodes, flattenOperatorNodes, isStructuralNode, operatorDepthOf, walkOperatorNodes } from "../../src/core/tree.js";

function node(id, children = [], structural = false) {
  return {
    id,
    children,
    ...(structural ? { engineSpecific: { structural: true } } : {}),
  };
}

test("operator traversal omits structural wrappers but visits their children in order", () => {
  const root = node("root", [
    node("fragment", [node("scan", [node("leaf-filter")]), node("nested-wrapper", [node("join")], true)], true),
    node("top-filter"),
  ], true);

  assert.equal(isStructuralNode(root), true);
  assert.equal(isStructuralNode(root.children[0].children[0]), false);
  assert.deepEqual(flattenNodes(root).map(({ id }) => id), ["root", "fragment", "scan", "leaf-filter", "nested-wrapper", "join", "top-filter"]);
  assert.deepEqual(flattenOperatorNodes(root).map(({ id }) => id), ["scan", "leaf-filter", "join", "top-filter"]);
  assert.deepEqual([...walkOperatorNodes(root)].map(({ id }) => id), ["scan", "leaf-filter", "join", "top-filter"]);
  assert.equal(depthOf(root), 4);
  assert.equal(operatorDepthOf(root), 2);
});

test("plans without structural markers preserve their existing traversal and depth", () => {
  const root = node("root", [node("child", [node("leaf")])]);
  assert.deepEqual(flattenOperatorNodes(root).map(({ id }) => id), ["root", "child", "leaf"]);
  assert.equal(operatorDepthOf(root), depthOf(root));
});
