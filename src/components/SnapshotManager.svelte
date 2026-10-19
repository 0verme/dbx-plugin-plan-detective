<script>
  import { onDestroy } from "svelte";
  import { createTranslator } from "../lib/i18n/index.js";
  import { formatPlanSnapshotTime } from "../lib/plan-snapshot-view.js";
  import { PlanSnapshotStoreError } from "../lib/plan-snapshot-store.js";
  import { createSnapshotSaveHandler } from "../lib/snapshot-save-action.js";

  let {
    locale = "zh-CN",
    storageState = null,
    repository = null,
    currentSession = null,
    activeSnapshotId = null,
    baselineSnapshotId = null,
    producerVersion = null,
    onOpenSnapshot = () => {},
    onSelectBaseline = () => {},
    onDeleteSnapshot = () => {},
    onClearSnapshots = () => {},
    onUpdateSnapshot = () => {},
  } = $props();

  const t = $derived(createTranslator(locale).t);
  let snapshots = $state([]);
  let loadState = $state("unavailable");
  let loadError = $state(null);
  let operationError = $state(null);
  let saveError = $state(null);
  let statusMessage = $state(null);
  let saving = $state(false);
  let savePendingLonger = $state(false);
  let loadPendingLonger = $state(false);
  let saveWaitTimer = null;
  let loadWaitTimer = null;
  let showSaveForm = $state(false);
  let saveTitle = $state("");
  let saveNote = $state("");
  let renameId = $state(null);
  let renameTitle = $state("");
  let renameNote = $state("");
  let savingRename = $state(false);
  let deleteConfirmationId = $state(null);
  let clearConfirmation = $state(false);
  let loadToken = 0;

  const canSave = $derived(currentSession?.status === "structured");
  const canMutate = $derived(repository !== null && storageState?.available === true && loadState === "ready");
  const saveGateMessage = $derived.by(() => {
    if (!canSave) return t("snapshot.save.requiresStructured");
    if (repository === null || storageState?.available !== true) return t("snapshot.storage.unavailable");
    if (loadState === "loading" || loadState === "initializing") return t("snapshot.loading");
    if (loadState === "error") return `${t("snapshot.loadFailed")} ${getErrorMessage(loadError)}`;
    if (loadState !== "ready") return t("snapshot.storage.unavailable");
    return null;
  });
  const orderedSnapshots = $derived([...snapshots].sort((left, right) => right.savedAt.localeCompare(left.savedAt)));

  $effect(() => {
    const currentRepository = repository;
    const currentStorageState = storageState;
    if (currentRepository === null) {
      loadToken += 1;
      if (loadWaitTimer !== null) clearTimeout(loadWaitTimer);
      loadWaitTimer = null;
      loadPendingLonger = false;
      snapshots = [];
      loadError = null;
      loadState = currentStorageState?.state === "initializing" ? "initializing" : "unavailable";
      return;
    }
    void refresh(currentRepository);
  });

  async function refresh(target = repository) {
    if (target === null) return null;
    const token = ++loadToken;
    if (loadWaitTimer !== null) clearTimeout(loadWaitTimer);
    loadPendingLonger = false;
    loadState = "loading";
    loadError = null;
    const waitTimer = setTimeout(() => {
      if (token === loadToken && loadState === "loading") loadPendingLonger = true;
    }, 10_000);
    loadWaitTimer = waitTimer;
    try {
      const nextSnapshots = await target.list();
      if (token !== loadToken) return null;
      snapshots = nextSnapshots;
      if (baselineSnapshotId !== null && !nextSnapshots.some((snapshot) => snapshot.snapshotId === baselineSnapshotId)) {
        onSelectBaseline(null);
      }
      loadState = "ready";
      return nextSnapshots;
    } catch (error) {
      if (token !== loadToken) return null;
      loadError = error;
      loadState = "error";
      return null;
    } finally {
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

  function setSaving(value) {
    saving = value;
    savePendingLonger = false;
    if (saveWaitTimer !== null) clearTimeout(saveWaitTimer);
    saveWaitTimer = null;
    if (value) {
      saveWaitTimer = setTimeout(() => {
        saveWaitTimer = null;
        if (saving) savePendingLonger = true;
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
    onSuccess: () => {
      showSaveForm = false;
      saveTitle = "";
      saveNote = "";
      statusMessage = t("snapshot.saved");
    },
    refresh,
  });

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
      deleteConfirmationId = null;
      onOpenSnapshot(snapshot);
    } catch (error) {
      operationError = error;
      if (error?.code === "SNAPSHOT_STORAGE_CONFLICT" || error?.code === "SNAPSHOT_NOT_FOUND") await refresh(repository);
    }
  }

  function selectBaseline(snapshotId) {
    clearOperationFeedback();
    if (!canMutate) return;
    onSelectBaseline(baselineSnapshotId === snapshotId ? null : snapshotId);
  }

  function beginRename(snapshot) {
    clearOperationFeedback();
    renameId = snapshot.snapshotId;
    renameTitle = snapshot.title;
    renameNote = snapshot.note;
  }

  async function saveRename(event, snapshotId) {
    event.preventDefault();
    clearOperationFeedback();
    if (!canMutate || savingRename) return;

    savingRename = true;
    try {
      const updated = await repository.rename(snapshotId, renameTitle.trim(), renameNote);
      snapshots = snapshots.map((snapshot) => snapshot.snapshotId === snapshotId ? updated : snapshot);
      onUpdateSnapshot(updated);
      renameId = null;
      statusMessage = t("snapshot.updated");
    } catch (error) {
      operationError = error;
      if (error?.code === "SNAPSHOT_STORAGE_CONFLICT") await refresh(repository);
    } finally {
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
        onDeleteSnapshot(snapshotId);
        statusMessage = t("snapshot.deleted");
      }
      await refresh(repository);
    } catch (error) {
      operationError = error;
      if (error?.code === "SNAPSHOT_STORAGE_CONFLICT") await refresh(repository);
    }
  }

  async function clearSnapshots() {
    clearOperationFeedback();
    if (!canMutate) return;
    try {
      const count = await repository.clear();
      clearConfirmation = false;
      if (count > 0) {
        onClearSnapshots();
        statusMessage = t("snapshot.cleared", { count });
      }
      await refresh(repository);
    } catch (error) {
      operationError = error;
      if (error?.code === "SNAPSHOT_STORAGE_CONFLICT") await refresh(repository);
    }
  }
</script>

<section class="panel snapshot-manager" aria-labelledby="snapshot-manager-title">
  <header class="snapshot-manager-head">
    <div>
      <h2 id="snapshot-manager-title">{t("snapshot.manager.title")}</h2>
      <p class="snapshot-manager-hint">{t("snapshot.manager.description")}</p>
      <p class="snapshot-manager-warning">{t("snapshot.manager.concurrentWarning")}</p>
    </div>
    {#if canSave}
      <button
        type="button"
        class="snapshot-primary"
        disabled={!canMutate}
        onclick={() => { clearSaveFeedback(); showSaveForm = !showSaveForm; }}
      >{t("snapshot.save.open")}</button>
    {:else}
      <button type="button" class="snapshot-primary" disabled title={t("snapshot.save.requiresStructured")}>{t("snapshot.save.open")}</button>
    {/if}
  </header>

  {#if saveGateMessage !== null}
    <p id="snapshot-save-gate" class="snapshot-save-gate" role="status">{saveGateMessage}</p>
  {/if}
  {#if operationError}
    <p class="snapshot-feedback error" role="alert">{getErrorMessage(operationError)}</p>
  {/if}
  {#if statusMessage}
    <p class="snapshot-feedback success" role="status" aria-live="polite">{statusMessage}</p>
  {/if}

  {#if showSaveForm}
    <form class="snapshot-form" onsubmit={saveCurrent}>
      <p class="snapshot-privacy-note">{t("snapshot.save.localWarning")}</p>
      <label>
        <span>{t("snapshot.field.title")}</span>
        <input bind:value={saveTitle} maxlength="120" required autocomplete="off" disabled={saving} />
      </label>
      <label>
        <span>{t("snapshot.field.note")}</span>
        <textarea bind:value={saveNote} maxlength="2000" rows="2" disabled={saving}></textarea>
      </label>
      <div class="snapshot-actions">
        <button type="submit" class="snapshot-primary" disabled={!canMutate || !canSave || saving || saveTitle.trim().length === 0}>
          {saving ? t("snapshot.save.saving") : t("snapshot.save.confirm")}
        </button>
        <button type="button" class="snapshot-secondary" disabled={saving} onclick={() => (showSaveForm = false)}>{t("snapshot.cancel")}</button>
      </div>
      {#if saving && savePendingLonger}
        <p class="snapshot-feedback snapshot-save-pending" role="status" aria-live="polite">{t("snapshot.save.pendingDiagnostic")}</p>
      {/if}
      {#if saveError}
        <p class="snapshot-feedback error snapshot-save-error" role="alert">{getErrorMessage(saveError)}</p>
      {/if}
    </form>
  {/if}

  {#if storageState?.state === "initializing" && repository === null}
    <p class="snapshot-empty" role="status">{t("snapshot.storage.initializing")}</p>
  {:else if storageState?.available !== true}
    <p class="snapshot-empty" role="status">{t("snapshot.storage.unavailable")}</p>
  {:else if loadState === "loading"}
    <div class="snapshot-empty snapshot-loading" role="status" aria-live="polite">
      <p>{t("snapshot.loading")}</p>
      {#if loadPendingLonger}<p>{t("snapshot.loading.pendingDiagnostic")}</p>{/if}
    </div>
  {:else if loadState === "error"}
    <div class="snapshot-empty snapshot-load-error" role="alert">
      <p>{t("snapshot.loadFailed")}</p>
      <p>{getErrorMessage(loadError)}</p>
      <button type="button" class="snapshot-secondary" onclick={() => refresh()}>{t("snapshot.retry")}</button>
    </div>
  {:else if orderedSnapshots.length === 0}
    <p class="snapshot-empty">{t("snapshot.empty")}</p>
  {:else}
    <div class="snapshot-list-head">
      <span>{t("snapshot.list.count", { count: orderedSnapshots.length })}</span>
      {#if canMutate}
        {#if clearConfirmation}
          <div class="snapshot-confirm-inline" role="group" aria-label={t("snapshot.clear.confirmLabel")}>
            <span>{t("snapshot.clear.confirm", { count: orderedSnapshots.length })}</span>
            <button type="button" class="snapshot-danger" onclick={clearSnapshots}>{t("snapshot.clear.confirmAction")}</button>
            <button type="button" class="snapshot-secondary" onclick={() => (clearConfirmation = false)}>{t("snapshot.cancel")}</button>
          </div>
        {:else}
          <button type="button" class="snapshot-text-button" onclick={() => { clearOperationFeedback(); clearConfirmation = true; }}>
            {t("snapshot.clear.open")}
          </button>
        {/if}
      {/if}
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
              <span>{t("snapshot.meta.database", { database: snapshot.rawInput.database, version: snapshot.rawInput.databaseVersion ?? t("snapshot.unknown") })}</span>
              <span>{t("snapshot.meta.savedAt", { time: formatPlanSnapshotTime(snapshot.savedAt, locale) ?? t("snapshot.unknown") })}</span>
              <span>{t("snapshot.meta.capturedAt", { time: formatPlanSnapshotTime(snapshot.capturedAt, locale) ?? t("snapshot.unknown") })}</span>
              {#if snapshot.source.databaseName || snapshot.source.schema}
                <span>{t("snapshot.meta.source", { source: [snapshot.source.databaseName, snapshot.source.schema].filter(Boolean).join(" / ") })}</span>
              {/if}
              {#if snapshot.producerVersion}<span>{t("snapshot.meta.producer", { version: snapshot.producerVersion })}</span>{/if}
            </div>
            <p class="snapshot-note">{snapshot.note || t("snapshot.noNote")}</p>
          </div>

          {#if renameId === snapshot.snapshotId}
            <form class="snapshot-form snapshot-rename-form" onsubmit={(event) => saveRename(event, snapshot.snapshotId)}>
              <label>
                <span>{t("snapshot.field.title")}</span>
                <input bind:value={renameTitle} maxlength="120" required autocomplete="off" />
              </label>
              <label>
                <span>{t("snapshot.field.note")}</span>
                <textarea bind:value={renameNote} maxlength="2000" rows="2"></textarea>
              </label>
              <div class="snapshot-actions">
                <button type="submit" class="snapshot-primary" disabled={!canMutate || savingRename || renameTitle.trim().length === 0}>
                  {savingRename ? t("snapshot.rename.saving") : t("snapshot.rename.save")}
                </button>
                <button type="button" class="snapshot-secondary" disabled={savingRename} onclick={() => (renameId = null)}>{t("snapshot.cancel")}</button>
              </div>
            </form>
          {:else if deleteConfirmationId === snapshot.snapshotId}
            <div class="snapshot-confirm-inline" role="group" aria-label={t("snapshot.delete.confirmLabel")}>
              <span>{t("snapshot.delete.confirm", { title: snapshot.title })}</span>
              <button type="button" class="snapshot-danger" onclick={() => deleteSnapshot(snapshot.snapshotId)}>{t("snapshot.delete.confirmAction")}</button>
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

<style>
  .snapshot-manager {
    margin: 0 0 var(--pd-layout-gap);
    padding: 12px;
  }

  .snapshot-manager-head,
  .snapshot-list-head,
  .snapshot-item-title-row,
  .snapshot-actions,
  .snapshot-item-actions,
  .snapshot-confirm-inline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
  }

  .snapshot-manager-head,
  .snapshot-list-head {
    justify-content: space-between;
  }

  .snapshot-manager-head h2 {
    margin: 0;
    font-size: 14px;
  }

  .snapshot-manager-hint,
  .snapshot-empty,
  .snapshot-feedback,
  .snapshot-note {
    margin: 4px 0 0;
    color: var(--pd-muted);
    font-size: 12px;
  }

  .snapshot-manager-warning {
    margin: 4px 0 0;
    color: var(--pd-warning-fg);
    font-size: 12px;
  }

  .snapshot-save-gate {
    margin: 6px 0 0;
    color: var(--pd-muted);
    font-size: 12px;
  }

  .snapshot-save-error,
  .snapshot-save-pending {
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
    min-height: 30px;
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

  .snapshot-form {
    display: grid;
    gap: 9px;
    margin: 10px 0;
    padding: 10px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface-muted);
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

  .snapshot-load-error p {
    margin: 4px 0;
  }

  .snapshot-list-head {
    margin-top: 10px;
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
    background: var(--pd-surface);
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
    white-space: pre-wrap;
    overflow-wrap: anywhere;
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
    .snapshot-manager-head {
      align-items: flex-start;
    }

    .snapshot-manager-head .snapshot-primary {
      width: 100%;
    }

    .snapshot-item-actions > button {
      flex: 1 1 100px;
    }
  }
</style>
