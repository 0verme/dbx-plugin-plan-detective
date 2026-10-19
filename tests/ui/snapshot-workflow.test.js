import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MESSAGE_CATALOG } from "../../src/lib/i18n/messages.js";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const [app, manager, replay, saveAction] = await Promise.all([
  read("src/App.svelte"),
  read("src/components/SnapshotManager.svelte"),
  read("src/lib/plan-snapshot-view.js"),
  read("src/lib/snapshot-save-action.js"),
]);

test("snapshot manager is independent of the connection gate and uses only the Host Storage repository", () => {
  assert.match(app, /<SnapshotManager[\s\S]*?repository=\{snapshotRepository\}/);
  assert.ok(app.indexOf("{#if activeSnapshot !== null}") < app.indexOf("{#if hostEntryState === \"loading\"}"), "history view is reachable before host connection/Plan API gates");
  assert.match(app, /describePluginStorage\(bridge, \{ initialized: true \}\)/);
  assert.match(app, /createPlanSnapshotRepository\(bridge\)/);
  assert.doesNotMatch(manager, /localStorage|indexedDB/);
  assert.match(manager, /target\.list\(/, "list uses the repository API");
  assert.match(manager, /createSnapshotSaveHandler\(/);
  assert.match(saveAction, /state\.repository\.save\(snapshot\)/, "save uses the repository API");
  for (const operation of ["get", "rename", "delete", "clear"]) {
    assert.match(manager, new RegExp(`repository\\.${operation}\\(`), `${operation} uses the repository API`);
  }
});

test("opening history replays the saved RawPlanInput locally and never calls the host plan API", () => {
  const openHandler = app.match(/function openSnapshot\(snapshot\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(openHandler, "App has a dedicated history-open handler");
  assert.match(openHandler, /createPlanSnapshotView\(snapshot\)/);
  assert.doesNotMatch(openHandler, /analyze\(/);
  assert.match(app, /const displaySession = \$derived\(activeSnapshot\?\.session \?\? session\)/);
  assert.match(app, /<PlanAnalysisLayout[\s\S]*?\{summary\}[\s\S]*?\{findingViews\}[\s\S]*?\{hotspotViews\}/);
  assert.match(app, /snapshot\.history\.reanalysis/);
  assert.match(app, /snapshot\.history\.analysis\.structured/);
  assert.match(app, /activeSnapshot\.snapshot\.rawInput\.sql/);
  assert.doesNotMatch(replay, /^import .*host/mi, "snapshot replay has no Host adapter dependency");
  assert.doesNotMatch(replay, /explainEstimatedPlan\s*\(/);
});

test("history actions expose rename, delete, clear, and an explicit comparison-baseline selection", () => {
  assert.match(manager, /repository\.rename\(snapshotId, renameTitle\.trim\(\), renameNote\)/);
  assert.match(manager, /repository\.delete\(snapshotId\)/);
  assert.match(manager, /repository\.clear\(\)/);
  assert.match(manager, /onSelectBaseline\(baselineSnapshotId === snapshotId \? null : snapshotId\)/);
  assert.match(manager, /!nextSnapshots\.some\(\(snapshot\) => snapshot\.snapshotId === baselineSnapshotId\)[\s\S]*?onSelectBaseline\(null\)/);
  assert.match(manager, /onDeleteSnapshot\(snapshotId\)/);
  assert.match(manager, /onClearSnapshots\(\)/);
  assert.match(MESSAGE_CATALOG["zh-CN"]["snapshot.baseline.select"], /基线/);
  assert.match(MESSAGE_CATALOG.en["snapshot.baseline.select"], /baseline/i);
  assert.match(MESSAGE_CATALOG["zh-CN"]["snapshot.manager.description"], /当前窗口/);
  assert.match(MESSAGE_CATALOG.en["snapshot.manager.description"], /this window/);
  assert.match(MESSAGE_CATALOG["zh-CN"]["snapshot.manager.concurrentWarning"], /多个插件窗口/);
  assert.match(MESSAGE_CATALOG.en["snapshot.manager.concurrentWarning"], /multiple plugin windows/);
});

test("save form requires explicit user action and gives visible, actionable save feedback", () => {
  assert.match(saveAction, /createSnapshot\(\{[\s\S]*?session: state\.currentSession/);
  assert.match(saveAction, /if \(state\.repository === null \|\| state\.storageAvailable !== true\)/);
  assert.match(saveAction, /if \(state\.currentSession\?\.status !== "structured"\)/);
  assert.match(saveAction, /if \(inFlight\)[\s\S]*?setDuplicateMessage\(\)/);
  assert.match(saveAction, /await refresh\(state\.repository\)/);
  assert.match(manager, /snapshot\.save\.localWarning/);
  assert.match(manager, /maxlength="120"/);
  assert.match(manager, /maxlength="2000"/);
  assert.match(manager, /disabled=\{!canMutate \|\| !canSave \|\| saving \|\| saveTitle\.trim\(\)\.length === 0\}/);
  assert.match(manager, /snapshot-save-gate/);
  assert.match(manager, /snapshot-save-error/);
});

test("save errors and non-save operation errors are isolated in their own feedback regions", () => {
  const operationFeedbackIndex = manager.indexOf("{#if operationError}");
  const saveFormIndex = manager.indexOf("{#if showSaveForm}");
  const saveFeedbackIndex = manager.indexOf("{#if saveError}");

  assert.ok(operationFeedbackIndex >= 0 && operationFeedbackIndex < saveFormIndex);
  assert.ok(saveFormIndex < saveFeedbackIndex);
  assert.match(manager, /setError: \(error\) => \{ saveError = error; \}/);
  assert.match(manager, /operationError = error;/, "open, rename, delete, and clear handlers use the global operation error");
  assert.doesNotMatch(manager, /operationError && !showSaveForm/);
  assert.doesNotMatch(manager.slice(saveFormIndex, saveFeedbackIndex), /operationError/);
});

test("save waiting and uncertain-outcome diagnostics are localized and forbid blind resubmission", () => {
  assert.match(manager, /setTimeout\([\s\S]*?10_000/);
  assert.match(manager, /snapshot\.save\.pendingDiagnostic/);
  assert.match(MESSAGE_CATALOG["zh-CN"]["snapshot.save.pendingDiagnostic"], /不要重复提交/);
  assert.match(MESSAGE_CATALOG.en["snapshot.save.pendingDiagnostic"], /do not submit again/i);
  assert.match(MESSAGE_CATALOG["zh-CN"]["snapshot.error.SNAPSHOT_WRITE_UNCONFIRMED"], /不要立即重复提交/);
  assert.match(MESSAGE_CATALOG.en["snapshot.error.SNAPSHOT_WRITE_UNCONFIRMED"], /do not submit again/i);
});
