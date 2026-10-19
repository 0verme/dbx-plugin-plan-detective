import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MESSAGE_CATALOG } from "../../src/lib/i18n/messages.js";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const [app, manager, replay, saveAction, diagnostics, snapshotStore, storageAdapter, manifest] = await Promise.all([
  read("src/App.svelte"),
  read("src/components/SnapshotManager.svelte"),
  read("src/lib/plan-snapshot-view.js"),
  read("src/lib/snapshot-save-action.js"),
  read("src/lib/snapshot-diagnostic-trace.js"),
  read("src/lib/plan-snapshot-store.js"),
  read("src/host/dbx-plugin-storage.js"),
  read("manifest.json"),
]);

test("snapshot tools are a compact host-page toolbar before connection and SQL gates", () => {
  const toolbarPlacement = app.indexOf("<SnapshotManager");
  const connectionGate = app.indexOf("{#if hostEntryState === \"loading\"}");
  assert.ok(toolbarPlacement >= 0 && toolbarPlacement < connectionGate, "history is reachable without a connection or SQL context");
  assert.match(app, /\{#if view === "host"\}[\s\S]*?<SnapshotManager[\s\S]*?repository=\{snapshotRepository\}/);
  assert.match(app, /describePluginStorage\(bridge, \{ initialized: true \}\)/);
  assert.match(app, /createPlanSnapshotRepository\(bridge\)/);
  assert.match(manifest, /"host\.storage"/);
  assert.doesNotMatch(manager, /localStorage|indexedDB/);
  assert.match(manager, /<button[\s\S]*?class="snapshot-secondary snapshot-history-button"[\s\S]*?snapshot\.history\.button/);
  assert.match(manager, /<button[\s\S]*?class="snapshot-primary"[\s\S]*?snapshot\.save\.open/);
  assert.match(manager, /viewBox="0 0 16 16"[\s\S]*?M2\.2 5\.2/);
  assert.match(manager, /viewBox="0 0 16 16"[\s\S]*?M2\.5 2\.5/);
  assert.match(manager, /const historyCount = \$derived\(hasConfirmedHistory \? String\(orderedSnapshots\.length\) : "—"\)/);
  assert.match(manager, /hasConfirmedHistory = true;[\s\S]*?loadState = "ready"/);
  assert.match(manager, /title=\{saveDisabledReason\}/);
  assert.match(manager, /class="snapshot-toolbar-help"/);
  assert.match(manager, /disabled=\{!canSave \|\| !canMutate\}/);
  assert.match(manager, /aria-busy=\{saving\}/);
  assert.match(manager, /function toggleHistory\(\)[\s\S]*?showHistory = opening/);
  assert.match(manager, /snapshot\.history\.refresh/);
  assert.match(manager, /snapshot\.history\.close/);
  assert.match(manager, /snapshot\.storage\.unavailable/);
  assert.match(manager, /storageState\?\.reason/);
});

test("history records render compact metadata and all requested management actions", () => {
  assert.match(manager, /\[\.\.\.snapshots\]\.sort\(\(left, right\) => right\.savedAt\.localeCompare\(left\.savedAt\)\)/);
  assert.match(manager, /<h3>\{snapshot\.title\}<\/h3>/);
  assert.match(manager, /formatPlanSnapshotTime\(snapshot\.savedAt, locale\)/);
  assert.match(manager, /\{snapshot\.rawInput\.database\}/);
  assert.match(manager, /\{snapshot\.note \|\| t\("snapshot\.noNote"\)\}/);
  assert.match(manager, /repository\.get\(snapshotId\)/);
  assert.match(manager, /repository\.rename\(snapshotId, renameTitle\.trim\(\), renameNote\)/);
  assert.match(manager, /repository\.delete\(snapshotId\)/);
  assert.match(manager, /onSelectBaseline\(baselineSnapshotId === snapshotId \? null : snapshotId\)/);
  assert.match(manager, /snapshot\.empty/);
  assert.match(manager, /snapshot\.history\.refresh/);
  assert.match(manager, /snapshot\.baseline\.windowOnly/);
  assert.match(manager, /snapshot\.manager\.concurrentWarning/);
  assert.match(manager, /onUpdateSnapshot\(updated\)/);
  assert.match(manager, /onDeleteSnapshot\(snapshotId\)/);
  assert.doesNotMatch(manager, /clearSnapshots\(|snapshot\.clear\.open/);
});

test("opening history replays the saved RawPlanInput locally and never re-runs SQL", () => {
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

test("save form is opt-in, guarded, privacy-aware, and keeps typed values on failure", () => {
  assert.match(manager, /\{#if showSaveForm\}[\s\S]*?<form class="snapshot-form" onsubmit=\{saveCurrent\}/);
  assert.match(saveAction, /event\.preventDefault\(\)/);
  assert.match(saveAction, /state\.repository\.save\(snapshot,\s*\{\s*trace\s*\}\)/);
  assert.match(saveAction, /state\.currentSession\?\.status !== "structured"/);
  assert.match(saveAction, /if \(inFlight\)[\s\S]*?setDuplicateMessage\(\)/);
  assert.match(manager, /snapshot\.save\.localWarning/);
  assert.match(manager, /maxlength="120"/);
  assert.match(manager, /maxlength="2000"/);
  assert.match(manager, /disabled=\{!canMutate \|\| !canSave \|\| saving \|\| saveTitle\.trim\(\)\.length === 0\}/);
  assert.match(manager, /setError: \(error\) => \{ saveError = error; \}/);
  assert.match(manager, /snapshot-save-error/);
  assert.match(saveAction, /if \(error\?\.code === "SNAPSHOT_WRITE_UNCONFIRMED"/);
  assert.match(manager, /Repository\.save resolves only after Host Storage read-back confirms/);
  assert.match(manager, /statusMessage = t\("snapshot\.saved"\)/);
  assert.match(manager, /snapshot\.save\.pendingDiagnostic/);
  assert.match(manager, /snapshot\.diagnostic\.copy/);
  assert.match(manager, /buildSnapshotDiagnosticLog\(\)/);
  assert.match(manager, /onclick=\{handleSaveClick\}/);
  assert.match(manager, /oninvalid=\{handleSaveInvalid\}/);
  assert.match(manager, /SNAPSHOT_SAVE_BUTTON_STATE_CHANGE/);
  for (const step of [
    "SNAPSHOT_UI_CLICK",
    "SNAPSHOT_FORM_SUBMIT",
    "SNAPSHOT_SAVE_GATE",
    "SNAPSHOT_CREATE",
    "SNAPSHOT_REPOSITORY_SAVE",
    "SNAPSHOT_STORE_LOAD",
    "SNAPSHOT_HOST_STORAGE_GET",
    "SNAPSHOT_STORE_VALIDATE",
    "SNAPSHOT_STORAGE_SET",
    "SNAPSHOT_STORAGE_VERIFY",
    "SNAPSHOT_HISTORY_REFRESH",
    "SNAPSHOT_UI_SUCCESS",
    "SNAPSHOT_UI_ERROR",
  ]) assert.ok(diagnostics.includes(step) || saveAction.includes(step) || manager.includes(step) || snapshotStore.includes(step) || storageAdapter.includes(step), `diagnostics include ${step}`);
  assert.doesNotMatch(diagnostics, /localStorage|indexedDB|hostMessage/);
  const successCallback = manager.match(/onSuccess: \(snapshot\) => \{[\s\S]*?\n    \},\n    refresh/)?.[0];
  assert.ok(successCallback, "confirmed save success callback exists");
  assert.match(successCallback, /saveTitle = ""/);
  assert.match(successCallback, /saveNote = ""/);
});

test("save and history failures are shown in their own action regions with storage diagnostics", () => {
  const saveFormIndex = manager.indexOf("{#if showSaveForm}");
  const historyPanelIndex = manager.indexOf("{#if showHistory}");
  const saveErrorIndex = manager.indexOf("{#if saveError}");
  const operationErrorIndex = manager.indexOf("{#if operationError}");
  assert.ok(saveFormIndex >= 0 && saveFormIndex < saveErrorIndex);
  assert.ok(historyPanelIndex >= 0 && historyPanelIndex < operationErrorIndex);
  assert.match(manager, /getErrorMessage\(saveError\)/);
  assert.match(manager, /getErrorDetail\(saveError\)/);
  assert.match(manager, /getErrorMessage\(loadError\)/);
  assert.match(manager, /getErrorDetail\(loadError\)/);
  assert.match(manager, /storageState\?\.reason/);
  assert.match(manager, /function toggleHistory\(\)[\s\S]*?if \(saving\) return/);
  assert.match(manager, /disabled=\{saving\}[\s\S]*?snapshot\.history\.button|snapshot\.history\.button[\s\S]*?disabled=\{saving\}/);
  assert.match(MESSAGE_CATALOG["zh-CN"]["snapshot.error.STORAGE_PERMISSION_DENIED"], /权限/);
  assert.match(MESSAGE_CATALOG.en["snapshot.error.STORAGE_PERMISSION_DENIED"], /permission/i);
  for (const reasonCode of ["BRIDGE_UNAVAILABLE", "STORAGE_METHODS_MISSING", "INITIALIZING", "CAPABILITY_UNAVAILABLE"]) {
    assert.equal(typeof MESSAGE_CATALOG.en[`snapshot.storage.reason.${reasonCode}`], "string");
    assert.equal(typeof MESSAGE_CATALOG["zh-CN"][`snapshot.storage.reason.${reasonCode}`], "string");
  }
});

test("all new snapshot entry and baseline copy is localized", () => {
  for (const locale of ["zh-CN", "en"]) {
    for (const key of [
      "snapshot.tools.label",
      "snapshot.history.button",
      "snapshot.history.refresh",
      "snapshot.history.close",
      "snapshot.baseline.windowOnly",
      "snapshot.save.open",
      "snapshot.save.localWarning",
      "snapshot.diagnostic.copy",
      "snapshot.diagnostic.copied",
      "snapshot.diagnostic.empty",
      "snapshot.diagnostic.copyFailed",
    ]) {
      assert.equal(typeof MESSAGE_CATALOG[locale][key], "string", `${locale} has ${key}`);
      assert.ok(MESSAGE_CATALOG[locale][key].length > 0, `${locale} has non-empty ${key}`);
    }
  }
  assert.match(MESSAGE_CATALOG["zh-CN"]["snapshot.baseline.windowOnly"], /当前窗口/);
  assert.match(MESSAGE_CATALOG.en["snapshot.baseline.windowOnly"], /this window/i);
  assert.match(MESSAGE_CATALOG["zh-CN"]["snapshot.save.localWarning"], /SQL 与完整 Raw Plan/);
  assert.match(MESSAGE_CATALOG.en["snapshot.save.localWarning"], /SQL and complete Raw Plan/);
  assert.match(MESSAGE_CATALOG["zh-CN"]["snapshot.manager.concurrentWarning"], /多个插件窗口/);
  assert.match(MESSAGE_CATALOG["zh-CN"]["snapshot.save.pendingDiagnostic"], /UNKNOWN\/PENDING/);
  assert.match(MESSAGE_CATALOG.en["snapshot.save.pendingDiagnostic"], /UNKNOWN\/PENDING/);
  assert.match(MESSAGE_CATALOG.en["snapshot.manager.concurrentWarning"], /multiple plugin windows/);
  assert.match(manifest, /不连接数据库直接浏览历史快照/);
  assert.match(manifest, /browse saved snapshot history without an active connection/);
  assert.match(manager, /@media \(max-width: 620px\)/);
});
