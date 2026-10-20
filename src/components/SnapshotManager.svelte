<script>
  import { onDestroy } from "svelte";
  import { createTranslator } from "../lib/i18n/index.js";
  import { formatPlanSnapshotTime } from "../lib/plan-snapshot-view.js";
  import { PlanSnapshotStoreError } from "../lib/plan-snapshot-store.js";
  import { createSnapshotSaveHandler } from "../lib/snapshot-save-action.js";
  import { copyTextToClipboard } from "../lib/clipboard-copy.js";
  import {
    SANDBOX_SUBMIT_DISPATCHED,
    SANDBOX_SUBMIT_FAILED,
    SANDBOX_SUBMIT_INVALID,
    SANDBOX_SUBMIT_DISABLED,
    submitSandboxedForm,
  } from "../lib/sandbox-form-submit.js";
  import {
    buildSnapshotDiagnosticLog,
    createSnapshotDiagnosticTrace,
    hasSnapshotDiagnosticEvents,
    getSnapshotDiagnosticSessionTrace,
    prepareSnapshotSaveTrace,
    recordSnapshotDiagnosticEvent,
    recordSnapshotFormValidationFailure,
    recordSnapshotFormSubmitCapture,
    finishSnapshotDiagnosticTrace,
    snapshotDiagnosticErrorFields,
    startSnapshotDiagnosticStage,
    finishSnapshotDiagnosticStage,
    withSnapshotDiagnosticStage,
  } from "../lib/snapshot-diagnostic-trace.js";

  let {
    locale = "zh-CN",
    storageState = null,
    repository = null,
    currentSession = null,
    activeSnapshotId = null,
    baselineSnapshotId = null,
    producerVersion = null,
    diagnosticBridge = null,
    onOpenSnapshot = () => {},
    onSelectBaseline = () => {},
    onDeleteSnapshot = () => {},
    onUpdateSnapshot = () => {},
  } = $props();

  const t = $derived(createTranslator(locale).t);
  let snapshots = $state([]);
  let hasConfirmedHistory = $state(false);
  let loadState = $state("unavailable");
  let loadError = $state(null);
  let operationError = $state(null);
  let saveError = $state(null);
  let statusMessage = $state(null);
  let saving = $state(false);
  let savingRename = $state(false);
  let savePendingLonger = $state(false);
  let loadPendingLonger = $state(false);
  let diagnosticMessage = $state(null);
  let previousSaveButtonState = null;
  let saveWaitTimer = null;
  let loadWaitTimer = null;
  let showHistory = $state(false);
  let showSaveForm = $state(false);
  let saveForm = $state(null);
  let saveSubmitCount = 0;
  let saveTitle = $state("");
  let saveNote = $state("");
  let renameId = $state(null);
  let renameTitle = $state("");
  let renameNote = $state("");
  let renameForm = $state(null);
  let renameError = $state(null);
  let renameInFlight = false;
  let renameTrace = null;
  let renameSubmitCount = 0;
  let deleteConfirmationId = $state(null);
  let loadToken = 0;

  const canSave = $derived(currentSession?.status === "structured");
  const canMutate = $derived(repository !== null && storageState?.available === true && loadState === "ready" && !saving && !savingRename);
  const saveConfirmDisabled = $derived(!canMutate || !canSave || saving);
  const orderedSnapshots = $derived([...snapshots].sort((left, right) => right.savedAt.localeCompare(left.savedAt)));
  const renameConfirmDisabled = $derived(!canMutate || savingRename);
  const historyCount = $derived(hasConfirmedHistory ? String(orderedSnapshots.length) : "—");
  const saveGateMessage = $derived.by(() => {
    if (!canSave) return t("snapshot.save.requiresStructured");
    if (repository === null || storageState?.available !== true) return t("snapshot.storage.unavailable");
    if (loadState === "loading" || loadState === "initializing") return t("snapshot.loading");
    if (loadState === "error") return `${t("snapshot.loadFailed")} ${getErrorMessage(loadError)}`;
    if (loadState !== "ready") return t("snapshot.storage.unavailable");
    return null;
  });
  const saveDisabledReason = $derived(!canSave ? t("snapshot.save.requiresStructured") : (saveGateMessage ?? undefined));

  $effect(() => {
    const currentRepository = repository;
    const currentStorageState = storageState;
    if (currentRepository === null) {
      const trace = createSnapshotDiagnosticTrace({ kind: "history" });
      recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_HISTORY_INITIALIZATION", "blocked", {
        storageAvailable: currentStorageState?.available === true,
        storageAdvertised: currentStorageState?.advertised === true,
        reasonCode: currentStorageState?.reasonCode,
      });
      finishSnapshotDiagnosticTrace(trace, "blocked");
      loadToken += 1;
      if (loadWaitTimer !== null) clearTimeout(loadWaitTimer);
      loadWaitTimer = null;
      loadPendingLonger = false;
      snapshots = [];
      hasConfirmedHistory = false;
      loadError = null;
      loadState = currentStorageState?.state === "initializing" ? "initializing" : "unavailable";
      return;
    }
    void refresh(currentRepository, { operation: "initial" });
  });

  $effect(() => {
    const titlePresent = saveTitle.trim().length > 0;
    const buttonState = {
      saveDisabled: !canSave || !canMutate,
      saveEntryDisabled: !canSave || !canMutate,
      saveConfirmDisabled,
      sessionStructured: canSave,
      storageAvailable: storageState?.available === true,
      loadState,
      titlePresent,
      saving,
    };
    const serialized = JSON.stringify(buttonState);
    if (serialized === previousSaveButtonState) return;
    previousSaveButtonState = serialized;
    recordSnapshotDiagnosticEvent(getSnapshotDiagnosticSessionTrace(), "SNAPSHOT_SAVE_BUTTON_STATE_CHANGE", "info", buttonState);
  });

  async function refresh(target = repository, options = {}) {
    if (target === null) return null;
    const trace = options.trace ?? createSnapshotDiagnosticTrace({ kind: "history" });
    let traceOutcome = "completed";
    const operation = options.operation ?? "manual";
    const initializationStage = operation === "initial"
      ? startSnapshotDiagnosticStage(trace, "SNAPSHOT_HISTORY_INITIALIZATION", {
        storageAvailable: storageState?.available === true,
        storageAdvertised: storageState?.advertised === true,
      })
      : null;
    recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_HISTORY_REFRESH_REQUEST", "info", { operation });
    const token = ++loadToken;
    if (loadWaitTimer !== null) clearTimeout(loadWaitTimer);
    loadPendingLonger = false;
    loadState = "loading";
    loadError = null;
    const waitTimer = setTimeout(() => {
      if (token === loadToken && loadState === "loading") {
        loadPendingLonger = true;
        recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_HISTORY_REFRESH_PENDING", "pending", {
          operation,
          failedStage: "history.refresh",
        });
      }
    }, 10_000);
    loadWaitTimer = waitTimer;
    try {
      const nextSnapshots = await withSnapshotDiagnosticStage(
        trace,
        "SNAPSHOT_HISTORY_REFRESH",
        () => target.list({ trace, readRole: "history" }),
        { operation, failedStage: "history.refresh" },
      );
      if (token !== loadToken) {
        traceOutcome = "blocked";
        finishSnapshotDiagnosticStage(initializationStage, "blocked", { operation });
        return null;
      }
      finishSnapshotDiagnosticStage(initializationStage, "success", { operation });
      snapshots = nextSnapshots;
      hasConfirmedHistory = true;
      if (baselineSnapshotId !== null && !nextSnapshots.some((snapshot) => snapshot.snapshotId === baselineSnapshotId)) {
        onSelectBaseline(null);
      }
      loadState = "ready";
      return nextSnapshots;
    } catch (error) {
      traceOutcome = "failed";
      finishSnapshotDiagnosticStage(initializationStage, "failed", {
        operation,
        ...snapshotDiagnosticErrorFields(error, "history.refresh"),
      });
      if (token !== loadToken) return null;
      loadError = error;
      loadState = "error";
      recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_HISTORY_REFRESH_ERROR", "failed", snapshotDiagnosticErrorFields(error, "history.refresh"));
      return null;
    } finally {
      // A shared save trace is owned by the save handler. Independent history
      // traces settle only after the actual Host read has returned or failed.
      if (options.trace == null) finishSnapshotDiagnosticTrace(trace, traceOutcome);
      if (loadWaitTimer === waitTimer) {
        clearTimeout(waitTimer);
        loadWaitTimer = null;
        loadPendingLonger = false;
      }
    }
  }

  function clearOperationFeedback() {
    operationError = null;
    statusMessage = null;
  }

  function clearSaveFeedback() {
    saveError = null;
    statusMessage = null;
  }

  function setSaving(value, trace = null) {
    saving = value;
    if (trace) {
      recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_SAVE_BUTTON_STATE_CHANGE", "info", {
        saveDisabled: !canSave || !canMutate,
        saveEntryDisabled: !canSave || !canMutate,
        saveConfirmDisabled,
        saving: value,
        sessionStructured: currentSession?.status === "structured",
        storageAvailable: storageState?.available === true,
        loadState,
        titlePresent: saveTitle.trim().length > 0,
      });
    }
    savePendingLonger = false;
    if (saveWaitTimer !== null) clearTimeout(saveWaitTimer);
    saveWaitTimer = null;
    if (value) {
      saveWaitTimer = setTimeout(() => {
        saveWaitTimer = null;
        if (saving) {
          savePendingLonger = true;
          recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_SAVE_PENDING", "pending", {
            failedStage: "repository.save",
          });
        }
      }, 10_000);
    }
  }

  onDestroy(() => {
    if (saveWaitTimer !== null) clearTimeout(saveWaitTimer);
    if (loadWaitTimer !== null) clearTimeout(loadWaitTimer);
  });

  function getErrorMessage(error) {
    const code = typeof error?.code === "string" ? error.code : "GENERIC";
    const key = `snapshot.error.${code}`;
    const localized = t(key);
    return localized === key ? t("snapshot.error.GENERIC") : localized;
  }

  function getErrorDetail(error) {
    return typeof error?.hostMessage === "string" && error.hostMessage.length > 0 ? error.hostMessage : null;
  }

  function getStorageReason() {
    if (typeof storageState?.reason !== "string" || storageState.reason.length === 0) return null;
    const key = `snapshot.storage.reason.${storageState.reasonCode}`;
    const localized = t(key, { methods: (storageState.missing ?? []).join(", ") });
    return localized === key ? storageState.reason : localized;
  }

  const saveCurrent = createSnapshotSaveHandler({
    getState: () => ({
      repository,
      storageAvailable: storageState?.available === true,
      loadState,
      loadError,
      currentSession,
      saveTitle,
      saveNote,
      producerVersion,
    }),
    setSaving,
    clearFeedback: clearSaveFeedback,
    setDuplicateMessage: () => { statusMessage = t("snapshot.save.inProgress"); },
    setError: (error) => { saveError = error; },
    onSuccess: (snapshot) => {
      // Repository.save resolves only after Host Storage read-back confirms the
      // committed document. Reflect that confirmed item immediately, then let
      // the background list refresh reconcile any external changes.
      snapshots = [snapshot, ...snapshots.filter((entry) => entry.snapshotId !== snapshot.snapshotId)];
      hasConfirmedHistory = true;
      showSaveForm = false;
      saveTitle = "";
      saveNote = "";
      statusMessage = t("snapshot.saved");
    },
    refresh,
  });

  function saveFormDiagnosticFields(event) {
    const button = event?.currentTarget?.type === "submit" ? event.currentTarget : event?.submitter;
    return {
      storageAvailable: storageState?.available === true,
      sessionStructured: currentSession?.status === "structured",
      loadState,
      titlePresent: saveTitle.trim().length > 0,
      domTitlePresent: (saveForm?.querySelector("input")?.value.trim().length ?? 0) > 0,
      formAssociated: button == null ? undefined : button.form === saveForm,
      formConnected: saveForm?.isConnected === true,
      formNoValidate: saveForm?.noValidate === true,
      submitterDisabled: button == null ? undefined : button.disabled === true,
      disabledStateMismatch: button == null ? undefined : button.disabled !== saveConfirmDisabled,
      framed: window.parent !== window,
      eventTrusted: event?.isTrusted === true,
      eventDefaultPrevented: event?.defaultPrevented === true,
      eventCancelBubble: event?.cancelBubble === true,
    };
  }

  function handleSaveClick(event) {
    const trace = prepareSnapshotSaveTrace(saveFormDiagnosticFields(event));
    // DBX renders plugins in sandbox="allow-scripts" (no allow-forms), where
    // both native default submission and programmatic submission are stopped
    // before validation or submit. Keep the submit button's implicit Enter/Space
    // activation, explicitly run native validation, then dispatch a cancelable
    // submit event without any navigation, sandbox relaxation, or bypass of
    // createPlanSnapshot's guards.
    try {
      const outcome = submitSandboxedForm({
        event,
        form: saveForm,
        disabled: saveConfirmDisabled,
        readSubmitCount: () => saveSubmitCount,
        onValidationResult: (formValid) => {
          recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_FORM_VALIDATION_RESULT", formValid ? "success" : "blocked", { formValid });
        },
        onBeforeDispatch: () => {
          recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_FORM_SUBMIT_DISPATCH", "info", saveFormDiagnosticFields(event));
        },
      });
      // A dispatched or natively invalid form is owned by the submit/invalid
      // handlers; only a refused activation is settled here.
      if (outcome.status === SANDBOX_SUBMIT_DISPATCHED || outcome.status === SANDBOX_SUBMIT_INVALID) return;
      if (outcome.reason === SANDBOX_SUBMIT_DISABLED) {
        finishSnapshotDiagnosticTrace(trace, "blocked");
        return;
      }
      throw new PlanSnapshotStoreError(outcome.reason, "The save form did not dispatch its submit event.");
    } catch (error) {
      saveError = error;
      recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_FORM_EVENT_ERROR", "failed", snapshotDiagnosticErrorFields(error, "form.submit"));
      finishSnapshotDiagnosticTrace(trace, "failed");
    }
  }

  function handleSaveSubmitCapture(event) {
    recordSnapshotFormSubmitCapture(saveFormDiagnosticFields(event));
  }

  function handleSaveSubmit(event) {
    saveSubmitCount += 1;
    return saveCurrent(event);
  }

  function handleSaveInvalid(event) {
    saveError = { code: "FRONTEND_VALIDATION_REJECTED" };
    recordSnapshotFormValidationFailure({
      ...saveFormDiagnosticFields(event),
      invalidField: event.target.tagName === "TEXTAREA" ? "note" : "title",
      valueMissing: event.target.validity?.valueMissing === true,
      tooLong: event.target.validity?.tooLong === true,
      customError: event.target.validity?.customError === true,
    });
  }

  async function copyDiagnosticLog() {
    diagnosticMessage = null;
    if (!hasSnapshotDiagnosticEvents()) {
      diagnosticMessage = t("snapshot.diagnostic.empty");
      return;
    }
    const report = buildSnapshotDiagnosticLog();
    if (report === null) {
      diagnosticMessage = t("snapshot.diagnostic.empty");
      return;
    }
    try {
      const result = await copyTextToClipboard({ bridge: diagnosticBridge, text: report });
      diagnosticMessage = result.ok ? t("snapshot.diagnostic.copied") : t("snapshot.diagnostic.copyFailed");
    } catch {
      diagnosticMessage = t("snapshot.diagnostic.copyFailed");
    }
  }

  function toggleHistory() {
    if (saving) return;
    clearOperationFeedback();
    const opening = !showHistory;
    showHistory = opening;
    if (!opening) return;
    showSaveForm = false;
    if (repository !== null && loadState !== "loading") void refresh(repository, { operation: "open" });
  }

  function toggleSaveForm() {
    if (saving || !canSave || !canMutate) return;
    clearSaveFeedback();
    showHistory = false;
    showSaveForm = !showSaveForm;
  }

  async function openSnapshot(snapshotId) {
    clearOperationFeedback();
    if (!canMutate) return;
    try {
      const snapshot = await repository.get(snapshotId);
      if (snapshot === null) {
        throw new PlanSnapshotStoreError("SNAPSHOT_NOT_FOUND", "The requested snapshot does not exist.");
      }
      showSaveForm = false;
      renameId = null;
      renameError = null;
      deleteConfirmationId = null;
      showHistory = false;
      onOpenSnapshot(snapshot);
    } catch (error) {
      operationError = error;
      if (error?.code === "SNAPSHOT_STORAGE_CONFLICT" || error?.code === "SNAPSHOT_NOT_FOUND") void refresh(repository);
    }
  }

  function selectBaseline(snapshotId) {
    clearOperationFeedback();
    if (!canMutate) return;
    onSelectBaseline(baselineSnapshotId === snapshotId ? null : snapshotId);
  }

  function beginRename(snapshot) {
    clearOperationFeedback();
    renameError = null;
    renameTrace = null;
    renameId = snapshot.snapshotId;
    renameTitle = snapshot.title;
    renameNote = snapshot.note;
  }

  function renameFormDiagnosticFields(event) {
    const button = event?.currentTarget?.type === "submit" ? event.currentTarget : event?.submitter;
    return {
      storageAvailable: storageState?.available === true,
      loadState,
      titlePresent: renameTitle.trim().length > 0,
      domTitlePresent: (renameForm?.querySelector("input")?.value.trim().length ?? 0) > 0,
      formAssociated: button == null ? undefined : button.form === renameForm,
      formConnected: renameForm?.isConnected === true,
      formNoValidate: renameForm?.noValidate === true,
      submitterDisabled: button == null ? undefined : button.disabled === true,
      disabledStateMismatch: button == null ? undefined : button.disabled !== renameConfirmDisabled,
      framed: window.parent !== window,
      eventTrusted: event?.isTrusted === true,
      eventDefaultPrevented: event?.defaultPrevented === true,
      eventCancelBubble: event?.cancelBubble === true,
    };
  }

  function rejectRename(trace, errorCode, failedStage) {
    renameError = { code: errorCode };
    recordSnapshotDiagnosticEvent(trace, "RENAME_ERROR", "blocked", { errorCode, failedStage });
    finishSnapshotDiagnosticTrace(trace, "blocked");
  }

  // Renaming inherits the save form's DBX constraint: in the allow-scripts
  // frame a native submit never validates and never reaches saveRename, which
  // is why "Save changes" appeared to do nothing. The click owns the dispatch.
  function handleRenameClick(event) {
    const trace = createSnapshotDiagnosticTrace({ kind: "rename" });
    renameTrace = trace;
    recordSnapshotDiagnosticEvent(trace, "RENAME_CLICK", "info", renameFormDiagnosticFields(event));
    try {
      if (saving || savingRename || renameInFlight) {
        rejectRename(trace, "DUPLICATE_SUBMISSION", "rename.validate");
        return;
      }
      if (repository === null || storageState?.available !== true) {
        rejectRename(trace, "STORAGE_API_UNAVAILABLE", "rename.validate");
        return;
      }
      if (loadState !== "ready") {
        rejectRename(trace, "SNAPSHOT_LIST_NOT_READY", "rename.validate");
        return;
      }
      const outcome = submitSandboxedForm({
        event,
        form: renameForm,
        disabled: renameConfirmDisabled,
        readSubmitCount: () => renameSubmitCount,
        onValidationResult: (formValid) => {
          recordSnapshotDiagnosticEvent(trace, "RENAME_VALIDATE", formValid ? "success" : "blocked", formValid ? {} : {
            errorCode: "FRONTEND_VALIDATION_REJECTED",
            failedStage: "rename.validate",
          });
        },
      });
      // A dispatched submit continues on this same trace inside saveRename.
      if (outcome.status === SANDBOX_SUBMIT_DISPATCHED) return;
      if (outcome.status === SANDBOX_SUBMIT_INVALID) {
        renameError = { code: "FRONTEND_VALIDATION_REJECTED" };
        finishSnapshotDiagnosticTrace(trace, "blocked");
        return;
      }
      // A refused activation is a handled block; a dispatch that never reached
      // the form's submit handler is a real failure.
      const finishedStatus = outcome.status === SANDBOX_SUBMIT_FAILED ? "failed" : "blocked";
      renameError = { code: outcome.reason };
      recordSnapshotDiagnosticEvent(trace, "RENAME_ERROR", finishedStatus, { errorCode: outcome.reason, failedStage: "form.submit" });
      finishSnapshotDiagnosticTrace(trace, finishedStatus);
    } catch (error) {
      renameError = error;
      recordSnapshotDiagnosticEvent(trace, "RENAME_ERROR", "failed", snapshotDiagnosticErrorFields(error, "form.submit"));
      finishSnapshotDiagnosticTrace(trace, "failed");
    }
  }

  function handleRenameInvalid(event) {
    renameError = { code: "FRONTEND_VALIDATION_REJECTED" };
    const trace = renameTrace;
    if (trace === null) return;
    recordSnapshotDiagnosticEvent(trace, "RENAME_VALIDATE", "blocked", {
      ...renameFormDiagnosticFields(event),
      invalidField: event.target.tagName === "TEXTAREA" ? "note" : "title",
      valueMissing: event.target.validity?.valueMissing === true,
      tooLong: event.target.validity?.tooLong === true,
      customError: event.target.validity?.customError === true,
      errorCode: "FRONTEND_VALIDATION_REJECTED",
      failedStage: "rename.validate",
    });
    finishSnapshotDiagnosticTrace(trace, "blocked");
  }

  function handleRenameSubmit(event, snapshotId) {
    event.preventDefault();
    renameSubmitCount += 1;
    void saveRename(snapshotId);
  }

  async function saveRename(snapshotId) {
    const trace = renameTrace ?? createSnapshotDiagnosticTrace({ kind: "rename" });
    renameTrace = null;
    clearOperationFeedback();
    renameError = null;
    const title = renameTitle.trim();
    const blockedError = renameInFlight
      ? { code: "DUPLICATE_SUBMISSION" }
      : repository === null || storageState?.available !== true
        ? { code: "STORAGE_API_UNAVAILABLE" }
        : loadState !== "ready"
          ? { code: "SNAPSHOT_LIST_NOT_READY" }
          : title.length === 0 ? { code: "INVALID_SNAPSHOT_METADATA" } : null;
    if (blockedError !== null) {
      rejectRename(trace, blockedError.code, "rename.validate");
      return { status: "blocked" };
    }

    renameInFlight = true;
    savingRename = true;
    const stage = startSnapshotDiagnosticStage(trace, "RENAME_REPOSITORY");
    try {
      const updated = await repository.rename(snapshotId, title, renameNote, { trace });
      finishSnapshotDiagnosticStage(stage, "success");
      // The repository resolves only after Host Storage read-back confirms the
      // committed document, so the list can reflect the confirmed rename now.
      snapshots = snapshots.map((snapshot) => snapshot.snapshotId === snapshotId ? updated : snapshot);
      onUpdateSnapshot(updated);
      renameId = null;
      statusMessage = t("snapshot.updated");
      recordSnapshotDiagnosticEvent(trace, "RENAME_SUCCESS", "success");
      finishSnapshotDiagnosticTrace(trace, "completed");
      return { status: "renamed", snapshot: updated };
    } catch (error) {
      const fields = snapshotDiagnosticErrorFields(error, "rename.repository");
      finishSnapshotDiagnosticStage(stage, "failed", fields);
      // The typed name and notes stay in the form; nothing was replayed.
      renameError = error;
      recordSnapshotDiagnosticEvent(trace, "RENAME_ERROR", "failed", fields);
      finishSnapshotDiagnosticTrace(trace, "failed");
      if (error?.code === "SNAPSHOT_STORAGE_CONFLICT") void refresh(repository);
      return { status: "failed", error };
    } finally {
      renameInFlight = false;
      savingRename = false;
    }
  }

  async function deleteSnapshot(snapshotId) {
    clearOperationFeedback();
    if (!canMutate) return;
    try {
      const deleted = await repository.delete(snapshotId);
      deleteConfirmationId = null;
      if (deleted) {
        snapshots = snapshots.filter((snapshot) => snapshot.snapshotId !== snapshotId);
        onDeleteSnapshot(snapshotId);
        statusMessage = t("snapshot.deleted");
      }
      void refresh(repository);
    } catch (error) {
      operationError = error;
      if (error?.code === "SNAPSHOT_STORAGE_CONFLICT") void refresh(repository);
    }
  }
