/** Tree helpers for parsed plan nodes. Pure functions, no I/O. */

/**
 * Depth-first iteration over a parsed plan tree (root included).
 *
 * @param {import("../../src/core/postgres/parse-json-plan.js").ParsedPlanNode} root
 * @yields {import("../../src/core/postgres/parse-json-plan.js").ParsedPlanNode}
 */
export function* walkNodes(root) {
  yield root;
  for (const child of root.children) {
    yield* walkNodes(child);
  }
}

/**
 * @param {import("../../src/core/postgres/parse-json-plan.js").ParsedPlanNode} root
 * @returns {import("../../src/core/postgres/parse-json-plan.js").ParsedPlanNode[]}
 */
export function flattenNodes(root) {
  return [...walkNodes(root)];
}

/**
 * Number of nodes on the longest root-to-leaf path; a single node has depth 1.
 *
 * @param {import("../../src/core/postgres/parse-json-plan.js").ParsedPlanNode} node
 * @returns {number}
 */
export function depthOf(node) {
  return 1 + Math.max(0, ...node.children.map((child) => depthOf(child)));
}

/**
 * Build a linear chain of nodes for arbitrary-depth tests.
 *
 * @param {number} depth
 * @returns {any} raw PostgreSQL-shaped plan node
 */
export function chainNode(depth) {
  const label = depth === 1 ? "Leaf Scan" : `Level ${depth} Node`;
  return {
    "Node Type": label,
    "Plan Rows": depth,
    "Total Cost": depth * 1.5,
    ...(depth > 1 ? { Plans: [chainNode(depth - 1)] } : {}),
  };
}
