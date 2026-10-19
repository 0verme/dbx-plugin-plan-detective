import {
  getPluginStorageValue,
  HostStorageError,
  PLUGIN_STORAGE_MAX_VALUE_BYTES,
  setPluginStorageValue,
} from "../host/dbx-plugin-storage.js";
import { validatePlanSnapshot } from "./plan-snapshot.js";

export const PLAN_SNAPSHOT_STORAGE_KEY = "plan-detective.snapshot-store.v1";
export const PLAN_SNAPSHOT_STORE_SCHEMA_VERSION = 1;
/** Reserve 64 KiB below DBX's 256 KiB single-value cap for future plugin settings. */
export const MAX_PLAN_SNAPSHOT_STORE_BYTES = 192 * 1024;
/** Refuse one record larger than half of the plugin-owned snapshot budget. */
export const MAX_PLAN_SNAPSHOT_RECORD_BYTES = 128 * 1024;

const STORE_KEYS = ["storageSchemaVersion", "revision", "lastMutationId", "snapshots"];
const BRIDGE_QUEUES = new WeakMap();

/** Stable errors for snapshot repository callers; messages never include plan data. */
export class PlanSnapshotStoreError extends Error {
  /** @param {string} code @param {string} message @param {string|null} [hostMessage] */
  constructor(code, message, hostMessage = null) {
    super(message);
    this.name = "PlanSnapshotStoreError";
    this.code = code;
    this.hostMessage = hostMessage;
  }
}

/**
 * Create the repository over DBX's public key/value Storage API.
 * One versioned document keeps snapshot records and their list/index atomic in
 * the host's single-key write. Queues serialize writes within one bridge object.
 *
 * @param {object} bridge resolved `window.dbxPlugin` bridge
 */
export function createPlanSnapshotRepository(bridge) {
  if (bridge === null || typeof bridge !== "object") {
    throw new PlanSnapshotStoreError("STORAGE_API_UNAVAILABLE", "DBX Host Storage is unavailable.");
  }

  return Object.freeze({
    list: () => serializeForBridge(bridge, async () => (await loadStore(bridge)).snapshots),
    get: (snapshotId) => serializeForBridge(bridge, async () => {
      requireSnapshotId(snapshotId);
      return (await loadStore(bridge)).snapshots.find((entry) => entry.snapshotId === snapshotId) ?? null;
    }),
    save: (snapshot) => serializeForBridge(bridge, () => saveSnapshot(bridge, snapshot)),
    rename: (snapshotId, title, note) => serializeForBridge(bridge, () => renameSnapshot(bridge, snapshotId, title, note)),
    delete: (snapshotId) => serializeForBridge(bridge, () => deleteSnapshot(bridge, snapshotId)),
    clear: () => serializeForBridge(bridge, () => clearSnapshots(bridge)),
  });
}

async function saveSnapshot(bridge, candidate) {
  const snapshot = normalizeSnapshot(candidate);
  assertRecordSize(snapshot);
  return mutateStore(bridge, (snapshots) => {
    if (snapshots.some((entry) => entry.snapshotId === snapshot.snapshotId)) {
      throw new PlanSnapshotStoreError("SNAPSHOT_ALREADY_EXISTS", "A snapshot with this identifier already exists; existing data was not overwritten.");
    }
    return { snapshots: [...snapshots, snapshot], result: snapshot };
  });
}

async function renameSnapshot(bridge, snapshotId, title, note) {
  requireSnapshotId(snapshotId);
  return mutateStore(bridge, (snapshots) => {
    const index = snapshots.findIndex((entry) => entry.snapshotId === snapshotId);
    if (index < 0) throw new PlanSnapshotStoreError("SNAPSHOT_NOT_FOUND", "The requested snapshot does not exist.");
    const renamed = normalizeSnapshot({
      ...snapshots[index],
      title,
      note: note === undefined ? snapshots[index].note : note,
    });
    assertRecordSize(renamed);
    const next = [...snapshots];
    next[index] = renamed;
    return { snapshots: next, result: renamed };
  });
}

async function deleteSnapshot(bridge, snapshotId) {
  requireSnapshotId(snapshotId);
  return mutateStore(bridge, (snapshots) => {
    const next = snapshots.filter((entry) => entry.snapshotId !== snapshotId);
    if (next.length === snapshots.length) return { snapshots, result: false, unchanged: true };
    return { snapshots: next, result: true };
  });
}

