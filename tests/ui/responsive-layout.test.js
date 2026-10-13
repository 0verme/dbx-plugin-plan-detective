import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const fileUrl = (path) => new URL(`../../${path}`, import.meta.url);
const [app, sharedCss, layout, tree, inspector, findings, hotspots, sqlInput] = await Promise.all([
  "src/App.svelte",
  "src/app.css",
  "src/components/PlanAnalysisLayout.svelte",
  "src/components/PlanTree.svelte",
  "src/components/NodeInspector.svelte",
  "src/components/FindingsList.svelte",
  "src/components/HotspotsList.svelte",
  "src/components/SqlInput.svelte",
].map((path) => readFile(fileUrl(path), "utf8")));

test("analysis and input columns wrap from available content width, not viewport-only breakpoints", () => {
  assert.match(app, /\.input-grid\s*\{\s*display: flex;\s*flex-wrap: wrap;/);
  assert.match(app, /\.connection-workspace\s*\{[^}]*flex: 1 1 280px;/s);
  assert.match(app, /\.sql-workspace\s*\{[^}]*flex: 3 1 620px;/s);
  assert.match(layout, /\.analysis-grid\s*\{\s*display: flex;\s*flex-wrap: wrap;/);
  assert.match(tree, /\.tree-row\s*\{\s*display: flex;\s*flex-wrap: wrap;/);
  assert.match(tree, /max-height: 52vh;[\s\S]*overflow-y: auto;/);
  assert.match(tree, /min\(var\(--depth\), 6\)/, "deep trees cap indentation instead of forcing horizontal overflow");
  assert.doesNotMatch(tree, /@media\s*\(max-width:/, "tree rows adapt to their panel instead of viewport width");
});

test("long SQL, plan fields, evidence, and panel headings can wrap without clipping controls", () => {
  assert.match(sqlInput, /bind:value=\{sql\}/);
  assert.match(sqlInput, /overflow-wrap: anywhere/);
  assert.doesNotMatch(sqlInput, /maxlength=/);
  assert.match(inspector, /grid-template-columns: minmax\(0, 0\.8fr\) minmax\(0, 1\.2fr\)/);
  assert.match(inspector, /\.field dt\s*\{[^}]*overflow-wrap: anywhere/s);
  assert.match(inspector, /\.field dd\s*\{[^}]*overflow-wrap: anywhere/s);
  assert.match(findings, /grid-template-columns: minmax\(0, 0\.9fr\) minmax\(0, 1\.1fr\)/);
  assert.match(hotspots, /grid-template-columns: minmax\(0, 0\.9fr\) minmax\(0, 1\.1fr\)/);
  assert.doesNotMatch(findings, /@media\s*\(max-width:/);
  assert.doesNotMatch(hotspots, /@media\s*\(max-width:/);
  assert.match(sharedCss, /\.panel-head\s*\{[^}]*flex-wrap: wrap/s);
});

test("keyboard focus is visible and tree navigation uses one roving tab stop", () => {
  assert.match(sharedCss, /:where\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible/);
  assert.match(tree, /data-node-id=\{row\.id\}/);
  assert.match(tree, /tabindex=\{row\.id === activeTreeRowId \? 0 : -1\}/);
  assert.match(tree, /tabindex="-1"/);
  assert.match(tree, /treeKeyboardAction\(rows, row\.id, event\.key, collapsed\)/);
  assert.match(tree, /target\?\.scrollIntoView\(\{ block: "nearest" \}\)/);
  assert.match(tree, /target\?\.focus\(\)/);
});

test("switching locale changes presentation only and does not reset SQL or plan navigation state", () => {
  const localeHandler = app.match(/function selectLocale\(nextLocale\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(localeHandler, "locale switch handler exists");
  assert.doesNotMatch(localeHandler, /\b(sqlText|session|selectedNodeId|collapsedIds|selectedFixtureId)\b/);
  assert.match(app, /let sqlText = \$state/);
  assert.match(app, /let selectedNodeId = \$state\("0"\)/);
  assert.match(app, /let collapsedIds = \$state\(new Set\(\)\)/);
});
