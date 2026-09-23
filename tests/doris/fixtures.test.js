import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { analyzePlan } from "../../src/core/analyze.js";
import { flattenNodes, flattenOperatorNodes } from "../../src/core/tree.js";
import { MODES_BY_DATABASE, goldenPathFor, loadAllFixtures, relativeToRepo } from "../helpers/fixtures.js";

const fixtures = await loadAllFixtures("doris");
const STAGES = ["parsed", "normalized", "metrics", "findings", "hotspots"];

test("Doris fixtures are Estimated-only text and distinguish docs from synthetic provenance", () => {
  assert.equal(fixtures.length, 5);
  assert.deepEqual(MODES_BY_DATABASE.doris, ["estimated"]);
  assert.equal(fixtures.every((fixture) => fixture.meta.format === "text" && typeof fixture.plan === "string"), true);
  assert.equal(fixtures.filter((fixture) => fixture.meta.source.kind === "official").length, 1);
  assert.equal(fixtures.filter((fixture) => fixture.meta.source.kind === "synthetic").length, 4);
  assert.equal(fixtures.some((fixture) => fixture.mode === "actual"), false);

  const documentation = fixtures.find((fixture) => fixture.meta.source.kind === "official");
  assert.deepEqual(
    [documentation.meta.databaseVersion, documentation.meta.capturedAt, documentation.meta.captureCommand, documentation.meta.sql],
    [null, null, null, null],
    "a documentation transcription must not claim a database capture",
  );
  assert.match(documentation.meta.source.detail, /not a local database capture/i);
});

for (const stage of STAGES) {
  test(`Doris golden stage "${stage}" matches every fixture`, async (t) => {
    for (const fixture of fixtures) {
      await t.test(fixture.name, async () => {
        const file = goldenPathFor(fixture.mode, fixture.name, "doris");
        const golden = JSON.parse(await readFile(file, "utf8"));
        const analysis = analyzePlan(fixture.input);
        assert.deepEqual(
          analysis[stage],
          golden[stage],
          `${relativeToRepo(file)} is stale for stage "${stage}"; review the intended change before updating goldens`,
        );
      });
    }
  });
}

test("Doris golden files mirror every fixture and pin the five analysis stages", async () => {
  const expected = fixtures.map((fixture) => `${fixture.name}.json`).sort();
  const actual = (await readdir(new URL("../../fixtures/doris/golden/estimated/", import.meta.url)))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  assert.deepEqual(actual, expected);
  for (const fixture of fixtures) {
    const golden = JSON.parse(await readFile(goldenPathFor(fixture.mode, fixture.name, "doris"), "utf8"));
    assert.deepEqual(Object.keys(golden).sort(), [...STAGES].sort());
  }
});

test("Doris values stay estimated, operator metrics exclude containers and native costs are not inferred", () => {
  for (const fixture of fixtures) {
    const analysis = analyzePlan(fixture.input);
    assert.equal(analysis.parsed.database, "doris");
    assert.equal(analysis.parsed.mode, "estimated");
    assert.equal(analysis.parsed.format, "text");
    assert.equal(analysis.normalized.root.nodeType, fixture.meta.expect.rootNodeType);
    assert.ok(analysis.metrics.maxDepth >= fixture.meta.expect.minDepth, fixture.name);
    assert.equal(analysis.metrics.nodeCount, flattenOperatorNodes(analysis.normalized.root).length, fixture.name);
    assert.equal(analysis.metrics.costAttribution.status, "not-applicable");
    assert.equal(analysis.metrics.costAttribution.engine, "doris");
    assert.equal(analysis.metrics.totalEstimatedCost, null);
    assert.equal(analysis.metrics.rootEstimatedRows, null);
    assert.equal(analysis.metrics.highestIncrementalCost, null);
    assert.deepEqual(analysis.findings.map((finding) => finding.ruleId), fixture.meta.expect.findingRuleIds);

    assert.equal(analysis.normalized.root.kind, "structural");
    assert.equal(analysis.normalized.root.engineSpecific.structural, true);
    for (const node of flattenNodes(analysis.normalized.root)) {
      assert.equal(node.actualRows, null);
      assert.equal(node.actualTotalTime, null);
      assert.equal(node.loops, null);
      assert.equal(node.startupCost, null);
      assert.equal(node.totalCost, null);
      assert.equal(node.width, null);
      assert.equal(node.engineSpecific.database, "doris");
      assert.equal(typeof node.engineSpecific.doris, "object");
    }
    assert.deepEqual(
      [...new Set(analysis.findings.map((finding) => finding.ruleId))].sort(),
      [...fixture.meta.expect.findingRuleIds].sort(),
    );
  }
});