async function clearSnapshots(bridge) {
  return mutateStore(bridge, (snapshots) => {
    if (snapshots.length === 0) return { snapshots, result: 0, unchanged: true };
    return { snapshots: [], result: snapshots.length };
  });
}

async function mutateStore(bridge, mutate) {
  const base = await loadStore(bridge);
  const baseFingerprint = fingerprint(base);
  const change = mutate(base.snapshots);
  if (change.unchanged === true) return change.result;
  if (base.revision >= Number.MAX_SAFE_INTEGER) {
    throw new PlanSnapshotStoreError("SNAPSHOT_STORE_REVISION_EXHAUSTED", "Snapshot store revision cannot be advanced safely.");
  }

  const mutationId = createMutationId();
  const candidate = {
    storageSchemaVersion: PLAN_SNAPSHOT_STORE_SCHEMA_VERSION,
    revision: base.revision + 1,
    lastMutationId: mutationId,
    snapshots: change.snapshots,
  };
  const candidateFingerprint = fingerprint(candidate);
  const candidateBytes = utf8ByteLength(candidateFingerprint);
  if (candidateBytes > MAX_PLAN_SNAPSHOT_STORE_BYTES) {
    throw new PlanSnapshotStoreError("SNAPSHOT_STORE_FULL", `Snapshot storage is limited to ${MAX_PLAN_SNAPSHOT_STORE_BYTES} UTF-8 bytes; remove older snapshots before retrying.`);
  }
  if (candidateBytes > PLUGIN_STORAGE_MAX_VALUE_BYTES) {
    throw new PlanSnapshotStoreError("SNAPSHOT_STORE_FULL", "Snapshot storage exceeds the DBX per-value capacity.");
  }

  // Optimistically detect another window's completed update before writing.
  // DBX storage has no compare-and-swap operation, so this check narrows but
  // cannot mathematically eliminate a race between this read and the next set.
  const observed = await loadStore(bridge);
  if (fingerprint(observed) !== baseFingerprint) {
    throw concurrentModification();
  }

  try {
    await setPluginStorageValue(bridge, PLAN_SNAPSHOT_STORAGE_KEY, candidate);
  } catch (writeError) {
    // A transport failure may occur after the host committed the atomic value.
    // Re-read (read-only) to distinguish our exact commit, a competing update,
    // an unchanged document, and an outcome that the host still cannot confirm.
    const outcome = await readMutationOutcome(bridge, candidateFingerprint, baseFingerprint);
    if (outcome === "candidate") return change.result;
    if (outcome === "other") throw concurrentModification();
    throw wrapStorageError(writeError);
  }

  // Even when set resolves, verify the host's persisted value. If the first
  // read is inconclusive, read once more; never retry the write itself.
  const outcome = await readMutationOutcome(bridge, candidateFingerprint, baseFingerprint);
  if (outcome === "candidate") return change.result;
  if (outcome === "other") throw concurrentModification();
  throw writeOutcomeUnknown();
}

async function readMutationOutcome(bridge, candidateFingerprint, baseFingerprint) {
  let lastReadError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let persisted;
    try {
      persisted = await loadStore(bridge);
      lastReadError = null;
    } catch (error) {
      lastReadError = error;
      continue;
    }
    const persistedFingerprint = fingerprint(persisted);
    if (persistedFingerprint === candidateFingerprint) return "candidate";
    if (persistedFingerprint !== baseFingerprint) return "other";
    if (attempt === 1) return "base";
  }
  if (lastReadError !== null) throw writeOutcomeUnknown(lastReadError);
  return "base";
}

async function loadStore(bridge) {
  let value;
  try {
    value = await getPluginStorageValue(bridge, PLAN_SNAPSHOT_STORAGE_KEY);
  } catch (error) {
    throw wrapStorageError(error);
  }
  if (value === null) return emptyStore();
  return normalizeStore(value);
}

