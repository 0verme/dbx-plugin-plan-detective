import assert from "node:assert/strict";
import test from "node:test";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";
import { DB2_PLAN_LIMITS, parseDb2JsonPlan } from "../../src/core/db2/parse-json-plan.js";
import { PlanParseError } from "../../src/core/errors.js";
import { analyzePlan } from "../../src/core/analyze.js";
import { loadFixture } from "../helpers/fixtures.js";

function plan(overrides = {}) {
  return {
    version: 1,
    databaseType: "db2",
    requestTag: "fixed-test-request-tag",
    statement: {},
    operators: [{ id: "1", type: "RETURN" }],
    streams: [],
    predicates: [],
    arguments: [],
    ...overrides,
  };
}

function input(payload, overrides = {}) {
  return createRawPlanInput({ database: "db2", mode: "estimated", format: "json", plan: payload, ...overrides });
}

function assertParseCode(payload, code, overrides = {}) {
  assert.throws(
    () => parseDb2JsonPlan(input(payload, overrides)),
    (error) => error instanceof PlanParseError && error.code === code,
  );
}

test("DB2 parser rejects invalid JSON and unsupported envelope versions", () => {
  assert.throws(
    () => parseDb2JsonPlan(input("{")),
    (error) => error instanceof PlanParseError && error.code === "INVALID_JSON",
  );
  assertParseCode(plan({ version: 2 }), "UNSUPPORTED_VERSION");
  assertParseCode(plan({ version: "1" }), "UNSUPPORTED_VERSION");
  assertParseCode(plan({ databaseType: "postgres" }), "DATABASE_TYPE_MISMATCH");
});

test("DB2 parser is explicitly Estimated JSON only", () => {
  assert.throws(
    () => parseDb2JsonPlan(input(plan(), { mode: "actual" })),
    (error) => error instanceof PlanParseError && error.code === "MODE_MISMATCH",
  );
  assert.throws(
    () => parseDb2JsonPlan(input(plan(), { format: "text" })),
    (error) => error instanceof PlanParseError && error.code === "UNSUPPORTED_FORMAT",
  );
});

test("operator streams build the producer-below-consumer tree and keep multiple roots", () => {
  const parsed = parseDb2JsonPlan(input(plan({
    operators: [{ id: "11", type: "TBSCAN" }, { id: "22", type: "IXSCAN" }, { id: "33", type: "RETURN" }],
    streams: [{ id: "1", sourceType: "O", sourceId: "11", targetType: "O", targetId: "33", rowCount: "4" }],
  })));
  assert.equal(parsed.root.children.length, 2, "disconnected operators remain visible as multiple roots");
  assert.equal(parsed.root.children[0].operatorId, "22");
  assert.equal(parsed.root.children[1].operatorId, "33");
  assert.equal(parsed.root.children[1].children[0].operatorId, "11", "the source producer is the target consumer's child");
});

test("shared operators become a single operator plus structural references, without losing edge metadata", async () => {
  const fixture = await loadFixture({ database: "db2", mode: "estimated", name: "shared-temp-plan" });
  const result = analyzePlan(fixture.input);
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    node.children.forEach(visit);
  }
  visit(result.normalized.root);
  const operatorFour = nodes.filter((node) => node.engineSpecific?.db2?.operatorId === "4");
  const references = nodes.filter((node) => node.engineSpecific?.db2?.referenceTo !== null && node.engineSpecific?.db2?.referenceTo !== undefined);
  assert.equal(operatorFour.length, 1);
  assert.equal(references.length, 1);
  assert.equal(references[0].engineSpecific.db2.structuralType, "reference");
  assert.equal(result.metrics.nodeCount, 6, "the shared operator is counted once");
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.hotspots.items, []);
  assert.ok(result.parsed.root.db2.streams.length > 0, "all original stream rows remain in parsed evidence");
});

