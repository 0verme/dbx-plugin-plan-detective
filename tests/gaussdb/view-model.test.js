import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRawPlan } from "../../src/core/parsers/index.js";
import { buildNodeInspector, buildTreeRows, describeHotspotCost } from "../../src/lib/view-model.js";
import { loadFixture } from "../helpers/fixtures.js";

const fixture = await loadFixture({ database: "gaussdb", mode: "estimated", name: "distributed-operators.synthetic" });
const analysis = analyzeRawPlan(fixture.input);

test("GaussDB plan tree displays native cost beside estimated rows", () => {
  const rows = buildTreeRows(analysis.normalized.root);
  assert.equal(rows[0].estimatedRows, 8);
  assert.equal(rows[0].totalCost, 28.4);
  assert.equal(rows[0].costLabel, "tree.gaussdbCost");
  const scan = rows.find((row) => row.nodeType === "Seq Scan");
  assert.equal(scan.estimatedRows, 8);
  assert.equal(scan.totalCost, 9.2);
  assert.equal(scan.costLabel, "tree.gaussdbCost");
});

test("GaussDB inspector shows localized native cost and plan-width estimates", () => {
  const chinese = buildNodeInspector(analysis.normalized.root, "zh-CN");
  const english = buildNodeInspector(analysis.normalized.root, "en");
  const chineseFields = chinese.groups.flatMap((group) => group.fields);
  const englishFields = english.groups.flatMap((group) => group.fields);

  assert.ok(chineseFields.some((field) => field.label === "DWS 总成本" && field.value === "28.4"));
  assert.ok(chineseFields.some((field) => field.label === "计划宽度" && field.value === "32"));
  assert.ok(englishFields.some((field) => field.label === "DWS Total Cost" && field.value === "28.4"));
  assert.ok(englishFields.some((field) => field.label === "Plan Width" && field.value === "32"));
  assert.match(describeHotspotCost(analysis.hotspots.cost, "zh-CN"), /成本模型未在此处按 PostgreSQL 语义归因/);
  assert.match(describeHotspotCost(analysis.hotspots.cost, "en"), /is not attributed with PostgreSQL semantics/);
});

test("Streaming type and unknown native properties remain inspectable", () => {
  const streaming = analysis.normalized.root.children[0];
  const inspector = buildNodeInspector(streaming, "en");
  const fields = inspector.groups.flatMap((group) => group.fields);
  assert.ok(fields.some((field) => field.label === "DWS Streaming Type" && field.value === "GATHER"));

  const unknown = analysis.normalized.root.children[1].children[0].children[0].children[0].children[1];
  const unknownInspector = buildNodeInspector(unknown, "en");
  assert.ok(unknownInspector.groups.flatMap((group) => group.fields).some((field) => field.label === "Synthetic Attribute"));
});
