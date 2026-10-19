import { createPlanSnapshot } from "./plan-snapshot.js";
import { PlanSnapshotStoreError } from "./plan-snapshot-store.js";

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
    clearFeedback();

    if (inFlight) {
      setDuplicateMessage();
      return { status: "in-progress" };
    }

    const state = getState();
    if (state.repository === null || state.storageAvailable !== true) {
      setError(new PlanSnapshotStoreError("STORAGE_API_UNAVAILABLE", "DBX Host Storage is unavailable or not granted."));
      return { status: "blocked" };
    }
    if (state.loadState !== "ready") {
      setError(state.loadState === "error" && state.loadError
        ? state.loadError
        : new PlanSnapshotStoreError("SNAPSHOT_LIST_NOT_READY", "The snapshot list must finish loading before a save."));
      return { status: "blocked" };
    }
    if (state.currentSession?.status !== "structured") {
      setError(new PlanSnapshotStoreError("SNAPSHOT_NOT_COMPARABLE", "Complete a structured Estimated Plan before saving."));
      return { status: "blocked" };
    }

    inFlight = true;
    setSaving(true);
    let snapshot = null;
    try {
      snapshot = createSnapshot({
        session: state.currentSession,
        title: state.saveTitle.trim(),
        note: state.saveNote,
        producerVersion: state.producerVersion,
      });
      await state.repository.save(snapshot);
      await refresh(state.repository);
      onSuccess(snapshot);
      return { status: "saved", snapshot };
    } catch (error) {
      if (error?.code === "SNAPSHOT_WRITE_UNCONFIRMED" && snapshot !== null) {
        const refreshed = await refresh(state.repository).catch(() => null);
        if (Array.isArray(refreshed) && refreshed.some((entry) => entry.snapshotId === snapshot.snapshotId)) {
          onSuccess(snapshot);
          return { status: "saved", snapshot, confirmedAfterUncertainWrite: true };
        }
      } else if (error?.code === "SNAPSHOT_STORAGE_CONFLICT") {
        await refresh(state.repository);
      }
      setError(error);
      return { status: "failed", error };
    } finally {
      inFlight = false;
      setSaving(false);
    }
  };
}
