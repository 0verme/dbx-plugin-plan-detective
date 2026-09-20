#!/usr/bin/env node
/**
 * Development-only fixture runner.
 *
 * Runs the offline pipeline against one committed fixture and prints the
 * result. It reads files only: no database, no host bridge, no network.
 *
 *     node scripts/analyze-fixture.mjs estimated/seq-scan
 *     node scripts/analyze-fixture.mjs actual/estimate-mismatch --json
 *     node scripts/analyze-fixture.mjs --list
 */
import { analyzePlan } from "../src/core/analyze.js";
import { listFixtures, loadFixture } from "../tests/helpers/fixtures.js";

const args = process.argv.slice(2);

if (args.includes("--list") || args.length === 0) {
  const fixtures = await listFixtures();
  for (const fixture of fixtures) {
    console.log(`${fixture.mode}/${fixture.name}`);
  }
  if (args.length === 0) {
    console.log("\nUsage: node scripts/analyze-fixture.mjs <mode>/<name> [--json]");
    process.exitCode = 1;
  }
} else {
  const target = args.find((arg) => !arg.startsWith("--"));
  const [mode, name] = (target ?? "").split("/");
  if (!mode || !name) {
    console.error(`Expected <mode>/<name>, got ${JSON.stringify(target)}. Use --list to see fixtures.`);
    process.exitCode = 1;
  } else {
    const fixture = await loadFixture({ mode, name });
    const analysis = analyzePlan(fixture.input);

    if (args.includes("--json")) {
      console.log(JSON.stringify(analysis, null, 2));
    } else {
      console.log(`fixture: ${mode}/${name} (${fixture.meta.source.kind})`);
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