test("DB2 stream and predicates map to the expected native operator evidence", async () => {
  const fixture = await loadFixture({ database: "db2", mode: "estimated", name: "index-join-sort-aggregate.synthetic" });
  const result = analyzePlan(fixture.input);
  const nodes = [];
  function visit(node) { nodes.push(node); node.children.forEach(visit); }
  visit(result.normalized.root);
  const byOperator = new Map(nodes.map((node) => [node.engineSpecific?.db2?.operatorId, node]));
  assert.equal(byOperator.get("5").kind, "index_scan");
  assert.equal(byOperator.get("5").relation.indexName, "APP.IDX_CUSTOMER_STATUS");
  assert.equal(byOperator.get("6").kind, "scan", "TBSCAN stays a neutral scan, not a generic full-scan warning trigger");
  assert.equal(byOperator.get("4").kind, "join", "NLJOIN does not assign an outer/inner role");
  assert.equal(byOperator.get("4").children.length, 2);
  assert.equal(byOperator.get("3").kind, "sort");
  assert.equal(byOperator.get("2").kind, "aggregate");
  assert.equal(byOperator.get("4").engineSpecific.db2.predicates[0].howApplied, "JOIN");
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.hotspots.items, []);
});

test("exact decimal costs and output cardinalities remain strings and are not shared costs or scan rows", async () => {
  const fixture = await loadFixture({ database: "db2", mode: "estimated", name: "index-join-sort-aggregate.synthetic" });
  const result = analyzePlan(fixture.input);
  const nodes = [];
  function visit(node) { nodes.push(node); node.children.forEach(visit); }
  visit(result.normalized.root);
  const indexScan = nodes.find((node) => node.engineSpecific?.db2?.operatorId === "5");
  assert.equal(indexScan.engineSpecific.db2.totalCost, "0.0500000000000000000000001");
  assert.equal(indexScan.engineSpecific.db2.ioCost, "0.00000000000000000000000012345678901234567890");
  assert.equal(indexScan.engineSpecific.db2.rowCount, "0.03999999910593033");
  assert.equal(indexScan.estimatedRows, null, "fractional precise stream cardinality is not rounded into the shared number field");
  assert.equal(indexScan.totalCost, null, "timerons are not PostgreSQL-style totalCost");
  assert.equal(result.metrics.totalEstimatedCost, null);
  assert.equal(result.metrics.costAttribution.status, "not-applicable");
  assert.equal(indexScan.actualRows, null);
});

test("invalid operator, stream, predicate references and graph cycles fail closed", () => {
  assertParseCode(plan({ operators: [{ id: "1", type: "RETURN" }, { id: "1", type: "TBSCAN" }] }), "DUPLICATE_OPERATOR_ID");
  assertParseCode(plan({ streams: [{ id: "1", sourceType: "O", sourceId: "404", targetType: "O", targetId: "1" }] }), "DANGLING_REFERENCE");
  assertParseCode(plan({ predicates: [{ operatorId: "404", text: "x=1" }] }), "DANGLING_REFERENCE");
  assertParseCode(plan({ streams: [
    { id: "1", sourceType: "O", sourceId: "1", targetType: "O", targetId: "2" },
    { id: "2", sourceType: "O", sourceId: "2", targetType: "O", targetId: "1" },
  ], operators: [{ id: "1", type: "NLJOIN" }, { id: "2", type: "TBSCAN" }] }), "PLAN_CYCLE");
});

test("DB2 parser enforces operator, depth, display and byte limits", () => {
  const tooManyOperators = Array.from({ length: DB2_PLAN_LIMITS.operators + 1 }, (_, index) => ({ id: String(index), type: "RETURN" }));
  assertParseCode(plan({ operators: tooManyOperators }), "PLAN_TOO_LARGE");

  const deepOperators = Array.from({ length: DB2_PLAN_LIMITS.depth + 1 }, (_, index) => ({ id: String(index), type: "RETURN" }));
  const deepStreams = deepOperators.slice(0, -1).map((operator, index) => ({
    id: String(index), sourceType: "O", sourceId: operator.id, targetType: "O", targetId: String(index + 1),
  }));
  assertParseCode(plan({ operators: deepOperators, streams: deepStreams }), "PLAN_TOO_DEEP");

  const producerCount = 71;
  const producerIds = Array.from({ length: producerCount }, (_, index) => `P${index}`);
  const consumerIds = Array.from({ length: producerCount }, (_, index) => `C${index}`);
  const operators = [...producerIds, ...consumerIds].map((id) => ({ id, type: "RETURN" }));
  let streamId = 0;
  const streams = consumerIds.flatMap((consumerId) => producerIds.map((producerId) => ({
    id: String(streamId++), sourceType: "O", sourceId: producerId, targetType: "O", targetId: consumerId,
  })));
  assertParseCode(plan({ operators, streams }), "PLAN_TOO_LARGE");

  assertParseCode(plan({ futureField: "x".repeat(DB2_PLAN_LIMITS.rawBytes + 1) }), "PLAN_TOO_LARGE");
});
