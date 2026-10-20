import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEstimatedPlanDiff,
  describeEstimatedPlanDiffSupport,
} from "../../src/core/index.js";
import { normalizedNode, normalizedPlan } from "../helpers/plan-builders.js";

/* --------------------------------------------------------------- helpers -- */

function node(id, overrides = {}) {
  return normalizedNode({ id, ...overrides });
}

function scan(id, name, overrides = {}) {
  const { alias = null, indexName = null, ...rest } = overrides;
  return node(id, {
    estimatedRows: 100,
    ...rest,
    relation: { name, alias, indexName },
  });
}

function finding(ruleId, target, evidence = {}, severity = "warning") {
  return {
    id: `${ruleId}:${target.id}`,
    ruleId,
    severity,
    title: ruleId,
    summary: `${ruleId} on ${target.id}`,
    nodeRef: target.id,
    evidence: { nodeId: target.id, nodeType: target.nodeType, ...evidence },
  };
}

function hotspot(target, reasonCode = "large-sequential-scan", level = "warning", evidence = { estimatedRows: 1000 }) {
  return {
    id: `hotspot:${target.id}`,
    nodeId: target.id,
    nodeType: target.nodeType,
    kind: target.kind,
    relation: target.relation?.name ?? null,
    reasons: [{ code: reasonCode, level, summary: reasonCode, source: "estimated cost", evidence }],
    evidence: { nodeId: target.id, estimatedRows: target.estimatedRows },
    estimateOnly: true,
  };
}

/**
 * Build the session shape the Host produces, so the report reads rawInput,
 * findings and hotspots exactly like production.
 */
function session(root, options = {}) {
  const normalized = normalizedPlan({
    database: options.database ?? "postgresql",
    mode: options.mode ?? "estimated",
    format: options.format ?? "json",
    root,
  });
  const findings = options.findings ?? [];
  const hotspots = options.hotspots ?? { items: [] };
  return {
    status: "structured",
    capturedAt: options.capturedAt ?? null,
    source: options.source ?? { databaseName: "app", schema: "public" },
    rawInput: {
      database: normalized.database,
      mode: normalized.mode,
      format: normalized.format,
      plan: {},
      ...(options.sql === undefined ? {} : { sql: options.sql }),
      ...(options.version === undefined ? {} : { databaseVersion: options.version }),
    },
    analysis: {
      status: "structured",
      normalized,
      findings,
      hotspots,
      metrics: {},
    },
  };
}

function report(baseline, current, extras = {}) {
  return buildEstimatedPlanDiff({ baseline, current, ...extras });
}

function group(reportValue, category) {
  return reportValue.groups[category];
}

/* ----------------------------------------------------------------- tests -- */

test("identical plans produce no false differences and are deterministic, round-trippable and non-mutating", () => {
  const orders = scan("0", "orders", {
    alias: "o",
    indexName: "orders_pkey",
    estimatedRows: 12,
    startupCost: 0.1,
    totalCost: 2.4,
    filter: "(status = 'open')",
  });
  const baseline = session(orders, { version: "16.4", sql: "SELECT * FROM orders WHERE status = 'open'", findings: [finding("large-sequential-scan", orders)], hotspots: { items: [hotspot(orders)] } });
  const before = structuredClone(baseline);

  const first = report(baseline, baseline);
  const second = report(baseline, baseline);

  assert.equal(first.status, "comparable");
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.equal(first.summary.changed, 0);
  assert.equal(first.summary.matched, 1);
  assert.deepEqual(first.groups.access, []);
  assert.deepEqual(first.groups.rows, []);
  assert.equal(first.diagnostics.findings.unchanged, 1);
  assert.equal(first.diagnostics.hotspots.unchanged, 1);
  assert.deepEqual(baseline, before, "the report never mutates either analysis");
});

