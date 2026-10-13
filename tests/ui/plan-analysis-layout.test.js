import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const layoutUrl = new URL("../../src/components/PlanAnalysisLayout.svelte", import.meta.url);

test("PlanAnalysisLayout keeps the Tree and Inspector adjacent before diagnostics", async () => {
  const source = await readFile(layoutUrl, "utf8");
  const markup = source.split("<style>", 1)[0];
  const summaryIndex = markup.indexOf("<PlanSummary");
  const mainIndex = markup.indexOf('<main class="analysis-column"');
  const planStart = markup.indexOf('<div class="plan-workspace">', mainIndex);
  const diagnosticsStart = markup.indexOf('<div class="diagnostics-grid">', mainIndex);
  const planMarkup = markup.slice(planStart, diagnosticsStart);
  const diagnosticsMarkup = markup.slice(diagnosticsStart, markup.indexOf("</main>", diagnosticsStart));

  assert.ok(summaryIndex >= 0 && summaryIndex < mainIndex, "Summary stays before the core analysis area");
  assert.ok(planStart >= 0 && diagnosticsStart > planStart, "diagnostics follow the plan workspace");
  assert.match(
    planMarkup,
    /<div class="tree-column">\s*<PlanTree[\s\S]*?\/>\s*<\/div>\s*<aside class="inspector-column"[\s\S]*?<NodeInspector[\s\S]*?\/>\s*<\/aside>/,
    "Tree and Inspector occupy neighboring plan-workspace columns",
  );
  assert.match(
    diagnosticsMarkup,
    /<div class="diagnostics-column">\s*<FindingsList[\s\S]*?\/>\s*<\/div>\s*<div class="diagnostics-column">\s*<HotspotsList[\s\S]*?\/>\s*<\/div>/,
    "Findings and Hotspots follow the core plan workspace",
  );
});
