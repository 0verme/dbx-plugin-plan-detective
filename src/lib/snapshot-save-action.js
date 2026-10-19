import { createPlanSnapshot } from "./plan-snapshot.js";
import { PlanSnapshotStoreError } from "./plan-snapshot-store.js";
import {
  beginSnapshotSaveTrace,
  finishSnapshotDiagnosticStage,
  finishSnapshotDiagnosticTrace,
  recordSnapshotDiagnosticEvent,
  snapshotDiagnosticErrorFields,
  startSnapshotDiagnosticStage,
  withSnapshotDiagnosticStage,
} from "./snapshot-diagnostic-trace.js";

/**
 * Create the snapshot form submit handler so its guards, persistence, and
 * feedback can be exercised without a browser or DBX Desktop runtime.
 */
export function createSnapshotSaveHandler({
  getState,
  setSaving,
  clearFeedback,
  setDuplicateMessage,
  setError,
  onSuccess,
  refresh,
  createSnapshot = createPlanSnapshot,
}) {
  let inFlight = false;

  return async function saveCurrent(event) {
    event.preventDefault();
    const state = getState();
    const trace = beginSnapshotSaveTrace({
      storageAvailable: state.storageAvailable === true,
      sessionStructured: state.currentSession?.status === "structured",
      loadState: state.loadState,
      titlePresent: typeof state.saveTitle === "string" && state.saveTitle.trim().length > 0,
    });
    clearFeedback();

    const gateStage = startSnapshotDiagnosticStage(trace, "SNAPSHOT_SAVE_GATE", {
      storageAvailable: state.storageAvailable === true,
      sessionStructured: state.currentSession?.status === "structured",
      loadState: state.loadState,
    });

    if (inFlight) {
      const fields = { errorCode: "DUPLICATE_SUBMISSION", failedStage: "save.gate" };
      finishSnapshotDiagnosticStage(gateStage, "blocked", fields);
      recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_SAVE_GATE", "blocked", fields);
      setDuplicateMessage();
      recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_UI_ERROR", "blocked", fields);
      finishSnapshotDiagnosticTrace(trace, "blocked");
      return { status: "in-progress" };
    }

    let blockedError = null;
    if (state.repository === null || state.storageAvailable !== true) {
      blockedError = new PlanSnapshotStoreError("STORAGE_API_UNAVAILABLE", "DBX Host Storage is unavailable or not granted.");
    } else if (state.loadState !== "ready") {
      blockedError = state.loadState === "error" && state.loadError
        ? state.loadError
        : new PlanSnapshotStoreError("SNAPSHOT_LIST_NOT_READY", "The snapshot list must finish loading before a save.");
    } else if (state.currentSession?.status !== "structured") {
      blockedError = new PlanSnapshotStoreError("SNAPSHOT_NOT_COMPARABLE", "Complete a structured Estimated Plan before saving.");
    }

    if (blockedError !== null) {
      const fields = { ...snapshotDiagnosticErrorFields(blockedError, "save.gate"), loadState: state.loadState };
      finishSnapshotDiagnosticStage(gateStage, "blocked", fields);
      recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_SAVE_GATE", "blocked", fields);
      setError(blockedError);
      recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_UI_ERROR", "failed", fields);
      finishSnapshotDiagnosticTrace(trace, "failed");
      return { status: "blocked" };
    }

    finishSnapshotDiagnosticStage(gateStage, "success");
    recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_SAVE_GATE", "success", {
      storageAvailable: true,
      sessionStructured: true,
      loadState: "ready",
    });

    inFlight = true;
    setSaving(true, trace);
    let snapshot = null;
    try {
      snapshot = await withSnapshotDiagnosticStage(trace, "SNAPSHOT_CREATE", () => createSnapshot({
        session: state.currentSession,
        title: state.saveTitle.trim(),
        note: state.saveNote,
        producerVersion: state.producerVersion,
      }), { failedStage: "snapshot.create" });

      await withSnapshotDiagnosticStage(
        trace,
        "SNAPSHOT_REPOSITORY_SAVE",
        () => state.repository.save(snapshot, { trace }),
        { failedStage: "repository.save" },
      );

      try {
        onSuccess(snapshot);
      } catch (error) {
        const fields = { ...snapshotDiagnosticErrorFields(error, "ui.update") };
        setError(error);
        recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_UI_ERROR", "failed", fields);
        finishSnapshotDiagnosticTrace(trace, "failed");
        return { status: "failed", error, persisted: true };
      }

      recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_UI_SUCCESS", "success", {
        storageAvailable: true,
        sessionStructured: true,
      });
      finishSnapshotDiagnosticTrace(trace, "completed");
      void refresh(state.repository, { trace, operation: "post-save" })?.catch?.(() => {});
      return { status: "saved", snapshot };
    } catch (error) {
      const errorFields = snapshotDiagnosticErrorFields(error, "repository.save");
      if (error?.code === "SNAPSHOT_WRITE_UNCONFIRMED" && snapshot !== null) {
        const refreshed = await refresh(state.repository, { trace, operation: "verification" }).catch(() => null);
        if (Array.isArray(refreshed) && refreshed.some((entry) => entry.snapshotId === snapshot.snapshotId)) {
          try {
            onSuccess(snapshot);
          } catch (uiError) {
            const fields = snapshotDiagnosticErrorFields(uiError, "ui.update");
            setError(uiError);
            recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_UI_ERROR", "failed", fields);
            finishSnapshotDiagnosticTrace(trace, "failed");
            return { status: "failed", error: uiError, persisted: true };
          }
          recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_UI_SUCCESS", "success", {
            storageAvailable: true,
            sessionStructured: true,
          });
          finishSnapshotDiagnosticTrace(trace, "completed");
          return { status: "saved", snapshot, confirmedAfterUncertainWrite: true };
        }
      } else if (error?.code === "SNAPSHOT_STORAGE_CONFLICT") {
        setError(error);
        recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_UI_ERROR", "failed", errorFields);
        finishSnapshotDiagnosticTrace(trace, "failed");
        void refresh(state.repository, { trace, operation: "verification" })?.catch?.(() => {});
        return { status: "failed", error };
      }
      setError(error);
      recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_UI_ERROR", "failed", errorFields);
      finishSnapshotDiagnosticTrace(trace, "failed");
      return { status: "failed", error };
    } finally {
      inFlight = false;
      setSaving(false, trace);
    }
  };
}
