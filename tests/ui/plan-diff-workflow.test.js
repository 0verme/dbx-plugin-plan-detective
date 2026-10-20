import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MESSAGE_CATALOG } from "../../src/lib/i18n/messages.js";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const [app, manager, view, tree, report, diffCore, viewHelpers] = await Promise.all([
  read("src/App.svelte"),
  read("src/components/SnapshotManager.svelte"),
  read("src/components/PlanDiffView.svelte"),
  read("src/components/PlanTree.svelte"),
  read("src/core/diff/plan-diff-report.js"),
  read("src/core/diff/estimated-plan-diff.js"),
  read("src/lib/plan-diff-view.js"),
]);

test("baseline selection and compare entry points are wired through the snapshot toolbar", () => {
  assert.match(manager, /import \{ describeEstimatedPlanDiffSupport \} from "\.\.\/core\/diff\/estimated-plan-diff\.js"/);
  assert.match(manager, /const currentDiffSupport = \$derived\(describeEstimatedPlanDiffSupport\(currentSession\)\)/);
  assert.match(manager, /baselineSnapshotId = null/);
  assert.match(manager, /onSelectBaseline\(snapshot === null \|\| baselineSnapshotId === snapshot\.snapshotId \? null : snapshot\)/);
  assert.match(manager, /onCompareSnapshots\(\{ baseline: baselineSnapshot, current: snapshot \}\)/);
  assert.match(manager, /onCompareCurrent\(\{ baseline: baselineSnapshot, current: currentSession \}\)/);
  assert.match(manager, /if \(baselineSnapshot === null \|\| currentSession === null \|\| saving \|\| savingRename \|\| !currentDiffSupport\.supported\) return;/);
  assert.match(manager, /class="snapshot-baseline-bar"/);
  assert.match(manager, /snapshot\.baseline\.clearBar/);
  assert.match(manager, /snapshot\.compare\.same/);
  assert.match(manager, /snapshot\.compare\.unsupported/);

  assert.match(app, /let baselineSnapshot = \$state\(null\)/);
  assert.match(app, /let diffState = \$state\(null\)/);
  assert.match(app, /function startDiff\(\{ baseline = null, current = null \} = \{\}\) \{/);
  assert.match(app, /createPlanSnapshotView\(baseline\)/);
  assert.match(app, /function swapDiff\(\)/);
  assert.match(app, /function exitDiff\(\)[\s\S]*?diffState = null/);
  assert.match(app, /onSelectBaseline=\{selectBaseline\}/);
  assert.match(app, /onCompareSnapshots=\{startDiff\}/);
  assert.match(app, /onCompareCurrent=\{startDiff\}/);
});

test("comparison is a view state and never replaces analysis, reruns SQL, or writes Storage", () => {
  const startDiff = app.match(/function startDiff\(\{[\s\S]*?\n  \}/)?.[0];
  assert.ok(startDiff, "startDiff exists");
  assert.doesNotMatch(startDiff, /session =|activeSnapshot =|repository\.|storage|analyze\(/);
  assert.match(startDiff, /diffState = \{/, "comparison state is separate from the active analysis");

  assert.match(app, /function exitDiff\(\)[\s\S]*?diffState = null/);
  assert.match(app, /diffState = null;[\s\S]*?selectedNodeId = "0"/);
  assert.match(app, /const displaySession = \$derived\(activeSnapshot\?\.session \?\? session\)/);
  // Diff rendering is its own branch before the normal analysis layouts.
  const diffBranch = app.indexOf("{#if diffState !== null}");
  const activeBranch = app.indexOf("{:else if activeSnapshot !== null}");
  assert.ok(diffBranch >= 0 && activeBranch > diffBranch, "diff is rendered as a separate view");

  for (const path of [report, diffCore, viewHelpers]) {
    assert.doesNotMatch(path, /from "\.\.\/\.\.\/host|from "\.\.\/host|window\.|localStorage|indexedDB/);
  }
});

test("the diff view renders both plans, structural changes, and honest unknown/withheld states", () => {
  assert.match(view, /<PlanTree[\s\S]*diffMarks=\{marks\.baseline\}/);
  assert.match(view, /<PlanTree[\s\S]*diffMarks=\{marks\.current\}/);
  assert.match(view, /buildTreeRows\(baselineAnalysis\.normalized\.root\)/);
  assert.match(view, /buildTreeRows\(currentAnalysis\.normalized\.root\)/);
  assert.match(view, /diff\.summary\.matched/);
  assert.match(view, /diff\.comparability\.limited/);
  assert.match(view, /report\.comparability\.cost\.status === "available"/);
  assert.match(view, /diff\.cost\.withheld/);
  assert.match(view, /diff\.diagnostics\.unavailable/);
  assert.match(view, /diff\.added\.title/);
  assert.match(view, /diff\.removed\.title/);
  assert.match(view, /diff\.unmatched\.title/);
  assert.match(view, /diff\.ambiguous\.title/);
  assert.match(view, /diff\.findings\.unlinked/);
  assert.match(view, /function swapSides\(\)[\s\S]*?focus = null/);
  assert.match(view, /onclick=\{swapSides\}/);
  assert.match(view, /onclick=\{onExit\}/);
  assert.match(tree, /diffMarks = new Map\(\)/);
  assert.match(tree, /DIFF_SYMBOL/);
  assert.match(tree, /tree\.diff\./);
});

test("the report keeps matching evidence, conservative unmatched nodes, and no speed claims", () => {
  assert.match(report, /export function buildEstimatedPlanDiff/);
  assert.match(report, /DIFF_GROUP_ORDER/);
  assert.match(report, /status: "incompatible"/);
  assert.match(report, /COST_MODEL_NOT_DIFFED/);
  assert.match(report, /COST_MISSING/);
  assert.match(report, /unmatched: \{ baseline: \[\], current: \[\] \}/);
  assert.match(report, /ambiguous: \[\]/);
  assert.match(report, /isConfidentOnlySide/);
  assert.match(report, /changedEvidenceFields/);
  assert.match(report, /NODE_LOCATOR_FIELDS/);
  assert.match(report, /locatorChanged\(left\[field\], right\[field\], beforeToAfter\)/);
  assert.match(report, /hotspotChangedFields/);
  assert.match(report, /changedFields: \[\.\.\.new Set\(\[\.\.\.changedFields, \.\.\.hotspotChangedFields\]\)\]\.sort\(\)/);
  assert.doesNotMatch(report, /faster|speedup|speed up|performance gain|optimization advice/i);
  assert.match(diffCore, /export function describeEstimatedPlanDiffSupport/);
  assert.match(diffCore, /export function readPlanAnalysis/);
});

test("all diff and baseline copy exists in both locales", () => {
  for (const locale of ["zh-CN", "en"]) {
    for (const key of [
      "snapshot.baseline.bar",
      "snapshot.baseline.compare",
      "snapshot.baseline.compareActive",
      "snapshot.baseline.clearBar",
      "snapshot.compare.action",
      "snapshot.compare.same",
      "snapshot.compare.unsupported",
      "snapshot.compare.noCurrent",
      "diff.title",
      "diff.swap",
      "diff.exit",
      "diff.summary.matched",
      "diff.summary.changed",
      "diff.summary.unmatched",
      "diff.summary.ambiguous",
      "diff.comparability.limited",
      "diff.cost.withheld",
      "diff.diagnostics.unavailable",
      "tree.diff.changed",
    ]) {
      assert.equal(typeof MESSAGE_CATALOG[locale][key], "string", `${locale} has ${key}`);
      assert.ok(MESSAGE_CATALOG[locale][key].length > 0, `${locale} has non-empty ${key}`);
    }
  }
  assert.match(MESSAGE_CATALOG["zh-CN"]["diff.title"], /Estimated/);
  assert.match(MESSAGE_CATALOG.en["diff.title"], /Estimated/);
});