function normalizeStore(value) {
  if (!isPlainObject(value)) throw corruptStore("Stored snapshot document must be a plain object.");
  if (!Number.isInteger(value.storageSchemaVersion) || value.storageSchemaVersion < 1) {
    throw corruptStore("Stored snapshot document has an invalid schema version.");
  }
  if (value.storageSchemaVersion !== PLAN_SNAPSHOT_STORE_SCHEMA_VERSION) {
    throw new PlanSnapshotStoreError("UNSUPPORTED_STORE_VERSION", `Snapshot store schema version ${value.storageSchemaVersion} is not supported; stored data was left untouched.`);
  }
  assertExactKeys(value, STORE_KEYS, "Stored snapshot document");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw corruptStore("Stored snapshot revision is invalid.");
  if (value.lastMutationId !== null && (typeof value.lastMutationId !== "string" || value.lastMutationId.length === 0 || value.lastMutationId.length > 128)) {
    throw corruptStore("Stored snapshot mutation metadata is invalid.");
  }
  if (!Array.isArray(value.snapshots)) throw corruptStore("Stored snapshot list is invalid.");

  const snapshots = value.snapshots.map((entry) => {
    const validation = validatePlanSnapshot(entry);
    if (!validation.valid) {
      const code = validation.code === "UNSUPPORTED_SNAPSHOT_VERSION" ? validation.code : "CORRUPT_SNAPSHOT_STORE";
      throw new PlanSnapshotStoreError(code, validation.message);
    }
    return validation.snapshot;
  });
  const ids = new Set();
  for (const snapshot of snapshots) {
    if (ids.has(snapshot.snapshotId)) throw corruptStore("Stored snapshot identifiers are not unique.");
    ids.add(snapshot.snapshotId);
  }

  return {
    storageSchemaVersion: PLAN_SNAPSHOT_STORE_SCHEMA_VERSION,
    revision: value.revision,
    lastMutationId: value.lastMutationId,
    snapshots,
  };
}

function normalizeSnapshot(snapshot) {
  const validation = validatePlanSnapshot(snapshot);
  if (!validation.valid) {
    throw new PlanSnapshotStoreError(validation.code, validation.message);
  }
  return validation.snapshot;
}

function assertRecordSize(snapshot) {
  const serialized = JSON.stringify(snapshot);
  if (utf8ByteLength(serialized) > MAX_PLAN_SNAPSHOT_RECORD_BYTES) {
    throw new PlanSnapshotStoreError("SNAPSHOT_TOO_LARGE", `One plan snapshot is limited to ${MAX_PLAN_SNAPSHOT_RECORD_BYTES} UTF-8 bytes.`);
  }
}

function requireSnapshotId(snapshotId) {
  if (typeof snapshotId !== "string" || snapshotId.length === 0 || snapshotId.length > 128) {
    throw new PlanSnapshotStoreError("INVALID_SNAPSHOT_ID", "Snapshot identifier is invalid.");
  }
}

function assertExactKeys(value, keys, label) {
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw corruptStore(`${label} contains an unsupported field.`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw corruptStore(`${label} is missing a required field.`);
  }
}

function emptyStore() {
  return {
    storageSchemaVersion: PLAN_SNAPSHOT_STORE_SCHEMA_VERSION,
    revision: 0,
    lastMutationId: null,
    snapshots: [],
  };
}

function fingerprint(value) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") throw new Error("not serializable");
    return serialized;
  } catch {
    throw corruptStore("Snapshot storage contains data that cannot be encoded as JSON.");
  }
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function createMutationId() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  throw new PlanSnapshotStoreError("SNAPSHOT_ID_UNAVAILABLE", "Secure randomness is unavailable for snapshot storage updates.");
}

function serializeForBridge(bridge, operation) {
  const previous = BRIDGE_QUEUES.get(bridge) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  BRIDGE_QUEUES.set(bridge, result.then(() => undefined, () => undefined));
  return result;
}

function concurrentModification() {
  return new PlanSnapshotStoreError("SNAPSHOT_STORAGE_CONFLICT", "Snapshot storage changed in another window. Reload the snapshot list; no automatic retry or merge was attempted.");
}

function writeOutcomeUnknown(error = null) {
  const diagnostic = error === null ? null : wrapStorageError(error);
  return new PlanSnapshotStoreError(
    "SNAPSHOT_WRITE_UNCONFIRMED",
    "DBX did not confirm whether the snapshot update was committed; reload history before retrying.",
    diagnostic?.hostMessage ?? null,
  );
}

function corruptStore(message) {
  return new PlanSnapshotStoreError("CORRUPT_SNAPSHOT_STORE", message);
}

function wrapStorageError(error) {
  if (error instanceof PlanSnapshotStoreError) return error;
  if (error instanceof HostStorageError) return new PlanSnapshotStoreError(error.code, error.message, error.hostMessage);
  return new PlanSnapshotStoreError("HOST_STORAGE_ERROR", "DBX Host Storage operation failed.", error instanceof Error ? error.message : String(error));
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
