import { createRawPlanInput } from "../core/raw-plan-input.js";
import { PlanInputError } from "../core/errors.js";

export const PLAN_SNAPSHOT_SCHEMA_VERSION = 1;
export const PLAN_SNAPSHOT_TITLE_MAX_LENGTH = 120;
export const PLAN_SNAPSHOT_NOTE_MAX_LENGTH = 2_000;

const SNAPSHOT_KEYS = [
  "schemaVersion",
  "snapshotId",
  "savedAt",
  "capturedAt",
  "title",
  "note",
  "producerVersion",
  "rawInput",
  "source",
];
const RAW_INPUT_KEYS = ["database", "mode", "format", "plan", "sql", "databaseVersion"];
const SOURCE_KEYS = ["databaseName", "schema"];

/** A stable, payload-free error contract for snapshot callers. */
export class PlanSnapshotError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "PlanSnapshotError";
    this.code = code;
  }
}

/**
 * Build a persistence-safe snapshot from one completed analysis session.
 * Only whitelisted values cross this boundary; Host bridges, connections,
 * capability objects and lifecycle state are never retained.
 *
 * @param {{session: object, title: string, note?: string, producerVersion?: string|null, snapshotId?: string, now?: (() => Date)|Date}} input
 */
export function createPlanSnapshot({ session, title, note = "", producerVersion = null, snapshotId, now = () => new Date() }) {
  if (!session || session.status !== "structured" || session.analysis?.status !== "structured" || session.hostResult?.truncated === true) {
    throw new PlanSnapshotError("SNAPSHOT_NOT_COMPARABLE", "Only a complete, successfully structured plan can be saved as a comparable snapshot.");
  }

  let rawInput;
  try {
    rawInput = createRawPlanInput(session.rawInput);
  } catch (error) {
    throw new PlanSnapshotError(
      "INVALID_SNAPSHOT_INPUT",
      error instanceof PlanInputError ? "The completed analysis session has an invalid RawPlanInput." : "The completed analysis session cannot be saved.",
    );
  }
  if (rawInput.mode !== "estimated") {
    throw new PlanSnapshotError("SNAPSHOT_NOT_COMPARABLE", "Only complete Estimated plans can be saved as comparable snapshots.");
  }
  assertPlanMatchesFormat(rawInput);

  const timestamp = typeof now === "function" ? now() : now;
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    throw new PlanSnapshotError("INVALID_SNAPSHOT_METADATA", "Snapshot save time must be a valid Date.");
  }

  const envelope = {
    schemaVersion: PLAN_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: requireText(snapshotId ?? createSnapshotId(), "snapshotId", 128),
    savedAt: timestamp.toISOString(),
    capturedAt: session.capturedAt ?? null,
    title,
    note,
    producerVersion,
    rawInput: cloneRawInput(rawInput),
    source: selectSource(session.source),
  };

  return normalizePlanSnapshot(envelope);
}

/**
 * Validate without throwing so storage/UI adapters can present a stable error.
 * @param {unknown} value
 * @returns {{valid: true, snapshot: object}|{valid: false, code: string, message: string}}
 */
export function validatePlanSnapshot(value) {
  try {
    return { valid: true, snapshot: normalizePlanSnapshot(value) };
  } catch (error) {
    const snapshotError = asSnapshotError(error);
    return { valid: false, code: snapshotError.code, message: snapshotError.message };
  }
}

/** Serialize a validated snapshot without lossy JSON coercions. */
export function serializePlanSnapshot(value) {
  const snapshot = normalizePlanSnapshot(value);
  return JSON.stringify(snapshot);
}

/** Parse and validate a serialized snapshot. Unknown versions are not migrated or discarded. */
export function deserializePlanSnapshot(serialized) {
  if (typeof serialized !== "string") {
    throw new PlanSnapshotError("CORRUPT_SNAPSHOT", "Stored snapshot must be serialized text.");
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new PlanSnapshotError("CORRUPT_SNAPSHOT", "Stored snapshot is not valid JSON.");
  }
  return normalizePlanSnapshot(value);
}