test("only estimated rows changed: row delta is numeric, missing values are unknown, and no percent is invented", () => {
  const base = scan("0", "orders", { estimatedRows: 1000 });
  const current = scan("0.0", "orders", { estimatedRows: 40 });
  const result = report(
    session(base, { version: "16", sql: "SELECT 1" }),
    session(current, { version: "16", sql: "SELECT 1" }),
  );

  assert.equal(result.summary.changed, 1);
  assert.equal(result.summary.added, 0);
  assert.equal(result.summary.removed, 0);
  const [entry] = group(result, "rows");
  assert.equal(entry.beforeId, "0");
  assert.equal(entry.afterId, "0.0");
  assert.equal(entry.rowsDelta, -960);
  assert.equal(entry.fields[0].before, 1000);
  assert.equal(entry.fields[0].after, 40);
  assert.equal(Object.hasOwn(entry, "percent"), false);

  const missing = report(
    session(scan("0", "orders", { estimatedRows: null }), { version: "16", sql: "SELECT 1" }),
    session(scan("0", "orders", { estimatedRows: 0 }), { version: "16", sql: "SELECT 1" }),
  );
  const [missingEntry] = group(missing, "rows");
  assert.equal(missingEntry.fields[0].before, null);
  assert.equal(missingEntry.fields[0].after, 0);
  assert.equal(missingEntry.rowsDelta, null, "unknown is not treated as zero");
  assert.equal(JSON.stringify(missing).includes("NaN"), false);
  assert.equal(JSON.stringify(missing).includes("Infinity"), false);
});

test("zero stays a real value and never produces Infinity or a fake ratio", () => {
  const result = report(
    session(scan("0", "orders", { estimatedRows: 0, totalCost: 0 }), { version: "16", sql: "SELECT 1" }),
    session(scan("0", "orders", { estimatedRows: 0, totalCost: 0 }), { version: "16", sql: "SELECT 1" }),
  );
  assert.equal(result.comparability.cost.status, "available");
  assert.equal(result.comparability.cost.baseline, 0);
  assert.equal(result.comparability.cost.current, 0);
  assert.deepEqual(group(result, "rows"), []);
  assert.equal(result.summary.changed, 0);
});

test("Seq Scan to Index Scan keeps the match and groups access, index, rows and predicate evidence", () => {
  const before = scan("0", "orders", { kind: "seq_scan", nodeType: "Seq Scan", estimatedRows: 1000, totalCost: 90 });
  const after = scan("0.0", "orders", {
    kind: "index_scan",
    nodeType: "Index Scan",
    indexName: "orders_status_idx",
    estimatedRows: 40,
    totalCost: 8,
    indexCondition: "(status = 'open')",
  });
  const result = report(
    session(before, { version: "16", sql: "SELECT * FROM orders" }),
    session(after, { version: "16", sql: "SELECT * FROM orders" }),
  );

  assert.equal(result.summary.matched, 1);
  assert.equal(result.matches[0].evidence.method, "qualified-relation-name-and-alias");
  assert.equal(group(result, "access")[0].after.nodeType, "Index Scan");
  assert.equal(group(result, "index")[0].after.indexName, "orders_status_idx");
  assert.equal(group(result, "rows")[0].rowsDelta, -960);
  assert.equal(group(result, "predicate")[0].fields[0].after, "(status = 'open')");
  assert.equal(result.comparability.cost.status, "available");
  assert.equal(result.comparability.cost.baseline, 90);
  assert.equal(result.comparability.cost.current, 8);
  assert.equal(Object.hasOwn(result.comparability.cost, "delta"), false);
  assert.equal(Object.hasOwn(result.comparability.cost, "ratio"), false);
});

test("an inserted Sort is reported as a confirmed addition above the matched scan, never as a fake field change", () => {
  const before = session(scan("0", "orders", { estimatedRows: 100 }), { version: "16", sql: "SELECT 1" });
  const sort = node("0", {
    kind: "sort",
    nodeType: "Sort",
    sortKeys: ["orders.id"],
    estimatedRows: 100,
    children: [scan("0.0", "orders", { estimatedRows: 100 })],
  });
  const after = session(sort, { version: "16", sql: "SELECT 1" });

  const result = report(before, after);
  assert.deepEqual(result.nodes.added.map(({ id }) => id), ["0"]);
  assert.deepEqual(result.nodes.removed, []);
  assert.equal(result.summary.added, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].beforeId, "0");
  assert.equal(result.matches[0].afterId, "0.0");
  assert.equal(result.matches[0].changes.length, 0);
  assert.deepEqual(group(result, "sort"), []);

  const reversed = report(after, before);
  assert.deepEqual(reversed.nodes.removed.map(({ id }) => id), ["0"]);
  assert.deepEqual(reversed.nodes.added, []);
});