test("official multi-fragment sample keeps SINK / Exchange links as metadata and restores child order", () => {
  const analysis = analyzePlan(fixtures.find((fixture) => fixture.name === "distributed-hash-join").input);
  const { parsed, normalized } = analysis;
  assert.equal(parsed.fragments.length, 4);
  assert.equal(parsed.fragments[2].root, null, "official excerpt preserves fragments whose operator rows are not shown");
  assert.equal(parsed.fragments[3].root, null, "abridged source is not silently expanded into invented operators");
  assert.deepEqual(parsed.fragments[0].outputExpressions, ["cnt[#10]", "cnt[#11]"]);
  assert.equal(parsed.fragments[0].hasColoPlanNode, false);
  assert.equal(parsed.fragments[0].sink.type, "VRESULT SINK");
  assert.equal(parsed.fragments[1].sink.type, "STREAM DATA SINK");
  assert.equal(parsed.fragments[1].sink.exchangeId, "07");
  assert.equal(parsed.fragments[1].sink.distribution, "UNPARTITIONED");
  assert.deepEqual(parsed.fragments[1].root.children.map((node) => node.operationId), ["5", "4"]);
  assert.deepEqual(parsed.exchangeEdges, [
    {
      fromFragment: "1",
      exchangeId: "07",
      distribution: "UNPARTITIONED",
      sinkType: "STREAM DATA SINK",
      targetExchangeNode: { fragmentId: "0", operationId: "7" },
      resolution: "matched",
      candidates: [{ fragmentId: "0", operationId: "7" }],
    },
  ]);
  assert.deepEqual(normalized.root.children[1].children[0].children.map((node) => node.engineSpecific.doris.operationId), ["5", "4"]);
  assert.equal(flattenOperatorNodes(normalized.root).some((node) => node.kind === "structural"), false);
  assert.equal(analysis.metrics.nodeCount, 4);
  assert.equal(analysis.metrics.maxDepth, 2);
});

test("Doris operator and property mappings are conservative and preserve forward fields", () => {
  const operatorFixture = fixtures.find((fixture) => fixture.name === "operator-mapping.synthetic");
  const operatorAnalysis = analyzePlan(operatorFixture.input);
  const [sort] = operatorAnalysis.normalized.root.children[0].children;
  assert.equal(sort.kind, "sort");
  assert.equal(sort.sortKeys[0], "amount DESC");
  assert.equal(sort.children[0].kind, "aggregate");
  assert.equal(sort.children[0].groupKeys[0], "customer_id");
  assert.equal(sort.children[0].children[0].kind, "filter");
  assert.equal(sort.children[0].children[0].filter, "amount > 0");
  assert.equal(sort.children[0].children[0].children[0].kind, "scan");
  assert.equal(sort.children[0].children[0].children[0].relation.name, "sales.orders");
  assert.equal(sort.children[0].children[0].children[0].estimatedRows, 1200);
  assert.equal(operatorAnalysis.metrics.sequentialScanCount, 0, "neutral scan mapping must not trigger sequential-scan rules");

  const unknownAnalysis = analyzePlan(fixtures.find((fixture) => fixture.name === "unknown-properties.synthetic").input);
  const scan = unknownAnalysis.normalized.root.children[0].children[0];
  assert.equal(scan.kind, "scan");
  assert.equal(scan.estimatedRows, null);
  assert.equal(scan.width, null);
  assert.equal(scan.engineSpecific.doris.avgRowSize, "40.5");
  assert.equal(scan.engineSpecific.doris.numNodes, 3);
  assert.ok(scan.engineSpecific.doris.properties.some((property) => property.name === "future optimizer flag"));
  assert.ok(scan.engineSpecific.doris.rawLines.some((line) => line.includes("unclassified detail")));
  assert.deepEqual(unknownAnalysis.normalized.unknownNodeTypes, []);
});

test("invalid negative Doris cardinality stays engine-specific and is not promoted to estimatedRows", () => {
  const analysis = analyzePlan({
    database: "doris",
    mode: "estimated",
    format: "text",
    plan: "PLAN FRAGMENT 0\n1:VOlapScanNode\nTABLE: db.orders\ncardinality: -1",
  });
  const scan = analysis.normalized.root.children[0].children[0];
  assert.equal(scan.estimatedRows, null);
  assert.equal(scan.engineSpecific.doris.cardinality, "-1");
});

test("Doris exchange matching is metadata-only and unresolved / ambiguous edges are preserved", () => {
  const fixture = fixtures.find((entry) => entry.name === "exchange-link.synthetic");
  const analysis = analyzePlan(fixture.input);
  assert.equal(analysis.parsed.exchangeEdges[0].resolution, "matched");
  assert.equal(analysis.parsed.exchangeEdges[0].targetExchangeNode.operationId, "7");
  assert.equal(analysis.parsed.fragments[1].root.children.length, 2);
  assert.equal(analysis.metrics.nodeCount, 4, "the cross-fragment link must not become a child edge");

  const raw = `PLAN FRAGMENT 0\n7:VEXCHANGE\nPLAN FRAGMENT 1\nSTREAM DATA SINK\nEXCHANGE ID: 99\nRANDOM\n1:SELECT`;
  const unmatched = analyzePlan({ database: "doris", mode: "estimated", format: "text", plan: raw });
  assert.equal(unmatched.parsed.exchangeEdges[0].resolution, "unmatched");
  assert.equal(unmatched.parsed.exchangeEdges[0].targetExchangeNode, null);

  const ambiguous = analyzePlan({
    database: "doris",
    mode: "estimated",
    format: "text",
    plan: `PLAN FRAGMENT 0\n7:VEXCHANGE\nPLAN FRAGMENT 2\n7:VEXCHANGE\nPLAN FRAGMENT 1\nSTREAM DATA SINK\nEXCHANGE ID: 7\nRANDOM\n1:SELECT`,
  });
  assert.equal(ambiguous.parsed.exchangeEdges[0].resolution, "ambiguous");
  assert.deepEqual(ambiguous.parsed.exchangeEdges[0].candidates.map((candidate) => candidate.fragmentId), ["0", "2"]);
});

test("Doris results are deterministic and JSON serializable", () => {
  for (const fixture of fixtures) {
    const first = analyzePlan(fixture.input);
    assert.deepEqual(analyzePlan(fixture.input), first, fixture.name);
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first, fixture.name);
  }
});