function normalizePlanSnapshot(value) {
  if (!isPlainObject(value)) {
    throw invalidSnapshot("Snapshot must be a plain object.");
  }
  if (!Number.isInteger(value.schemaVersion) || value.schemaVersion < 1) {
    throw invalidSnapshot("Snapshot schemaVersion must be a positive integer.");
  }
  if (value.schemaVersion !== PLAN_SNAPSHOT_SCHEMA_VERSION) {
    throw new PlanSnapshotError("UNSUPPORTED_SNAPSHOT_VERSION", `Snapshot schema version ${value.schemaVersion} is not supported.`);
  }
  assertExactKeys(value, SNAPSHOT_KEYS, "Snapshot");

  let rawInput;
  try {
    assertExactKeys(value.rawInput, RAW_INPUT_KEYS.filter((key) => Object.hasOwn(value.rawInput ?? {}, key)), "Snapshot RawPlanInput");
    rawInput = createRawPlanInput(value.rawInput);
  } catch (error) {
    if (error instanceof PlanSnapshotError) throw error;
    throw invalidSnapshot("Snapshot RawPlanInput is invalid.");
  }
  if (rawInput.mode !== "estimated") {
    throw new PlanSnapshotError("SNAPSHOT_NOT_COMPARABLE", "Only Estimated plans are valid comparable snapshots.");
  }
  assertPlanMatchesFormat(rawInput);
  assertJsonValue(rawInput.plan);

  const snapshotId = requireText(value.snapshotId, "snapshotId", 128);
  if (!snapshotId.trim()) throw invalidSnapshot("Snapshot snapshotId must not be empty.");
  const title = requireText(value.title, "title", PLAN_SNAPSHOT_TITLE_MAX_LENGTH).trim();
  if (!title) throw invalidSnapshot("Snapshot title must not be empty.");
  const note = requireText(value.note, "note", PLAN_SNAPSHOT_NOTE_MAX_LENGTH);
  const producerVersion = value.producerVersion;
  if (producerVersion !== null && (typeof producerVersion !== "string" || producerVersion.length > 64)) {
    throw invalidSnapshot("Snapshot producerVersion must be null or a string up to 64 characters.");
  }

  const savedAt = requireIsoTimestamp(value.savedAt, "savedAt");
  const capturedAt = value.capturedAt === null ? null : requireIsoTimestamp(value.capturedAt, "capturedAt");
  const source = normalizeSource(value.source);
  const clonedRawInput = cloneRawInput(rawInput);

  return {
    schemaVersion: PLAN_SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    savedAt,
    capturedAt,
    title,
    note,
    producerVersion,
    rawInput: clonedRawInput,
    source,
  };
}

function assertPlanMatchesFormat(rawInput) {
  if (rawInput.format === "json" && !Array.isArray(rawInput.plan) && !isPlainObject(rawInput.plan)) {
    throw invalidSnapshot("JSON-format RawPlanInput must contain an object or array payload.");
  }
  if ((rawInput.format === "text" || rawInput.format === "xml") && typeof rawInput.plan !== "string") {
    throw invalidSnapshot(`${rawInput.format.toUpperCase()}-format RawPlanInput must contain a string payload.`);
  }
}

function cloneRawInput(rawInput) {
  assertJsonValue(rawInput.plan);
  const copy = {
    database: rawInput.database,
    mode: rawInput.mode,
    format: rawInput.format,
    plan: cloneJsonValue(rawInput.plan),
    ...(rawInput.sql === undefined ? {} : { sql: rawInput.sql }),
    ...(rawInput.databaseVersion === undefined ? {} : { databaseVersion: rawInput.databaseVersion }),
  };
  return copy;
}

function selectSource(source) {
  if (source === null || source === undefined) return {};
  if (!isPlainObject(source)) {
    throw new PlanSnapshotError("INVALID_SNAPSHOT_METADATA", "Analysis source context must be a plain object.");
  }
  const selected = {};
  for (const key of SOURCE_KEYS) {
    const value = source[key];
    if (value !== null && value !== undefined) selected[key] = requireText(value, `source.${key}`, 1_024);
  }
  return selected;
}

function normalizeSource(source) {
  if (!isPlainObject(source)) throw invalidSnapshot("Snapshot source must be a plain object.");
  assertExactKeys(source, SOURCE_KEYS.filter((key) => Object.hasOwn(source, key)), "Snapshot source");
  const normalized = {};
  for (const key of SOURCE_KEYS) {
    if (Object.hasOwn(source, key)) normalized[key] = requireText(source[key], `source.${key}`, 1_024);
  }
  return normalized;
}

function assertExactKeys(value, allowedKeys, label) {
  if (!isPlainObject(value)) throw invalidSnapshot(`${label} must be a plain object.`);
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw invalidSnapshot(`${label} contains an unsupported field.`);
  }
}

function requireText(value, label, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) {
    throw invalidSnapshot(`${label} must be a string no longer than ${maxLength} characters.`);
  }
  return value;
}

function requireIsoTimestamp(value, label) {
  if (typeof value !== "string") throw invalidSnapshot(`${label} must be an ISO timestamp.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw invalidSnapshot(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function assertJsonValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw invalidSnapshot("Raw plan contains a value that JSON cannot round-trip exactly.");
    return;
  }
  if (typeof value !== "object") throw invalidSnapshot("Raw plan contains a value that JSON cannot round-trip exactly.");
  if (seen.has(value)) throw invalidSnapshot("Raw plan must not contain circular references.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
        throw invalidSnapshot("Raw plan contains an unsupported array value.");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw invalidSnapshot("Raw plan must not contain sparse arrays.");
        assertJsonValue(value[index], seen);
      }
      return;
    }

    if (!isPlainObject(value)) throw invalidSnapshot("Raw plan must contain only plain JSON objects and arrays.");
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw invalidSnapshot("Raw plan contains a value that JSON cannot round-trip exactly.");
      }
      assertJsonValue(descriptor.value, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createSnapshotId() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new PlanSnapshotError("SNAPSHOT_ID_UNAVAILABLE", "This environment cannot generate a secure snapshot identifier.");
}

function invalidSnapshot(message) {
  return new PlanSnapshotError("INVALID_SNAPSHOT", message);
}

function asSnapshotError(error) {
  if (error instanceof PlanSnapshotError) return error;
  return invalidSnapshot("Snapshot data is invalid.");
}