test("a matched Sort with changed keys stays matched and reports the key change", () => {
  const before = node("0", { kind: "sort", nodeType: "Sort", sortKeys: ["orders.id"], children: [scan("0.0", "orders")] });
  const after = node("0.0", { kind: "sort", nodeType: "Sort", sortKeys: ["orders.id DESC"], children: [scan("0.0.0", "orders")] });
  const result = report(
    session(before, { version: "16", sql: "SELECT 1" }),
    session(after, { version: "16", sql: "SELECT 1" }),
  );
  const sortMatch = result.matches.find(({ beforeId }) => beforeId === "0");
  assert.ok(sortMatch);
  assert.equal(group(result, "sort").length, 1);
  assert.deepEqual(group(result, "sort")[0].fields[0], {
    field: "sortKeys",
    before: ["orders.id"],
    after: ["orders.id DESC"],
  });
});

test("a Join algorithm change keeps both scans matched and reports the algorithm under join", () => {
  const build = (joinKind, joinType) => node("0", {
    kind: joinKind,
    nodeType: joinType,
    joinType: "Inner",
    joinCondition: "(o.id = u.order_id)",
    children: [scan("0.0", "orders", { alias: "o" }), scan("0.1", "users", { alias: "u" })],
  });
  const result = report(
    session(build("nested_loop", "Nested Loop"), { version: "16", sql: "SELECT 1" }),
    session(build("hash_join", "Hash Join"), { version: "16", sql: "SELECT 1" }),
  );

  assert.equal(result.matches.some(({ beforeId }) => beforeId === "0"), true);
  assert.equal(group(result, "join").length, 1);
  assert.equal(result.summary.added, 0);
  assert.equal(result.summary.removed, 0);
  assert.deepEqual(
    result.matches.filter(({ beforeId }) => beforeId.startsWith("0.")).map(({ beforeId, afterId }) => [beforeId, afterId]).sort(),
    [["0.0", "0.0"], ["0.1", "0.1"]],
  );
});

test("Join order changes do not rely on path ids or child order, and do not invent added/removed nodes", () => {
  const baseline = node("0", {
    kind: "nested_loop",
    nodeType: "Nested Loop",
    children: [scan("0.0", "orders", { alias: "o" }), scan("0.1", "users", { alias: "u" })],
  });
  const swapped = node("0", {
    kind: "nested_loop",
    nodeType: "Nested Loop",
    children: [scan("0.0", "users", { alias: "u" }), scan("0.1", "orders", { alias: "o" })],
  });
  const result = report(
    session(baseline, { version: "16", sql: "SELECT 1" }),
    session(swapped, { version: "16", sql: "SELECT 1" }),
  );

  const scanMatches = result.matches.filter(({ beforeId }) => beforeId.startsWith("0."));
  assert.deepEqual(scanMatches.map(({ beforeId, afterId }) => [beforeId, afterId]).sort(), [["0.0", "0.1"], ["0.1", "0.0"]]);
  assert.deepEqual(result.nodes.added, []);
  assert.deepEqual(result.nodes.removed, []);
  assert.equal(result.nodes.ambiguous.length, 0);
});

test("path ids may drift wholesale; identity comes from relation/alias evidence", () => {
  const baseline = node("0", {
    kind: "hash_join",
    nodeType: "Hash Join",
    children: [scan("0.0", "orders", { alias: "o" }), scan("0.1", "users", { alias: "u" })],
  });
  const drifted = node("10", {
    kind: "hash_join",
    nodeType: "Hash Join",
    children: [scan("10.0", "orders", { alias: "o" }), scan("10.1", "users", { alias: "u" })],
  });
  const result = report(
    session(baseline, { version: "16", sql: "SELECT 1" }),
    session(drifted, { version: "16", sql: "SELECT 1" }),
  );
  assert.equal(result.matches.some(({ beforeId, afterId }) => beforeId !== afterId), true);
  assert.equal(result.summary.changed, 0);
  assert.deepEqual(result.nodes.added, []);
  assert.deepEqual(result.nodes.removed, []);
});

