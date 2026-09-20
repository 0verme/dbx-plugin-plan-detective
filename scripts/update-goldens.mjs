#!/usr/bin/env node
/**
 * Regenerate the golden files under fixtures/<database>/golden/ from the current
 * offline pipeline.
 *
 * Each golden file pins the full pipeline for one fixture:
 *
 *     raw plan -> parsed -> normalized -> metrics -> findings -> hotspots
 *
 * Run this only when a pipeline change is intentional, then review the diff
 * before committing:
 *
 *     npm run test:update-goldens
 *
 * `npm test` compares the pipeline output against these files and fails when
 * they are stale.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzePlan } from "../src/core/analyze.js";
import { FIXTURE_DATABASES, goldenPathFor, listFixtures, loadFixture, relativeToRepo } from "../tests/helpers/fixtures.js";

const fixtures = [];
for (const database of FIXTURE_DATABASES) {
  for (const fixture of await listFixtures(database)) {
    fixtures.push(await loadFixture(fixture));
  }
}

let updated = 0;
for (const fixture of fixtures) {
  const analysis = analyzePlan(fixture.input);
  const golden = {
    parsed: analysis.parsed,
    normalized: analysis.normalized,
    metrics: analysis.metrics,
    findings: analysis.findings,
    hotspots: analysis.hotspots,
  };
  const next = `${JSON.stringify(golden, null, 2)}\n`;
  const file = goldenPathFor(fixture.mode, fixture.name, fixture.database);

  let previous = null;
  try {
    previous = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (previous === next) {
    console.log(`unchanged ${relativeToRepo(file)}`);
    continue;
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next, "utf8");
  updated += 1;
  console.log(`${previous === null ? "created" : "updated"} ${relativeToRepo(file)}`);
}

console.log(`\n${updated} golden file(s) written, ${fixtures.length - updated} unchanged.`);
