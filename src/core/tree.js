/**
 * Generic tree helpers shared by normalization, metrics and rules.
 *
 * They work on any node shape that carries a `children` array, so both the
 * parsed (engine-specific) tree and the normalized tree can use them.
 */

/**
 * Depth-first iteration over a plan tree, root included, children in order.
 *
 * @template {{ children: Array<unknown> }} T
 * @param {T} root
 * @yields {T}
 */
export function* walkNodes(root) {
  yield root;
  for (const child of /** @type {any} */ (root).children) {
    yield* walkNodes(child);
  }
}

/**
 * @template {{ children: Array<unknown> }} T
 * @param {T} root
 * @returns {T[]}
 */
export function flattenNodes(root) {
  return [...walkNodes(root)];
}

/**
 * Number of nodes on the longest root-to-leaf path; a single node has depth 1.
 *
 * @param {{ children: Array<any> }} node
 * @returns {number}
 */
export function depthOf(node) {
  let deepest = 0;
  for (const child of node.children) {
    deepest = Math.max(deepest, depthOf(child));
  }
  return 1 + deepest;
}

/**
 * Cost attributed to the node itself, PostgreSQL style: the node's total cost
 * minus the total costs of its children. Children without a total cost count
 * as 0.
 *
 * Returns `null` when the node itself has no total cost, because a partial
 * subtraction would be a made-up number.
 *
 * @param {{ totalCost: number|null, children: Array<any> }} node
 * @returns {number|null}
 */
export function incrementalCostOf(node) {
  if (typeof node.totalCost !== "number" || !Number.isFinite(node.totalCost)) return null;
  let childrenCost = 0;
  for (const child of node.children) {
    if (typeof child.totalCost === "number" && Number.isFinite(child.totalCost)) {
      childrenCost += child.totalCost;
    }
  }
  return node.totalCost - childrenCost;
}