test("repeated self-join identities stay ambiguous, are not counted as added/removed, and unlink diagnostics", () => {
  const selfJoin = (idPrefix, sharedAlias = "o") => node("0", {
    kind: "nested_loop",
    nodeType: "Nested Loop",
    children: [
      scan(`${idPrefix}.0`, "orders", { alias: sharedAlias, fixed: true }),
      scan(`${idPrefix}.1`, "orders", { alias: sharedAlias, fixed: true }),
    ],
  });
  const baselineTree = selfJoin("0");
  const currentTree = selfJoin("0");
  const baseline = session(baselineTree, {
    version: "16",
    sql: "SELECT 1",
    findings: [finding("large-sequential-scan", baselineTree.children[0])],
  });
  const current = session(currentTree, {
    version: "16",
    sql: "SELECT 1",
    findings: [finding("large-sequential-scan", currentTree.children[0])],
  });
  const result = report(baseline, current);

  assert.ok(result.nodes.ambiguous.length > 0);
  assert.ok(result.summary.ambiguous >= 2);
  assert.deepEqual(result.nodes.added, []);
  assert.deepEqual(result.nodes.removed, []);
  assert.equal(result.diagnostics.findings.added.length, 0);
  assert.equal(result.diagnostics.findings.resolved.length, 0);
  assert.equal(result.diagnostics.findings.unlinked.baseline.length, 1);
  assert.equal(result.diagnostics.findings.unlinked.current.length, 1);
});

test("a scan of a relation absent from the other plan is added/removed; a same-name scan is only unmatched", () => {
  const baseline = node("0", {
    kind: "hash_join",
    nodeType: "Hash Join",
    children: [scan("0.0", "orders", { alias: "o" }), scan("0.1", "users", { alias: "u" })],
  });
  const withNewRelation = node("0", {
    kind: "hash_join",
    nodeType: "Hash Join",
    children: [scan("0.0", "orders", { alias: "o" }), scan("0.1", "users", { alias: "u" }), scan("0.2", "products", { alias: "p" })],
  });
  const added = report(
    session(baseline, { version: "16", sql: "SELECT 1" }),
    session(withNewRelation, { version: "16", sql: "SELECT 1" }),
  );
  assert.ok(added.nodes.added.some(({ id }) => id === "0.2"));
  assert.equal(added.nodes.added.find(({ id }) => id === "0.2").node.relation, "products");
  assert.equal(added.nodes.added.some(({ id }) => id === "0"), false, "the join still exists, so it must not be reported as added");
  assert.ok(added.nodes.unmatched.current.some(({ id }) => id === "0"));
  assert.deepEqual(added.nodes.removed, []);

  const removed = report(
    session(withNewRelation, { version: "16", sql: "SELECT 1" }),
    session(baseline, { version: "16", sql: "SELECT 1" }),
  );
  assert.ok(removed.nodes.removed.some(({ id }) => id === "0.2"));

  const twoOrders = node("0", {
    kind: "hash_join",
    nodeType: "Hash Join",
    children: [scan("0.0", "orders", { alias: "o" }), scan("0.1", "orders", { alias: "o2" })],
  });
  const oneOrder = node("0", {
    kind: "hash_join",
    nodeType: "Hash Join",
    children: [scan("0.0", "orders", { alias: "o" })],
  });
  const partial = report(
    session(twoOrders, { version: "16", sql: "SELECT 1" }),
    session(oneOrder, { version: "16", sql: "SELECT 1" }),
  );
  assert.deepEqual(partial.nodes.removed, []);
  assert.ok(partial.nodes.unmatched.baseline.some(({ id }) => id === "0.1"));
});

