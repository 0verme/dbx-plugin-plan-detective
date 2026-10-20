/**
 * Pure view-model helpers for the Estimated Plan comparison. The Core report
 * owns matching and reason codes; this module only shapes data for Svelte.
 */

/**
 * Build per-side node markers consumed by PlanTree. A node is marked at most
 * once; `count` is the number of changed fields when status is `changed`.
 *
 * @param {object} report `buildEstimatedPlanDiff` result
 */
export function buildDiffMarks(report) {
  const baseline = new Map();
  const current = new Map();
  const priority = { changed: 4, added: 3, removed: 3, unmatched: 2, ambiguous: 1 };

  function mark(map, nodeId, status, count = 1) {
    if (typeof nodeId !== "string") return;
    const previous = map.get(nodeId);
    if (previous === undefined || priority[status] >= priority[previous.status]) {
      map.set(nodeId, {
        status,
        count: previous?.status === status ? Math.max(previous.count, count) : count,
      });
    }
  }

  for (const match of report.matches ?? []) {
    if (match.changes.length === 0) continue;
    mark(baseline, match.beforeId, "changed", match.changes.length);
    mark(current, match.afterId, "changed", match.changes.length);
  }
  for (const entry of report.nodes?.added ?? []) mark(current, entry.id, "added");
  for (const entry of report.nodes?.removed ?? []) mark(baseline, entry.id, "removed");
  for (const entry of report.nodes?.unmatched?.baseline ?? []) mark(baseline, entry.id, "unmatched");
  for (const entry of report.nodes?.unmatched?.current ?? []) mark(current, entry.id, "unmatched");
  for (const entry of report.nodes?.ambiguous ?? []) {
    for (const id of entry.beforeIds) mark(baseline, id, "ambiguous");
    for (const id of entry.afterIds) mark(current, id, "ambiguous");
  }

  return { baseline, current };
}

/**
 * Node ids a change / diagnostic entry points at.
 *
 * @param {{ beforeId?: string|null, afterId?: string|null, before?: {id: string}|null, after?: {id: string}|null }} entry
 */
export function entryNodeIds(entry) {
  return {
    beforeId: entry.beforeId ?? entry.before?.id ?? null,
    afterId: entry.afterId ?? entry.after?.id ?? null,
  };
}

/**
 * Human field labels for one report group entry. Values are formatted here so
 * the component only renders strings; unknown values stay explicit.
 *
 * @param {{ fields: Array<{ field: string }> } } entry
 * @param {(key: string) => string} t
 */
export function describeEntryFields(entry, t) {
  return entry.fields.map((change) => t(`diff.field.${change.field}`));
}

/**
 * Localized field label with a stable English fallback instead of a raw key.
 *
 * @param {string} field
 * @param {(key: string) => string} t
 */
export function fieldLabel(field, t) {
  const label = t(`diff.field.${field}`);
  return label === `diff.field.${field}` ? field : label;
}

/**
 * Native values for the focused pair, independent of the change buckets.
 * Missing values stay `null`; nothing is coerced to zero.
 *
 * @param {object|null} before normalized node
 * @param {object|null} after normalized node
 */
export function nodePairDetails(before, after) {
  const pick = (node, read) => (node === null || node === undefined ? null : read(node));
  return [
    {
      key: "operator",
      before: pick(before, (node) => node.nodeType),
      after: pick(after, (node) => node.nodeType),
    },
    {
      key: "relation",
      before: pick(before, (node) => node.relation?.name ?? null),
      after: pick(after, (node) => node.relation?.name ?? null),
    },
    {
      key: "alias",
      before: pick(before, (node) => node.relation?.alias ?? null),
      after: pick(after, (node) => node.relation?.alias ?? null),
    },
    {
      key: "index",
      before: pick(before, (node) => node.relation?.indexName ?? null),
      after: pick(after, (node) => node.relation?.indexName ?? null),
    },
    {
      key: "rows",
      before: pick(before, (node) => node.estimatedRows ?? null),
      after: pick(after, (node) => node.estimatedRows ?? null),
    },
    {
      key: "cost",
      before: pick(before, (node) => node.totalCost ?? null),
      after: pick(after, (node) => node.totalCost ?? null),
    },
    {
      key: "filter",
      before: pick(before, (node) => node.filter ?? null),
      after: pick(after, (node) => node.filter ?? null),
    },
    {
      key: "indexCondition",
      before: pick(before, (node) => node.indexCondition ?? null),
      after: pick(after, (node) => node.indexCondition ?? null),
    },
    {
      key: "joinType",
      before: pick(before, (node) => node.joinType ?? null),
      after: pick(after, (node) => node.joinType ?? null),
    },
    {
      key: "joinCondition",
      before: pick(before, (node) => node.joinCondition ?? null),
      after: pick(after, (node) => node.joinCondition ?? null),
    },
    {
      key: "sortKeys",
      before: pick(before, (node) => node.sortKeys ?? null),
      after: pick(after, (node) => node.sortKeys ?? null),
    },
    {
      key: "groupKeys",
      before: pick(before, (node) => node.groupKeys ?? null),
      after: pick(after, (node) => node.groupKeys ?? null),
    },
    {
      key: "message",
      before: pick(before, (node) => node.engineSpecific?.mysql?.message ?? null),
      after: pick(after, (node) => node.engineSpecific?.mysql?.message ?? null),
    },
  ];
}

/**
 * Only return details that carry a value on at least one side. The predicate
 * pair type in the plan is preserved as text, never normalized to a boolean.
 *
 * @param {ReturnType<typeof nodePairDetails>} details
 */
export function visibleNodePairDetails(details) {
  return details.filter((detail) => detail.before !== null || detail.after !== null);
}
