/**
 * Fixture catalog for the offline / demo UI.
 *
 * The catalog is the UI-side counterpart of `RawPlanInput`: it describes which
 * committed fixtures exist and what their provenance is, and it hands the
 * already-validated `RawPlanInput` to the existing offline core. It never
 * parses, normalizes or scores a plan itself.
 *
 * The Vite plugin (`scripts/vite-plugin-fixtures.mjs`) builds the catalog at
 * build time from `fixtures/postgres/**`; tests build it from the same loader
 * (`tests/helpers/fixtures.js`), so no fixture content is copied by hand.
 */

import { analyzePlan } from "../core/analyze.js";

/** Fixture picked when the UI opens, when present. Chosen because it triggers
 *  several rules and shows a multi-node tree. */
export const DEFAULT_FIXTURE_ID = "estimated/nested-loop-large-inner";

/** Display order of the two fixture modes. */
export const MODE_ORDER = Object.freeze(["estimated", "actual"]);

/**
 * Map one loaded fixture (shape returned by `tests/helpers/fixtures.js`) to a
 * catalog entry. Only display-relevant fields are copied: absolute paths from
 * the loader must never leak into the UI bundle.
 *
 * @param {{
 *   mode: string, name: string, input: object,
 *   meta: {
 *     database: string, mode: string, format: string, databaseVersion: string|null,
 *     capturedAt: string|null, captureCommand: string|null, sql: string|null,
 *     source: { kind: string, detail: string, reference: string|null },
 *     features: string[], expect: { rootNodeType: string },
 *   },
 * }} loaded
 */
export function toCatalogEntry(loaded) {
  const { meta } = loaded;
  return {
    id: `${loaded.mode}/${loaded.name}`,
    mode: loaded.mode,
    name: loaded.name,
    database: meta.database,
    databaseVersion: meta.databaseVersion,
    sql: meta.sql,
    capturedAt: meta.capturedAt,
    captureCommand: meta.captureCommand,
    rootNodeType: meta.expect.rootNodeType,
    features: [...meta.features],
    provenance: {
      kind: meta.source.kind,
      detail: meta.source.detail,
      reference: meta.source.reference ?? null,
    },
    isSynthetic: meta.source.kind === "synthetic",
    // Already validated by the loader; kept in RawPlanInput shape on purpose so
    // the UI consumes exactly the same contract the future adapter will produce.
    rawInput: loaded.input,
  };
}

/**
 * @param {Array<Parameters<typeof toCatalogEntry>[0]>} loadedFixtures
 * @returns {Array<ReturnType<typeof toCatalogEntry>>} sorted by mode, then name
 */
export function buildFixtureCatalog(loadedFixtures) {
  return loadedFixtures.map(toCatalogEntry).sort(compareCatalogEntries);
}

/** @param {ReturnType<typeof toCatalogEntry>} a @param {ReturnType<typeof toCatalogEntry>} b */
export function compareCatalogEntries(a, b) {
  const modeDelta = MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode);
  if (modeDelta !== 0) return modeDelta;
  return a.name.localeCompare(b.name);
}

/**
 * Filter catalog entries by mode and a free-text query. The query matches the
 * fixture id / name, SQL, root node type and feature strings.
 *
 * @param {ReturnType<typeof buildFixtureCatalog>} catalog
 * @param {{ mode?: string, query?: string }} [filter]
 */
export function filterCatalog(catalog, filter = {}) {
  const mode = filter.mode ?? "all";
  const query = (filter.query ?? "").trim().toLowerCase();

  return catalog.filter((entry) => {
    if (mode !== "all" && entry.mode !== mode) return false;
    if (query.length === 0) return true;
    const haystack = [entry.id, entry.rootNodeType, entry.databaseVersion ?? "", entry.sql ?? "", ...entry.features]
      .join("\n")
      .toLowerCase();
    return haystack.includes(query);
  });
}

/**
 * @param {ReturnType<typeof buildFixtureCatalog>} catalog
 * @param {string|null|undefined} id
 */
export function findCatalogEntry(catalog, id) {
  return catalog.find((entry) => entry.id === id) ?? null;
}

/**
 * Default selection: the curated `DEFAULT_FIXTURE_ID` when committed, otherwise
 * the first catalog entry. Returns `null` for an empty catalog.
 *
 * @param {ReturnType<typeof buildFixtureCatalog>} catalog
 */
export function pickDefaultFixture(catalog) {
  if (catalog.length === 0) return null;
  return findCatalogEntry(catalog, DEFAULT_FIXTURE_ID) ?? catalog[0];
}

/**
 * Run the existing offline pipeline on one catalog entry.
 *
 * This is the only analysis entry point the UI uses:
 *
 *     fixture (RawPlanInput) -> analyzePlan() -> { parsed, normalized, metrics, findings }
 *
 * @param {ReturnType<typeof toCatalogEntry>} entry
 */
export function analyzeFixture(entry) {
  return analyzePlan(entry.rawInput);
}

/**
 * Count per mode for the selector badges.
 *
 * @param {ReturnType<typeof buildFixtureCatalog>} catalog
 */
export function countByMode(catalog) {
  const counts = Object.fromEntries(MODE_ORDER.map((mode) => [mode, 0]));
  for (const entry of catalog) {
    if (entry.mode in counts) counts[entry.mode] += 1;
  }
  return { ...counts, total: catalog.length };
}