test("Findings associate by ruleId and matched node: added, resolved, evidence changed and unlinked", () => {
  const beforeOrders = scan("0.0", "orders", { alias: "o", estimatedRows: 1000 });
  const beforeUsers = scan("0.1", "users", { alias: "u", estimatedRows: 100 });
  const afterOrders = scan("0.0", "orders", { alias: "o", estimatedRows: 5000 });
  const afterUsers = scan("0.1", "users", { alias: "u", estimatedRows: 100 });
  const afterProducts = scan("0.2", "products", { alias: "p", estimatedRows: 50 });
  const join = (children) => node("0", { kind: "hash_join", nodeType: "Hash Join", children });

  const baseline = session(join([beforeOrders, beforeUsers]), {
    version: "16",
    sql: "SELECT 1",
    findings: [
      finding("large-sequential-scan", beforeOrders, { estimatedRows: 1000 }),
      finding("missing-index", beforeUsers, { estimatedRows: 100 }),
    ],
  });
  const current = session(join([afterOrders, afterUsers, afterProducts]), {
    version: "16",
    sql: "SELECT 1",
    findings: [
      finding("large-sequential-scan", afterOrders, { estimatedRows: 5000 }),
      finding("new-rule", afterOrders, { estimatedRows: 5000 }),
      finding("missing-index", afterProducts, { estimatedRows: 50 }),
    ],
  });
  const result = report(baseline, current);
  const findings = result.diagnostics.findings;

  assert.equal(result.diagnostics.status, "available");
  assert.deepEqual(findings.added.map(({ ruleId }) => ruleId), ["new-rule"]);
  assert.deepEqual(findings.resolved.map(({ ruleId }) => ruleId), ["missing-index"]);
  assert.equal(findings.evidenceChanged.length, 1);
  assert.equal(findings.evidenceChanged[0].ruleId, "large-sequential-scan");
  assert.deepEqual(findings.evidenceChanged[0].changedFields, ["estimatedRows"]);
  assert.equal(findings.unchanged, 0);
  assert.deepEqual(findings.unlinked.current.map(({ ruleId }) => ruleId), ["missing-index"], "a finding on a newly added node has no matched anchor");
  assert.equal(result.nodes.added.some(({ id }) => id === "0.2"), true);
});

test("Hotspots associate by matched node and reason code, including level/evidence changes", () => {
  const beforeOrders = scan("0.0", "orders", { alias: "o", estimatedRows: 1000 });
  const beforeUsers = scan("0.1", "users", { alias: "u", estimatedRows: 100 });
  const afterOrders = scan("0.0", "orders", { alias: "o", estimatedRows: 5000 });
  const afterUsers = scan("0.1", "users", { alias: "u", estimatedRows: 100 });
  const join = (children) => node("0", { kind: "hash_join", nodeType: "Hash Join", children });

  const baseline = session(join([beforeOrders, beforeUsers]), {
    version: "16",
    sql: "SELECT 1",
    hotspots: {
      items: [
        hotspot(beforeOrders, "large-sequential-scan", "warning", { estimatedRows: 1000 }),
        hotspot(beforeUsers, "nested-loop-amplification", "warning", { estimatedRows: 100 }),
      ],
    },
  });
  const current = session(join([afterOrders, afterUsers]), {
    version: "16",
    sql: "SELECT 1",
    hotspots: {
      items: [
        hotspot(afterOrders, "large-sequential-scan", "high", { estimatedRows: 5000 }),
      ],
    },
  });
  const result = report(baseline, current);
  const hotspots = result.diagnostics.hotspots;

  assert.equal(result.diagnostics.status, "available");
  assert.deepEqual(hotspots.added, []);
  assert.deepEqual(hotspots.resolved.map(({ reasonCode }) => reasonCode), ["nested-loop-amplification"]);
  assert.equal(hotspots.evidenceChanged.length, 1);
  assert.equal(hotspots.evidenceChanged[0].reasonCode, "large-sequential-scan");
  assert.equal(hotspots.evidenceChanged[0].levelChanged, true);
  assert.deepEqual(hotspots.evidenceChanged[0].changedFields, ["estimatedRows"]);
});

