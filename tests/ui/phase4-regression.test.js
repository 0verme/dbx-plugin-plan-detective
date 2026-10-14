import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { handleAnalyzeShortcut } from "../../src/lib/sql-input-shortcut.js";

const component = (name) => readFile(new URL(`../../src/components/${name}.svelte`, import.meta.url), "utf8");
const [app, layout, tree, findings, hotspots, connection, sqlInput, notice, rawPlan] = await Promise.all([
  readFile(new URL("../../src/App.svelte", import.meta.url), "utf8"),
  component("PlanAnalysisLayout"),
  component("PlanTree"),
  component("FindingsList"),
  component("HotspotsList"),
  component("ConnectionContext"),
  component("SqlInput"),
  component("AnalysisNotice"),
  component("RawPlanViewer"),
]);

function keyboardEvent(overrides = {}) {
  let prevented = false;
  return {
    event: {
      key: "Enter",
      metaKey: false,
      ctrlKey: false,
      preventDefault() {
        prevented = true;
      },
      ...overrides,
    },
    wasPrevented: () => prevented,
  };
}

test("Cmd/Ctrl+Enter analyzes only when the SQL input is ready", () => {
  for (const modifier of ["metaKey", "ctrlKey"]) {
    const { event, wasPrevented } = keyboardEvent({ [modifier]: true });
    let calls = 0;

    assert.equal(handleAnalyzeShortcut(event, { onAnalyze: () => calls++ }), true);
    assert.equal(wasPrevented(), true);
    assert.equal(calls, 1);
  }

  for (const state of [{ disabled: true }, { loading: true }]) {
    const { event, wasPrevented } = keyboardEvent({ ctrlKey: true });
    let calls = 0;

    assert.equal(handleAnalyzeShortcut(event, { ...state, onAnalyze: () => calls++ }), true);
    assert.equal(wasPrevented(), true, "a recognized shortcut never inserts a newline");
    assert.equal(calls, 0);
  }

  for (const eventOverrides of [{}, { ctrlKey: true, key: "a" }]) {
    const { event, wasPrevented } = keyboardEvent(eventOverrides);
    let calls = 0;

    assert.equal(handleAnalyzeShortcut(event, { onAnalyze: () => calls++ }), false);
    assert.equal(wasPrevented(), false);
    assert.equal(calls, 0);
  }

  assert.match(sqlInput, /onkeydown=\{handleKeydown\}/);
  assert.match(sqlInput, /handleAnalyzeShortcut\(event, \{ disabled, loading, onAnalyze \}\)/);
  assert.match(app, /<SqlInput[\s\S]*?onAnalyze=\{analyze\}/);
});

test("Tree, Inspector, Findings, and Hotspots stay connected through one selected-node path", () => {
  assert.match(app, /const inspector = \$derived\(activeAnalysis \? buildNodeInspector\(nodesById\.get\(selectedNodeId\), locale\) : null\)/);
  assert.match(app, /function selectNode\(nodeId\) \{[\s\S]*?collapsedIds = expandAncestors\(collapsedIds, rowsById\.get\(nodeId\)\);[\s\S]*?selectedNodeId = nodeId;/);
  assert.match(layout, /selectedId=\{selectedNodeId\}[\s\S]*?onSelect=\{onSelectNode\}/);
  assert.match(layout, /<NodeInspector \{locale\} inspector=\{inspector\} nodeFindings=\{selectedNodeFindings\}/);
  assert.match(layout, /selectedNodeRef=\{selectedNodeId\} onSelectNode=\{onSelectNode\}/);
  assert.match(layout, /selectedNodeId=\{selectedNodeId\} onSelectNode=\{onSelectNode\}/);
  assert.match(tree, /onclick=\{\(\) => onSelect\(row\.id\)\}/);
  assert.match(findings, /onclick=\{\(\) => onSelectNode\(view\.nodeRef\)\}/);
  assert.match(hotspots, /onclick=\{\(\) => onSelectNode\(item\.nodeId\)\}/);
});

test("Host refresh, Raw Plan, and prompt-copy controls remain wired to existing local actions", () => {
  assert.match(app, /<ConnectionContext[\s\S]*?onRefresh=\{refreshCapabilities\}/);
  assert.match(app, /if \(contextView\.connectionId !== null\) refreshCapabilities\(\)/);
  assert.match(app, /loadPlanCapabilities\(\{ bridge, connectionId \}\)/);
  assert.match(connection, /aria-label=\{t\("connection\.refresh"\)\}[\s\S]*?onclick=\{onRefresh\}/);

  assert.match(app, /formatRawPlan\(displaySession\.hostResult\)/);
  assert.match(app, /<RawPlanViewer \{locale\} hostResult=\{displaySession\.hostResult \?\? null\} preview=\{rawPlanPreview\} warningLabels=\{rawPlanWarnings\}/);
  assert.match(rawPlan, /<details>\s*<summary>\{t\("raw\.view"/);
  assert.doesNotMatch(rawPlan, /<details\s+open>/);

  assert.match(app, /displaySession\.status === "structured" \? \{ \.\.\.describeCopyPromptAction\(copyState, locale\), onCopy: copyAiAnalysisPrompt \}/);
  assert.match(app, /buildAiAnalysisPrompt\(\{/);
  assert.match(app, /copyTextToClipboard\(\{ bridge, text: prompt \}\)/);
  assert.match(notice, /onclick=\{copyPrompt\.onCopy\}/);
});
