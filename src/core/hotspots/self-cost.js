/**
 * PostgreSQL cost attribution for hotspot analysis.
 *
 * PostgreSQL reports `Total Cost` as a subtree-cumulative estimate, so the
 * naive "own cost" derivation is
 *
 *     selfCost(node) = node.totalCost - sum(child.totalCost)
 *
 * which the existing `incrementalCostOf` helper implements for the rule path.
 * That derivation is **not universally safe**, and hotspot evidence must not
 * present made-up numbers. Two verified counterexamples exist:
 *
 * 1. `Limit` truncates its child's cost. In `fixtures/postgres/estimated/
 *    nested-loop.plan.json` the Limit reports Total Cost 8.03 while its Index
 *    Scan child reports 155.28, so the subtraction yields -147.25. PostgreSQL
 *    only expects to pay for the rows the limit needs, so the child's full cost
 *    never flows into the parent.
 * 2. `InitPlan` / `SubPlan` children are charged through `cost_subplan()`
 *    (startup cost for initplans, per-call cost for correlated subplans), not
 *    by adding the child's Total Cost. An `EXPLAIN` of
 *    `SELECT * FROM t WHERE (SELECT count(*) FROM t2) > 100` shows a Result
 *    node of 7494.01 with an InitPlan Aggregate child of 3997.01, and sibling
 *    nodes inherit the charged startup cost.
 *
 * This module therefore computes an explicit attribution envelope instead of
 * reusing `incrementalCostOf`:
 *
 * - a plan without a positive root cost has no denominator: `NO_PLAN_COST`;
 * - a plan where any node misses Total Cost has incomplete arithmetic:
 *   `MISSING_NODE_COST`;
 * - a plan with an `InitPlan` / `SubPlan` child relationship has non-cumulative
 *   parent cost: `PLAN_CONTAINS_SUBPLAN`;
 * - a plan with a missing or unknown child relationship cannot be verified:
 *   `UNVERIFIED_COST_FLOW`;
 * - inside an otherwise cumulative plan, a node whose self cost is negative
 *   (a truncating node such as `Limit`) is not attributable, and neither are
 *   its descendants, because the root total does not contain their full cost.
 *   Ancestors are still attributable: the truncating node's charged cost is
 *   exactly what they paid.
 *
 * `MISSING_NODE_COST` intentionally differs from `incrementalCostOf`, which
 * treats a child without a cost as 0. Hotspot evidence refuses that guess.
 */

import { flattenNodes } from "../tree.js";

/** Child relationships through which a cumulative Total Cost flows unchanged. */
const COST_CUMULATIVE_RELATIONSHIPS = new Set(["Outer", "Inner", "Member"]);

/** Relationships that mean "this subtree is charged by cost_subplan()". */
const SUBPLAN_RELATIONSHIPS = new Set(["InitPlan", "SubPlan"]);

/**
 * @typedef {Object} PostgresCostAttribution
 * @property {"available"|"withheld"} status
 * @property {string|null} reason stable withholding reason, `null` when available
 * @property {Map<string, { selfCost: number, selfCostShare: number }>} byNodeId
 *   attributable self cost per normalized node id; empty when withheld
 */

/**
 * Analyze whether PostgreSQL self-cost attribution is safe for one plan.
 *
 * @param {import("../normalize/normalize-postgres.js").NormalizedNode} root
 * @param {number|null} totalPlanCost root Total Cost from the metrics stage
 * @returns {PostgresCostAttribution}
 */
export function analyzePostgresCost(root, totalPlanCost) {
  if (typeof totalPlanCost !== "number" || !Number.isFinite(totalPlanCost) || totalPlanCost <= 0) {
    return withheld("NO_PLAN_COST");
  }

  const nodes = flattenNodes(root);
  if (nodes.some((node) => !isFiniteNumber(node.totalCost))) {
    return withheld("MISSING_NODE_COST");
  }

  for (const node of nodes) {
    for (const child of node.children) {
      const relationship = child.engineSpecific?.parentRelationship;
      if (typeof relationship === "string" && SUBPLAN_RELATIONSHIPS.has(relationship)) {
        return withheld("PLAN_CONTAINS_SUBPLAN");
      }
      if (typeof relationship !== "string" || !COST_CUMULATIVE_RELATIONSHIPS.has(relationship)) {
        return withheld("UNVERIFIED_COST_FLOW");
      }
    }
  }

  /** @type {PostgresCostAttribution["byNodeId"]} */
  const byNodeId = new Map();

  /**
   * @param {import("../normalize/normalize-postgres.js").NormalizedNode} node
   * @param {boolean} inScope whether this subtree's cost is contained in the root total
   */
  function visit(node, inScope) {
    const selfCost = selfCostOf(node);
    const attributable = inScope && selfCost !== null && selfCost >= 0;
    if (attributable) {
      byNodeId.set(node.id, { selfCost, selfCostShare: round4(selfCost / totalPlanCost) });
    }
    // A negative self cost means this node truncated its children (Limit):
    // deeper nodes kept their full cost estimate, which the root total does not
    // contain, so shares below it are not comparable.
    for (const child of node.children) visit(child, attributable);
  }

  visit(root, true);
  return { status: "available", reason: null, byNodeId };
}

/**
 * Own cost of one node, or `null` when it cannot be derived from the reported
 * values. Unlike `incrementalCostOf`, a child without a Total Cost makes the
 * whole derivation unavailable instead of counting as 0.
 *
 * @param {{ totalCost: number|null, children: Array<{ totalCost: number|null }> }} node
 * @returns {number|null}
 */
export function selfCostOf(node) {
  if (!isFiniteNumber(node.totalCost)) return null;
  let childrenCost = 0;
  for (const child of node.children) {
    if (!isFiniteNumber(child.totalCost)) return null;
    childrenCost += child.totalCost;
  }
  return node.totalCost - childrenCost;
}

/**
 * @param {string} reason
 * @returns {PostgresCostAttribution}
 */
function withheld(reason) {
  return { status: "withheld", reason, byNodeId: new Map() };
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {number} value */
function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}