test("database version and source context: unknown is limited, mismatches are explicit, SQL text is informational", () => {
  const plan = scan("0", "orders");
  const base = report(
    session(plan, { version: "16.4", sql: "SELECT * FROM orders", source: { databaseName: "app", schema: "public" } }),
    session(plan, { version: "16.4", sql: "SELECT * FROM orders WHERE id > 0", source: { databaseName: "app", schema: "public" } }),
  );
  assert.equal(base.comparability.status, "comparable");
  assert.deepEqual(base.comparability.reasons.map(({ code }) => code), ["SQL_TEXT_DIFFERS"]);
  assert.equal(base.comparability.reasons[0].level, "info");

  const versionMismatch = report(
    session(plan, { version: "15.9", sql: "SELECT 1" }),
    session(plan, { version: "16.4", sql: "SELECT 1" }),
  );
  assert.equal(versionMismatch.comparability.status, "limited");
  assert.ok(versionMismatch.comparability.reasons.some(({ code }) => code === "DATABASE_VERSION_MISMATCH"));

  const versionUnknown = report(session(plan, { sql: "SELECT 1" }), session(plan, { sql: "SELECT 1" }));
  assert.equal(versionUnknown.comparability.status, "limited");
  assert.ok(versionUnknown.comparability.reasons.some(({ code }) => code === "DATABASE_VERSION_UNKNOWN"));

  const sourceMismatch = report(
    session(plan, { version: "16", sql: "SELECT 1", source: { databaseName: "app", schema: "public" } }),
    session(plan, { version: "16", sql: "SELECT 1", source: { databaseName: "app", schema: "tenant_b" } }),
  );
  assert.ok(sourceMismatch.comparability.reasons.some(({ code }) => code === "SOURCE_CONTEXT_MISMATCH"));

  const sourceUnknown = report(
    session(plan, { version: "16", sql: "SELECT 1", source: {} }),
    session(plan, { version: "16", sql: "SELECT 1", source: { databaseName: "app" } }),
  );
  assert.ok(sourceUnknown.comparability.reasons.some(({ code }) => code === "SOURCE_CONTEXT_UNKNOWN"));
});

test("PostgreSQL cost is withheld when a side is missing and never coerced to zero", () => {
  const result = report(
    session(scan("0", "orders", { totalCost: 10 }), { version: "16", sql: "SELECT 1" }),
    session(scan("0", "orders", { totalCost: null }), { version: "16", sql: "SELECT 1" }),
  );
  assert.equal(result.comparability.cost.status, "withheld");
  assert.equal(result.comparability.cost.reasonCode, "COST_MISSING");
  assert.equal(result.comparability.cost.baseline, 10);
  assert.equal(result.comparability.cost.current, null);
  assert.equal(Object.hasOwn(result.comparability.cost, "delta"), false);
});

test("native MySQL cost is never mapped to PostgreSQL cost units", () => {
  const result = report(
    session(scan("0", "orders", { totalCost: 5 }), { database: "mysql", version: "8.4", sql: "SELECT 1" }),
    session(scan("0", "orders", { totalCost: 7 }), { database: "mysql", version: "8.4", sql: "SELECT 1" }),
  );
  assert.equal(result.comparability.cost.status, "withheld");
  assert.equal(result.comparability.cost.reasonCode, "COST_MODEL_NOT_DIFFED");
  assert.equal(Object.hasOwn(result.comparability.cost, "delta"), false);
});

test("cross-family, unsupported database and non-estimated / truncated inputs are rejected with stable reasons", () => {
  const pg = session(scan("0", "orders"), { version: "16", sql: "SELECT 1" });
  const my = session(scan("0", "orders"), { database: "mysql", version: "8.4", sql: "SELECT 1" });
  const cross = report(pg, my);
  assert.equal(cross.status, "incompatible");
  assert.equal(cross.reasonCode, "DATABASE_MISMATCH");
  assert.deepEqual(cross.matches, []);
  assert.deepEqual(cross.groups.access, []);
  assert.equal(cross.diagnostics.status, "unavailable");

  const sqlserver = session(scan("0", "orders"), { database: "sqlserver", sql: "SELECT 1" });
  assert.equal(report(sqlserver, sqlserver).reasonCode, "UNSUPPORTED_DATABASE");
  assert.deepEqual(describeEstimatedPlanDiffSupport(sqlserver), {
    supported: false,
    reasonCode: "UNSUPPORTED_DATABASE",
    database: "sqlserver",
  });

  const actual = session(scan("0", "orders"), { mode: "actual", version: "16", sql: "SELECT 1" });
  assert.equal(report(pg, actual).reasonCode, "MODE_NOT_ESTIMATED");

  const rawOnly = { status: "raw-only", analysis: null, rawInput: { database: "postgresql", mode: "estimated", format: "json", plan: {} } };
  assert.equal(report(pg, rawOnly).reasonCode, "RAW_ONLY");

  const truncated = { ...session(scan("0", "orders"), { version: "16", sql: "SELECT 1" }), truncated: true };
  assert.equal(report(pg, truncated).reasonCode, "PLAN_TRUNCATED");

  const failed = { status: "error", analysis: null, hostResult: { truncated: false } };
  assert.equal(report(pg, failed).reasonCode, "ANALYSIS_FAILED");
});

