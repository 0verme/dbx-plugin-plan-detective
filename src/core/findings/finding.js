/**
 * Finding contract.
 *
 * A finding is a deterministic statement about one plan node. It carries the
 * rule that produced it, a severity, a neutral summary and structured evidence.
 * Findings are observations: a rule may conclude that something is worth
 * checking, never that a specific rewrite must be applied.
 */

/** Severity ladder, from pure observation to strongly worth attention. */
export const SEVERITIES = Object.freeze(["info", "warning", "high"]);

/**
 * Base evidence shared by every rule. Rules extend it with their own
 * rule-specific fields; values stay JSON-serializable so findings can be stored
 * in golden files and compared with `deepStrictEqual`.
 *
 * @param {{ id: string, nodeType: string, relation: { name: string|null }|null, estimatedRows: number|null, totalCost: number|null }} node
 * @param {Record<string, unknown>} [extra]
 * @returns {Record<string, unknown>}
 */
export function nodeEvidence(node, extra = {}) {
  return {
    nodeId: node.id,
    nodeType: node.nodeType,
    relation: node.relation?.name ?? null,
    estimatedRows: node.estimatedRows,
    estimatedTotalCost: node.totalCost,
    ...extra,
  };
}

/**
 * @typedef {Object} Finding
 * @property {string} id deterministic `${ruleId}:${nodeRef}`
 * @property {string} ruleId
 * @property {"info"|"warning"|"high"} severity
 * @property {string} title
 * @property {string} summary neutral, evidence-based statement
 * @property {string} nodeRef normalized node id the finding is about
 * @property {Record<string, unknown>} evidence
 */

/**
 * Build a finding. Inputs are validated eagerly so a broken rule fails in tests
 * instead of producing a half-valid finding.
 *
 * @param {{ ruleId: string, severity: string, title: string, summary: string, node: { id: string }, evidence: Record<string, unknown> }} input
 * @returns {Finding}
 */
export function createFinding({ ruleId, severity, title, summary, node, evidence }) {
  if (typeof ruleId !== "string" || ruleId.length === 0) {
    throw new TypeError("createFinding requires a non-empty ruleId");
  }
  if (!SEVERITIES.includes(severity)) {
    throw new TypeError(`createFinding severity must be one of ${SEVERITIES.join(", ")}; got ${JSON.stringify(severity)}`);
  }
  if (typeof title !== "string" || title.length === 0) {
    throw new TypeError("createFinding requires a non-empty title");
  }
  if (typeof summary !== "string" || summary.length === 0) {
    throw new TypeError("createFinding requires a non-empty summary");
  }
  if (node === null || typeof node !== "object" || typeof node.id !== "string" || node.id.length === 0) {
    throw new TypeError("createFinding requires a normalized node with a non-empty id");
  }
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new TypeError("createFinding requires an evidence object");
  }

  return {
    id: `${ruleId}:${node.id}`,
    ruleId,
    severity,
    title,
    summary,
    nodeRef: node.id,
    evidence,
  };
}