</script>

<section class="snapshot-manager" aria-label={t("snapshot.tools.label")}>
  <div class="snapshot-toolbar">
    <button
      type="button"
      class="snapshot-secondary snapshot-history-button"
      aria-expanded={showHistory}
      onclick={toggleHistory}
      disabled={saving}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2.2 5.2A6.3 6.3 0 1 1 2 8" />
        <path d="M2.2 2.8v2.7h2.7M8 4.5V8l2.3 1.4" />
      </svg>
      <span>{t("snapshot.history.button")} ({historyCount})</span>
    </button>
    <button
      type="button"
      class="snapshot-primary"
      onclick={toggleSaveForm}
      disabled={!canSave || !canMutate}
      title={saveDisabledReason}
      aria-describedby={!canSave ? "snapshot-save-disabled-reason" : undefined}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2.5 2.5h9l2 2v9h-11z" />
        <path d="M5 2.7v4h5v-4M5 13v-4h6v4" />
      </svg>
      <span>{t("snapshot.save.open")}</span>
    </button>
    <button type="button" class="snapshot-text-button" onclick={copyDiagnosticLog}>{t("snapshot.diagnostic.copy")}</button>
  </div>

  {#if diagnosticMessage}
    <p class="snapshot-feedback" role="status" aria-live="polite">{diagnosticMessage}</p>
  {/if}

  {#if !canSave}
    <p id="snapshot-save-disabled-reason" class="snapshot-toolbar-help">{t("snapshot.save.requiresStructured")}</p>
  {/if}

  {#if statusMessage}
    <p class="snapshot-feedback success" role="status" aria-live="polite">{statusMessage}</p>
  {/if}

  {#if showSaveForm}
    <section class="snapshot-panel snapshot-save-panel" aria-labelledby="snapshot-save-title" aria-busy={saving}>
      <form class="snapshot-form" bind:this={saveForm} onsubmitcapture={handleSaveSubmitCapture} onsubmit={handleSaveSubmit} oninvalidcapture={handleSaveInvalid}>
        <h2 id="snapshot-save-title">{t("snapshot.save.confirm")}</h2>
        <p class="snapshot-privacy-note">{t("snapshot.save.localWarning")}</p>
        {#if saveGateMessage !== null}
          <p class="snapshot-save-gate" role="status">{saveGateMessage}</p>
          {#if repository === null && getStorageReason()}
            <p class="snapshot-error-detail">{getStorageReason()}</p>
          {/if}
        {/if}
        <label>
          <span>{t("snapshot.field.title")}</span>
          <input bind:value={saveTitle} maxlength="120" required autocomplete="off" disabled={saving} />
        </label>
        <label>
          <span>{t("snapshot.field.note")}</span>
          <textarea bind:value={saveNote} maxlength="2000" rows="2" disabled={saving}></textarea>
        </label>
        <div class="snapshot-actions">
          <button type="submit" class="snapshot-primary" onclick={handleSaveClick} disabled={saveConfirmDisabled}>
            {saving ? t("snapshot.save.saving") : t("snapshot.save.confirm")}
          </button>
          <button type="button" class="snapshot-secondary" disabled={saving} onclick={() => (showSaveForm = false)}>{t("snapshot.cancel")}</button>
        </div>
        {#if saving && savePendingLonger}
          <p class="snapshot-feedback snapshot-save-pending" role="status" aria-live="polite">{t("snapshot.save.pendingDiagnostic")}</p>
        {/if}
        {#if statusMessage === t("snapshot.save.inProgress")}
          <p class="snapshot-feedback" role="status">{statusMessage}</p>
        {/if}
        {#if saveError}
          <p class="snapshot-feedback error snapshot-save-error" role="alert">{getErrorMessage(saveError)}</p>
          {#if getErrorDetail(saveError)}<p class="snapshot-error-detail">{getErrorDetail(saveError)}</p>{/if}
        {/if}
      </form>
    </section>
  {/if}

  {#if showHistory}
    <section class="snapshot-panel snapshot-history-panel" aria-labelledby="snapshot-history-list-title">
      <header class="snapshot-panel-head">
        <div>
          <h2 id="snapshot-history-list-title">{t("snapshot.history.button")}</h2>
          <p class="snapshot-baseline-hint">{t("snapshot.baseline.windowOnly")}</p>
          <p class="snapshot-concurrency-hint">{t("snapshot.manager.concurrentWarning")}</p>
        </div>
        <div class="snapshot-panel-actions">
          <button type="button" class="snapshot-secondary" disabled={repository === null || loadState === "loading"} onclick={() => refresh()}>{t("snapshot.history.refresh")}</button>
          <button type="button" class="snapshot-text-button" onclick={() => (showHistory = false)}>{t("snapshot.history.close")}</button>
        </div>
      </header>

      {#if operationError}
        <p class="snapshot-feedback error" role="alert">{getErrorMessage(operationError)}</p>
        {#if getErrorDetail(operationError)}<p class="snapshot-error-detail">{getErrorDetail(operationError)}</p>{/if}
      {/if}

      {#if storageState?.state === "initializing" && repository === null}
        <p class="snapshot-empty" role="status">{t("snapshot.storage.initializing")}</p>
      {:else if storageState?.available !== true || repository === null}
        <p class="snapshot-empty" role="alert">{t("snapshot.storage.unavailable")}</p>
        {#if getStorageReason()}<p class="snapshot-error-detail">{getStorageReason()}</p>{/if}
      {:else if loadState === "loading"}
        <div class="snapshot-empty snapshot-loading" role="status" aria-live="polite">
          <p>{t("snapshot.loading")}</p>
          {#if loadPendingLonger}<p>{t("snapshot.loading.pendingDiagnostic")}</p>{/if}
        </div>
      {:else if loadState === "error"}
        <div class="snapshot-empty snapshot-load-error" role="alert">
          <p>{t("snapshot.loadFailed")}</p>
          <p>{getErrorMessage(loadError)}</p>
          {#if getErrorDetail(loadError)}<p class="snapshot-error-detail">{getErrorDetail(loadError)}</p>{/if}
        </div>
      {:else if orderedSnapshots.length === 0}
        <p class="snapshot-empty" role="status">{t("snapshot.empty")}</p>
      {:else}
        <div class="snapshot-list-head">
          <span>{t("snapshot.list.count", { count: orderedSnapshots.length })}</span>
        </div>
        <ul class="snapshot-list">
          {#each orderedSnapshots as snapshot (snapshot.snapshotId)}
            <li class="snapshot-item" class:active={activeSnapshotId === snapshot.snapshotId} class:baseline={baselineSnapshotId === snapshot.snapshotId}>
              <div class="snapshot-item-main">
                <div class="snapshot-item-title-row">
                  <h3>{snapshot.title}</h3>
                  {#if activeSnapshotId === snapshot.snapshotId}<span class="snapshot-tag">{t("snapshot.openTag")}</span>{/if}
                  {#if baselineSnapshotId === snapshot.snapshotId}<span class="snapshot-tag baseline-tag">{t("snapshot.baselineTag")}</span>{/if}
                </div>
                <div class="snapshot-metadata">
                  <span>{formatPlanSnapshotTime(snapshot.savedAt, locale) ?? t("snapshot.unknown")}</span>
                  <span>{snapshot.rawInput.database}</span>
                </div>
                <p class="snapshot-note">{snapshot.note || t("snapshot.noNote")}</p>
              </div>

              {#if renameId === snapshot.snapshotId}
                <form
                  class="snapshot-form snapshot-rename-form"
                  bind:this={renameForm}
                  aria-busy={savingRename}
                  onsubmit={(event) => handleRenameSubmit(event, snapshot.snapshotId)}
                  oninvalidcapture={handleRenameInvalid}
                >
                  <label>
                    <span>{t("snapshot.field.title")}</span>
                    <input bind:value={renameTitle} maxlength="120" required autocomplete="off" disabled={savingRename} />
                  </label>
                  <label>
                    <span>{t("snapshot.field.note")}</span>
                    <textarea bind:value={renameNote} maxlength="2000" rows="2" disabled={savingRename}></textarea>
                  </label>
                  <div class="snapshot-actions">
                    <button type="submit" class="snapshot-primary" onclick={handleRenameClick} disabled={renameConfirmDisabled}>
                      {savingRename ? t("snapshot.rename.saving") : t("snapshot.rename.save")}
                    </button>
                    <button type="button" class="snapshot-secondary" disabled={savingRename} onclick={() => (renameId = null)}>{t("snapshot.cancel")}</button>
                  </div>
                  {#if renameError}
                    <p class="snapshot-feedback error snapshot-rename-error" role="alert">{getErrorMessage(renameError)}</p>
                    {#if getErrorDetail(renameError)}<p class="snapshot-error-detail">{getErrorDetail(renameError)}</p>{/if}
                  {/if}
                </form>
              {:else if deleteConfirmationId === snapshot.snapshotId}
                <div class="snapshot-confirm-inline" role="group" aria-label={t("snapshot.delete.confirmLabel")}>
                  <span>{t("snapshot.delete.confirm", { title: snapshot.title })}</span>
                  <button type="button" class="snapshot-danger" disabled={!canMutate} onclick={() => deleteSnapshot(snapshot.snapshotId)}>{t("snapshot.delete.confirmAction")}</button>
                  <button type="button" class="snapshot-secondary" onclick={() => (deleteConfirmationId = null)}>{t("snapshot.cancel")}</button>
                </div>
              {:else}
                <div class="snapshot-item-actions">
                  <button type="button" class="snapshot-secondary" disabled={!canMutate} onclick={() => openSnapshot(snapshot.snapshotId)}>{t("snapshot.open")}</button>
                  <button
                    type="button"
                    class="snapshot-secondary"
                    disabled={!canMutate}
                    aria-pressed={baselineSnapshotId === snapshot.snapshotId}
                    onclick={() => selectBaseline(snapshot.snapshotId)}
                  >{baselineSnapshotId === snapshot.snapshotId ? t("snapshot.baseline.selected") : t("snapshot.baseline.select")}</button>
                  <button type="button" class="snapshot-secondary" disabled={!canMutate} onclick={() => beginRename(snapshot)}>{t("snapshot.rename.open")}</button>
                  <button
                    type="button"
                    class="snapshot-danger-link"
                    disabled={!canMutate}
                    onclick={() => { clearOperationFeedback(); deleteConfirmationId = snapshot.snapshotId; }}
                  >{t("snapshot.delete.open")}</button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</section>

<style>
  .snapshot-manager {
    margin: -2px 0 var(--pd-layout-gap);
  }

  .snapshot-toolbar,
  .snapshot-panel-head,
  .snapshot-panel-actions,
  .snapshot-item-title-row,
  .snapshot-actions,
  .snapshot-item-actions,
  .snapshot-confirm-inline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
  }

  .snapshot-toolbar {
    justify-content: flex-end;
  }

  .snapshot-toolbar svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.5;
  }

  .snapshot-panel-head {
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .snapshot-panel-head h2,
  .snapshot-form h2 {
    margin: 0;
    font-size: 14px;
  }

  .snapshot-baseline-hint,
  .snapshot-concurrency-hint,
  .snapshot-empty,
  .snapshot-feedback,
  .snapshot-note,
  .snapshot-error-detail {
    margin: 4px 0 0;
    color: var(--pd-muted);
    font-size: 12px;
  }

  .snapshot-error-detail {
    overflow-wrap: anywhere;
  }

  .snapshot-save-gate,
  .snapshot-toolbar-help {
    margin: 0;
    color: var(--pd-muted);
    font-size: 11px;
  }

  .snapshot-toolbar-help {
    text-align: right;
  }

  .snapshot-save-error,
  .snapshot-save-pending,
  .snapshot-rename-error {
    margin: 0;
  }

  .snapshot-loading p {
    margin: 4px 0;
  }

  .snapshot-primary,
  .snapshot-secondary,
  .snapshot-danger,
  .snapshot-text-button,
  .snapshot-danger-link {
    display: inline-flex;
    min-height: 30px;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 5px 9px;
    border: 1px solid var(--pd-border-strong);
    border-radius: 5px;
    background: var(--pd-surface);
    color: var(--pd-text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .snapshot-primary {
    border-color: var(--pd-accent);
    background: var(--pd-accent);
    color: var(--pd-on-accent, #fff);
    font-weight: 650;
  }

  .snapshot-text-button,
  .snapshot-danger-link {
    min-height: 24px;
    padding: 2px 4px;
    border-color: transparent;
    background: transparent;
    color: var(--pd-muted);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .snapshot-danger,
  .snapshot-danger-link {
    color: var(--pd-high-fg);
  }

  .snapshot-primary:disabled,
  .snapshot-secondary:disabled,
  .snapshot-danger:disabled,
  .snapshot-text-button:disabled,
  .snapshot-danger-link:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .snapshot-panel {
    margin: 8px 0 0;
    padding: 12px;
    border: 1px solid var(--pd-border);
    border-radius: 7px;
    background: var(--pd-surface);
    box-shadow: var(--pd-shadow-sm, 0 4px 16px rgb(0 0 0 / 8%));
  }

  .snapshot-save-panel {
    width: min(100%, 560px);
    margin-left: auto;
  }

  .snapshot-form {
    display: grid;
    gap: 9px;
  }

  .snapshot-form label {
    display: grid;
    gap: 4px;
    color: var(--pd-muted);
    font-size: 11px;
    font-weight: 600;
  }

  .snapshot-form input,
  .snapshot-form textarea {
    width: 100%;
    min-width: 0;
    padding: 7px 8px;
    border: 1px solid var(--pd-border-strong);
    border-radius: 5px;
    background: var(--pd-surface);
    color: var(--pd-text);
    font: inherit;
    font-size: 12px;
  }

  .snapshot-form textarea {
    resize: vertical;
  }

  .snapshot-privacy-note {
    margin: 0;
    color: var(--pd-warning-fg);
    font-size: 11px;
  }

  .snapshot-actions {
    justify-content: flex-end;
  }

  .snapshot-feedback.error,
  .snapshot-load-error {
    color: var(--pd-high-fg);
  }

  .snapshot-feedback.success {
    color: var(--pd-ok-fg);
  }

  .snapshot-list-head {
    margin-top: 8px;
    color: var(--pd-muted);
    font-size: 11px;
  }

  .snapshot-confirm-inline {
    justify-content: flex-end;
    color: var(--pd-high-fg);
  }

  .snapshot-list {
    display: grid;
    gap: 7px;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }

  .snapshot-item {
    display: grid;
    gap: 8px;
    padding: 9px 10px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface-muted);
  }

  .snapshot-item.active {
    border-left: 3px solid var(--pd-accent);
  }

  .snapshot-item.baseline {
    border-color: var(--pd-info-border);
  }

  .snapshot-item-title-row h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 650;
    overflow-wrap: anywhere;
  }

  .snapshot-tag {
    padding: 2px 5px;
    border-radius: 4px;
    background: var(--pd-accent-soft);
    color: var(--pd-accent);
    font-size: 10px;
    font-weight: 650;
  }

  .baseline-tag {
    background: var(--pd-info-bg);
    color: var(--pd-info-fg);
  }

  .snapshot-metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 3px 10px;
    margin-top: 4px;
    color: var(--pd-muted);
    font-size: 10px;
    overflow-wrap: anywhere;
  }

  .snapshot-note {
    display: -webkit-box;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  .snapshot-item-actions {
    justify-content: flex-end;
  }

  .snapshot-rename-form {
    margin-bottom: 0;
  }

  button:focus-visible,
  input:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--pd-accent);
    outline-offset: 2px;
  }

  @media (max-width: 620px) {
    .snapshot-toolbar {
      justify-content: flex-start;
    }

    .snapshot-toolbar-help {
      text-align: left;
    }

    .snapshot-panel-head {
      align-items: flex-start;
    }

    .snapshot-panel-actions {
      width: 100%;
    }

    .snapshot-item-actions > button {
      flex: 1 1 100px;
    }
  }
</style>