test("describeEstimatedPlanDiffSupport accepts both supported families and rejects non-JSON or unfinished input without acquiring a plan", () => {
  const pg = session(scan("0", "orders"), { version: "16", sql: "SELECT 1" });
  const my = session(scan("0", "orders"), { database: "mysql", version: "8.4", sql: "SELECT 1" });
  assert.deepEqual(describeEstimatedPlanDiffSupport(pg), { supported: true, reasonCode: null, database: "postgresql" });
  assert.deepEqual(describeEstimatedPlanDiffSupport(my), { supported: true, reasonCode: null, database: "mysql" });
  assert.equal(describeEstimatedPlanDiffSupport(null).reasonCode, "INVALID_ANALYSIS");
  assert.equal(describeEstimatedPlanDiffSupport({ status: "loading" }).reasonCode, "ANALYSIS_NOT_READY");
  assert.equal(describeEstimatedPlanDiffSupport({ status: "structured", analysis: { normalized: {} } }).reasonCode, "INVALID_NORMALIZED_PLAN");

  const textPlan = session(scan("0", "orders"), { format: "text", version: "16", sql: "SELECT 1" });
  assert.equal(describeEstimatedPlanDiffSupport(textPlan).reasonCode, "UNSUPPORTED_FORMAT");
});

test("the report exposes no performance claims and keeps unknown/missing values explicit", () => {
  const result = report(
    session(scan("0", "orders", { estimatedRows: 100, totalCost: 10 }), { version: "16", sql: "SELECT 1" }),
    session(scan("0", "orders", { estimatedRows: 200, totalCost: 20 }), { version: "16", sql: "SELECT 1" }),
  );
  const serialized = JSON.stringify(result);
  for (const forbidden of ["speedup", "improvement", "percentChange", "performanceScore", "faster"]) {
    assert.equal(serialized.includes(forbidden), false, `report contains no ${forbidden}`);
  }
  assert.equal(result.comparability.cost.status, "available");
  assert.equal(result.comparability.cost.baseline, 10);
  assert.equal(result.comparability.cost.current, 20);
  assert.equal(result.summary.changed, 1);
  assert.equal(result.sides.baseline.title, null);
  assert.equal(result.sides.baseline.databaseVersion, "16");
  assert.equal(result.sides.baseline.sql, "SELECT 1");
});

test("report metadata carries snapshot titles/times on each side without reading any store", () => {
  const plan = scan("0", "orders");
  const result = report(
    session(plan, { version: "16", sql: "SELECT 1", capturedAt: "2026-10-01T10:00:00.000Z" }),
    session(plan, { version: "16", sql: "SELECT 1" }),
    {
      baselineMeta: { kind: "snapshot", id: "snap-a", title: "Before index", savedAt: "2026-10-02T10:00:00.000Z", producerVersion: "0.9.0" },
      currentMeta: { kind: "current" },
    },
  );
  assert.equal(result.sides.baseline.kind, "snapshot");
  assert.equal(result.sides.baseline.id, "snap-a");
  assert.equal(result.sides.baseline.title, "Before index");
  assert.equal(result.sides.baseline.savedAt, "2026-10-02T10:00:00.000Z");
  assert.equal(result.sides.baseline.capturedAt, "2026-10-01T10:00:00.000Z");
  assert.equal(result.sides.baseline.producerVersion, "0.9.0");
  assert.equal(result.sides.current.kind, "current");
  assert.equal(result.sides.current.title, null);
});
