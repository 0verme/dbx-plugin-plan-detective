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
 * Structural nodes are presentation / grouping containers, not operators.
 * The optional marker is generic and backward-compatible: existing normalized
 * plans without it retain their original traversal and metric semantics.
 *
 * @param {{ engineSpecific?: Record<string, unknown> }} node
 */
export function isStructuralNode(node) {
  return node?.engineSpecific?.structural === true;
}

/**
 * Depth-first iteration over operator nodes only. Structural nodes are omitted
 * from the result, but their children are still traversed.
 *
 * @template {{ children: Array<unknown>, engineSpecific?: Record<string, unknown> }} T
 * @param {T} root
 * @yields {T}
 */
export function* walkOperatorNodes(root) {
  if (!isStructuralNode(root)) yield root;
  for (const child of /** @type {any} */ (root).children) {
    yield* walkOperatorNodes(child);
  }
}

/**
 * @template {{ children: Array<unknown>, engineSpecific?: Record<string, unknown> }} T
 * @param {T} root
 * @returns {T[]}
 */
export function flattenOperatorNodes(root) {
  return [...walkOperatorNodes(root)];
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
 * Longest operator-only path. Structural wrappers do not add depth, but their
 * children remain on the same path. A tree with no operator nodes has depth 0.
 *
 * @param {{ children: Array<any>, engineSpecific?: Record<string, unknown> }} root
 * @returns {number}
 */
export function operatorDepthOf(root) {
  /** @param {any} node @param {number} depth */
  function visit(node, depth) {
    const currentDepth = depth + (isStructuralNode(node) ? 0 : 1);
    let deepest = currentDepth;
    for (const child of node.children) deepest = Math.max(deepest, visit(child, currentDepth));
    return deepest;
  }
  return visit(root, 0);
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
