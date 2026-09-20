import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FIXTURE_ID,
  analyzeFixture,
  buildFixtureCatalog,
  compareCatalogEntries,
  countByMode,
  filterCatalog,
  findCatalogEntry,
  pickDefaultFixture,
  toCatalogEntry,
} from "../../src/lib/fixture-catalog.js";
import { REPO_ROOT, listFixtures, loadAllFixtures, loadFixture } from "../helpers/fixtures.js";

/**
 * The catalog is the only place the UI learns which fixtures exist. These
 * tests pin what the build-time Vite plugin serializes: display metadata plus
 * the RawPlanInput, and nothing else (no absolute paths, no golden data).
 */

const loadedFixtures = await loadAllFixtures();
const catalog = buildFixtureCatalog(loadedFixtures);

const EXPECTED_ENTRY_KEYS = [
  "captureCommand",
  "capturedAt",
  "database",
  "databaseVersion",
  "features",
  "id",
  "isSynthetic",
  "mode",
  "name",
  "provenance",
  "rawInput",
  "rootNodeType",
  "sql",
];

test("every committed fixture appears exactly once, sorted by mode then name", async () => {
  assert.equal(catalog.length, loadedFixtures.length);
  assert.equal(catalog.length, (await listFixtures()).length);

  const ids = catalog.map((entry) => entry.id);
  assert.deepEqual(ids, [...catalog].sort(compareCatalogEntries).map((entry) => entry.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.every((id, index) => id === `${catalog[index].mode}/${catalog[index].name}`), true);
  assert.deepEqual(countByMode(catalog), { estimated: 16, actual: 4, total: catalog.length });
});

test("catalog entries expose display metadata and RawPlanInput only", () => {
  for (const entry of catalog) {
    assert.deepEqual(Object.keys(entry).sort(), EXPECTED_ENTRY_KEYS, `${entry.id} entry shape`);
    assert.equal(entry.rawInput.database, "postgresql");
    assert.equal(entry.rawInput.mode, entry.mode);
    assert.equal(entry.rawInput.format, "json");
    assert.ok(Object.hasOwn(entry.rawInput, "plan"));
    assert.equal(typeof entry.rootNodeType, "string");
    assert.equal(entry.provenance.kind, entry.isSynthetic ? "synthetic" : "locally-generated");
    assert.deepEqual(Object.keys(entry.provenance).sort(), ["detail", "kind", "reference"]);
  }
});

test("catalog never leaks loader paths or golden data into the UI bundle", () => {
  const serialized = JSON.stringify(catalog);
  assert.equal(serialized.includes(REPO_ROOT), false, "absolute repository path leaked into the catalog");
  assert.equal(serialized.includes("golden"), false, "golden data leaked into the catalog");
  for (const key of ["planPath", "metaPath", "normalized", "\"findings\""]) {
    assert.equal(serialized.includes(key), false, `${key} leaked into the catalog`);
  }
});

test("synthetic fixtures stay explicitly marked as synthetic", () => {
  const synthetic = catalog.filter((entry) => entry.isSynthetic);
  assert.deepEqual(
    synthetic.map((entry) => entry.id).sort(),
    ["estimated/future-properties.synthetic", "estimated/unknown-node.synthetic"],
  );
  for (const entry of synthetic) {
    assert.equal(entry.provenance.kind, "synthetic");
    assert.equal(entry.sql, null);
    assert.equal(entry.databaseVersion, null);
    assert.equal(entry.capturedAt, null);
    assert.equal(entry.captureCommand, null);
    assert.match(entry.id, /\.synthetic$/);
  }
});

test("locally-generated fixtures keep their provenance records", () => {
  for (const entry of catalog.filter((candidate) => !candidate.isSynthetic)) {
    assert.equal(entry.provenance.kind, "locally-generated");
    assert.match(entry.provenance.detail, /locally generated/);
    assert.equal(typeof entry.databaseVersion, "string");
    assert.equal(typeof entry.sql, "string");
    assert.match(entry.capturedAt, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("analyzeFixture runs the same offline pipeline as the tests", async () => {
  const entry = findCatalogEntry(catalog, "estimated/nested-loop-large-inner");
  const analysis = analyzeFixture(entry);
  const fixture = await loadFixture({ mode: "estimated", name: "nested-loop-large-inner" });

  assert.deepEqual(
    analysis.findings.map((finding) => finding.ruleId).sort(),
    [...fixture.meta.expect.findingRuleIds].sort(),
  );
  assert.deepEqual(Object.keys(analysis).sort(), ["findings", "hotspots", "metrics", "normalized", "parsed"]);
});

test("filterCatalog filters by mode and free-text query", () => {
  assert.equal(filterCatalog(catalog, { mode: "estimated" }).length, 16);
  assert.equal(filterCatalog(catalog, { mode: "actual" }).length, 4);
  // A query may match the fixture id, its SQL, its root node type or a feature
  // string, so the assertion pins the definite match rather than an exact set.
  assert.equal(filterCatalog(catalog, { query: "large-seq" }).some((entry) => entry.id === "estimated/large-seq-scan"), true);
  assert.deepEqual(
    filterCatalog(catalog, { query: "unknown-node" }).map((entry) => entry.id),
    ["estimated/unknown-node.synthetic"],
  );
  assert.deepEqual(
    filterCatalog(catalog, { mode: "actual", query: "seq-scan" }).map((entry) => entry.id),
    ["actual/seq-scan"],
  );
  assert.equal(filterCatalog(catalog, { query: "  " }).length, catalog.length);
  assert.equal(filterCatalog(catalog, { query: "does-not-exist" }).length, 0);
});

test("findCatalogEntry and pickDefaultFixture are deterministic", () => {
  assert.equal(findCatalogEntry(catalog, "estimated/seq-scan").name, "seq-scan");
  assert.equal(findCatalogEntry(catalog, "estimated/nope"), null);
  assert.equal(findCatalogEntry(catalog, undefined), null);

  assert.equal(pickDefaultFixture(catalog).id, DEFAULT_FIXTURE_ID);
  assert.equal(pickDefaultFixture([catalog[1]]).id, catalog[1].id);
  assert.equal(pickDefaultFixture([]), null);
});

test("toCatalogEntry reads the loader shape without copying paths", () => {
  const entry = toCatalogEntry(loadedFixtures[0]);
  assert.equal(entry.id, `${loadedFixtures[0].mode}/${loadedFixtures[0].name}`);
  assert.equal(Object.hasOwn(entry, "planPath"), false);
  assert.equal(Object.hasOwn(entry, "metaPath"), false);
  assert.equal(Object.hasOwn(entry, "meta"), false);
  assert.equal(Object.hasOwn(entry, "plan"), false);
  assert.equal(entry.rawInput, loadedFixtures[0].input);
});
