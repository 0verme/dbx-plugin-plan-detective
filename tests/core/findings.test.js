import assert from "node:assert/strict";
import test from "node:test";
import { createFinding, nodeEvidence, SEVERITIES } from "../../src/core/findings/finding.js";
import { normalizedNode } from "../helpers/plan-builders.js";

test("SEVERITIES is the small, stable ladder info / warning / high", () => {
  assert.deepEqual([...SEVERITIES], ["info", "warning", "high"]);
});

test("nodeEvidence carries the mandatory evidence base", () => {
  const node = normalizedNode({
    id: "0.1",
    nodeType: "Seq Scan",
    relation: { name: "pd_fix_events", alias: "e", indexName: null },
    estimatedRows: 14093,
    totalCost: 3997,
  });

  assert.deepEqual(nodeEvidence(node), {
    nodeId: "0.1",
    nodeType: "Seq Scan",
    relation: "pd_fix_events",
    estimatedRows: 14093,
    estimatedTotalCost: 3997,
  });

  const extended = nodeEvidence(node, { incrementalCost: 100 });
  assert.equal(extended.incrementalCost, 100);
  assert.equal(extended.nodeId, "0.1");
});

test("createFinding builds a deterministic finding id from ruleId and nodeRef", () => {
  const node = normalizedNode({ id: "0.1" });
  const finding = createFinding({
    ruleId: "large-sequential-scan",
    severity: "warning",
    title: "Large sequential scan",
    summary: "example summary",
    node,
    evidence: nodeEvidence(node),
  });

  assert.deepEqual(Object.keys(finding), ["id", "ruleId", "severity", "title", "summary", "nodeRef", "evidence"]);
  assert.equal(finding.id, "large-sequential-scan:0.1");
  assert.equal(finding.nodeRef, "0.1");

  const again = createFinding({
    ruleId: "large-sequential-scan",
    severity: "warning",
    title: "Large sequential scan",
    summary: "example summary",
    node,
    evidence: nodeEvidence(node),
  });
  assert.deepEqual(finding, again);
});

test("createFinding accepts every severity in the ladder", () => {
  for (const severity of SEVERITIES) {
    const node = normalizedNode();
    const finding = createFinding({ ruleId: "r", severity, title: "t", summary: "s", node, evidence: {} });
    assert.equal(finding.severity, severity);
  }
});

test("createFinding rejects invalid input instead of producing a half-valid finding", () => {
  const node = normalizedNode();
  const valid = { ruleId: "rule", severity: "warning", title: "title", summary: "summary", node, evidence: {} };

  assert.throws(() => createFinding({ ...valid, ruleId: "" }), TypeError);
  assert.throws(() => createFinding({ ...valid, severity: "critical" }), /severity/);
  assert.throws(() => createFinding({ ...valid, title: "" }), TypeError);
  assert.throws(() => createFinding({ ...valid, summary: "" }), TypeError);
  assert.throws(() => createFinding({ ...valid, node: null }), TypeError);
  assert.throws(() => createFinding({ ...valid, node: { id: "" } }), TypeError);
  assert.throws(() => createFinding({ ...valid, evidence: null }), TypeError);
  assert.throws(() => createFinding({ ...valid, evidence: [] }), TypeError);
});
