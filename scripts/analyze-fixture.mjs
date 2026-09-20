#!/usr/bin/env node
/**
 * Development-only fixture runner.
 *
 * Runs the offline pipeline against one committed fixture and prints the
 * result. It reads files only: no database, no host bridge, no network.
 *
 *     node scripts/analyze-fixture.mjs estimated/seq-scan
 *     node scripts/analyze-fixture.mjs mysql/estimated/table-scan.synthetic
 *     node scripts/analyze-fixture.mjs actual/estimate-mismatch --json
 *     node scripts/analyze-fixture.mjs --list
 *
 * A `<database>/<mode>/<name>` target selects the fixture root; a
 * `<mode>/<name>` target defaults to `postgresql`.
 */
import { analyzePlan } from "../src/core/analyze.js";
import { FIXTURE_DATABASES, listFixtures, loadFixture } from "../tests/helpers/fixtures.js";

const args = process.argv.slice(2);

if (args.includes("--list") || args.length === 0) {
  for (const database of FIXTURE_DATABASES) {
    for (const fixture of await listFixtures(database)) {
      console.log(`${database}/${fixture.mode}/${fixture.name}`);
    }
  }
  if (args.length === 0) {
    console.log("\nUsage: node scripts/analyze-fixture.mjs [<database>/]<mode>/<name> [--json]");
    process.exitCode = 1;
  }
} else {
  const target = args.find((arg) => !arg.startsWith("--"));
  const parts = (target ?? "").split("/");
  const [database, mode, name] = parts.length === 3 ? parts : ["postgresql", ...parts];
  if (!database || !mode || !name || parts.length < 2 || parts.length > 3) {
    console.error(`Expected [<database>/]<mode>/<name>, got ${JSON.stringify(target)}. Use --list to see fixtures.`);
    process.exitCode = 1;
  } else {
    const fixture = await loadFixture({ database, mode, name });
    const analysis = analyzePlan(fixture.input);

    if (args.includes("--json")) {
      console.log(JSON.stringify(analysis, null, 2));
    } else {
      console.log(`fixture: ${database}/${mode}/${name} (${fixture.meta.source.kind})`);
      console.log(`sql: ${fixture.meta.sql ?? "-"}`);
      console.log(`nodes: ${analysis.metrics.nodeCount}, depth: ${analysis.metrics.maxDepth}`);
      console.log(`findings: ${analysis.findings.length}`);
      for (const finding of analysis.findings) {
        console.log(`  [${finding.severity}] ${finding.id} — ${finding.title}`);
        console.log(`    ${finding.summary}`);
      }
    }
  }
}
