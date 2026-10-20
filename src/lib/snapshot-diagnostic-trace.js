const MAX_EVENTS_PER_TRACE = 128;
const MAX_SESSION_EVENTS = 96;
const MAX_RETAINED_TRACES = 8;
const MAX_EXPORT_CHARS = 48 * 1024;
const SAFE_ERROR_CODES = new Set([
  "STORAGE_API_UNAVAILABLE",
  "STORAGE_PERMISSION_DENIED",
  "STORAGE_VALUE_TOO_LARGE",
  "HOST_STORAGE_ERROR",
  "SNAPSHOT_WRITE_UNCONFIRMED",
  "SNAPSHOT_ALREADY_EXISTS",
  "SNAPSHOT_NOT_FOUND",
  "SNAPSHOT_STORAGE_CONFLICT",
  "CORRUPT_SNAPSHOT_STORE",
  "UNSUPPORTED_STORE_VERSION",
  "UNSUPPORTED_SNAPSHOT_VERSION",
  "SNAPSHOT_TOO_LARGE",
  "SNAPSHOT_STORE_FULL",
  "SNAPSHOT_STORE_REVISION_EXHAUSTED",
  "SNAPSHOT_ID_UNAVAILABLE",
  "INVALID_SNAPSHOT_ID",
  "INVALID_STORAGE_KEY",
  "INVALID_STORAGE_VALUE",
  "SNAPSHOT_LIST_NOT_READY",
  "SNAPSHOT_NOT_COMPARABLE",
  "INVALID_SNAPSHOT_INPUT",
  "INVALID_SNAPSHOT_METADATA",
  "INVALID_SNAPSHOT",
  "CORRUPT_SNAPSHOT",
  "FRONTEND_VALIDATION_REJECTED",
  "FORM_SUBMIT_NOT_OBSERVED",
  "FORM_ASSOCIATION_MISMATCH",
  "DUPLICATE_SUBMISSION",
  "UNKNOWN_ERROR",
  "SUBMITTER_DISABLED",
]);
const SAFE_FAILED_STAGES = new Set([
  "save.gate",
  "rename.validate",
  "rename.repository",
  "form.submit",
  "snapshot.create",
  "repository.save",
  "storage.get",
  "storage.set",
  "storage.verify",
  "store.validate",
  "history.refresh",
  "ui.update",
  "diagnostic.copy",
  "host.initialize",
]);
const SAFE_LOAD_STATES = new Set(["unavailable", "initializing", "available", "loading", "ready", "error"]);
/**
 * Host Storage mutations are shared by every snapshot operation, so the
 * repository emits one stable set of stage names. A rename trace reports the
 * same storage work under its own operation namespace instead of implying the
 * save flow ran; nothing about the underlying write changes.
 */
const STAGE_ALIASES = Object.freeze({
  rename: Object.freeze({
    SNAPSHOT_STORAGE_SET: "RENAME_STORAGE_SET",
    SNAPSHOT_STORAGE_VERIFY: "RENAME_STORAGE_VERIFY",
    SNAPSHOT_STORAGE_VERIFY_RESULT: "RENAME_STORAGE_VERIFY_RESULT",
  }),
});
const SAFE_PERMISSION_STATES = new Set(["not-verified", "usable", "denied"]);

let traceCounter = 0;
let preparedSaveTrace = null;
let preparedSaveTimer = null;
let runtimeEnvironment = {
  pluginVersion: "unknown",
  buildFingerprint: "unknown",
  dbxVersion: "unknown",
  manifestPermissions: [],
  storage: { capabilityAdvertised: false, capabilityAvailable: false, permissionStatus: "not-verified" },
};

const retainedTraces = [];
const sessionTrace = makeTrace("session");

/** Stable in-memory trace for host initialization and latest runtime state. */
export function getSnapshotDiagnosticSessionTrace() {
  return sessionTrace;
}

/**
 * Update only safe environment metadata. No storage values or user content enter
 * this object; Host permission grant state is inferred solely from Storage API
 * outcomes because the public bridge has no permission-inspection method.
 */
export function setSnapshotDiagnosticEnvironment(environment = {}) {
  const storage = environment.storage ?? {};
  runtimeEnvironment = {
    pluginVersion: safeVersion(environment.pluginVersion),
    buildFingerprint: safeFingerprint(environment.buildFingerprint),
    dbxVersion: safeVersion(environment.dbxVersion),
    manifestPermissions: Array.isArray(environment.manifestPermissions)
      ? environment.manifestPermissions.filter((permission) => permission === "host.storage" || permission === "host.plans:read")
      : [],
    storage: {
      capabilityAdvertised: storage.advertised === true,
      capabilityAvailable: storage.available === true,
      permissionStatus: runtimeEnvironment.storage?.permissionStatus ?? "not-verified",
      state: SAFE_LOAD_STATES.has(storage.state) ? storage.state : "unavailable",
    },
  };
}

/** A low-overhead, unique trace for each save or rename attempt. */
export function createSnapshotDiagnosticTrace({ kind = "save" } = {}) {
  const trace = makeTrace(kind);
  retainedTraces.push(trace);
  while (retainedTraces.length > MAX_RETAINED_TRACES) retainedTraces.shift();
  if (kind === "save") trace.isSaveTrace = true;
  return trace;
}

/** Called by the confirm button; a click is not evidence of form submission. */
export function prepareSnapshotSaveTrace(metadata = {}) {
  settleUnsubmittedSaveTrace();
  const trace = prepareFormTrace();
  recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_UI_CLICK", "success", metadata);
  return trace;
}

/** Capture runs before onsubmit, exposing propagation/handler interference. */
export function recordSnapshotFormSubmitCapture(metadata = {}) {
  const trace = preparedSaveTrace ?? prepareFormTrace();
  recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_FORM_SUBMIT_CAPTURE", "success", metadata);
  return trace;
}

/** Consume a click-prepared trace or create one for native/programmatic submit. */
export function beginSnapshotSaveTrace(metadata = {}) {
  const trace = preparedSaveTrace?.status === "pending" ? preparedSaveTrace : createSnapshotDiagnosticTrace({ kind: "save" });
  clearPreparedFormTrace();
  recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_FORM_SUBMIT", "success", metadata);
  return trace;
}

/** invalid does not bubble: the form must listen in the capture phase. */
export function recordSnapshotFormValidationFailure(metadata = {}) {
  const trace = preparedSaveTrace ?? createSnapshotDiagnosticTrace({ kind: "save" });
  recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_FORM_VALIDATION_REJECTED", "blocked", {
    ...metadata,
    errorCode: "FRONTEND_VALIDATION_REJECTED",
    failedStage: "form.submit",
  });
  finishSnapshotDiagnosticTrace(trace, "blocked");
  // Keep this trace until the end of this task so multiple invalid controls
  // from one reportValidity() call remain part of the same attempt.
  return trace;
}

function prepareFormTrace() {
  const trace = createSnapshotDiagnosticTrace({ kind: "save" });
  preparedSaveTrace = trace;
  // Native/default submission and our sandbox-safe dispatch are synchronous.
  // Only an unconsumed UI attempt expires; a pending Host operation never does.
  preparedSaveTimer = setTimeout(settleUnsubmittedSaveTrace, 0);
  preparedSaveTimer?.unref?.();
  return trace;
}

function settleUnsubmittedSaveTrace() {
  const trace = preparedSaveTrace;
  clearPreparedFormTrace();
  if (trace?.status !== "pending") return;
  recordSnapshotDiagnosticEvent(trace, "SNAPSHOT_FORM_SUBMIT_MISSING", "blocked", {
    errorCode: "FORM_SUBMIT_NOT_OBSERVED",
    failedStage: "form.submit",
  });
  finishSnapshotDiagnosticTrace(trace, "blocked");
}

function clearPreparedFormTrace() {
  if (preparedSaveTimer !== null) clearTimeout(preparedSaveTimer);
  preparedSaveTimer = null;
  preparedSaveTrace = null;
}

export function finishSnapshotDiagnosticTrace(trace, status = "success") {
  if (!trace) return;
  trace.status = status === "failed" || status === "blocked" ? status : "completed";
  trace.finishedAt = new Date().toISOString();
}

export function recordSnapshotDiagnosticEvent(trace, step, status = "info", fields = {}) {
  if (!trace || typeof step !== "string") return null;
  const now = elapsed(trace);
  const safe = sanitizeFields(fields);
  const event = {
    traceId: trace.traceId,
    step: resolveStep(trace, step),
    status: safeStatus(status),
    started: now,
    finished: now,
    durationMs: 0,
    elapsedMs: now,
    ...safe,
  };
  appendEvent(trace, event);
  applyOutcomeToEnvironment(event);
  return event;
}

/** Log an async phase with separate START / END events and monotonic duration. */
export async function withSnapshotDiagnosticStage(trace, phase, operation, fields = {}) {
  const stage = startSnapshotDiagnosticStage(trace, phase, fields);
  try {
    const result = await operation();
    finishSnapshotDiagnosticStage(stage, "success", fields);
    if (phase === "SNAPSHOT_STORE_VALIDATE") recordSnapshotDiagnosticEvent(trace, phase, "success", {
      readRole: fields.readRole,
      attempt: fields.attempt,
    });
    return result;
  } catch (error) {
    const errorFields = {
      ...fields,
      errorCode: diagnosticErrorCode(error),
      failedStage: fields.failedStage ?? defaultFailedStage(phase),
    };
    finishSnapshotDiagnosticStage(stage, "failed", errorFields);
    if (phase === "SNAPSHOT_STORE_VALIDATE") recordSnapshotDiagnosticEvent(trace, phase, "failed", errorFields);
    throw error;
  }
}

export function startSnapshotDiagnosticStage(trace, phase, fields = {}) {
  if (!trace) return null;
  const startedAt = monotonicNow();
  const started = elapsed(trace);
  const { errorCode: _errorCode, failedStage: _failedStage, sanitizedMessage: _sanitizedMessage, ...startFields } = fields;
  const event = {
    traceId: trace.traceId,
    step: `${resolveStep(trace, phase)}_START`,
    status: "pending",
    started,
    finished: null,
    durationMs: null,
    elapsedMs: started,
    ...sanitizeFields(startFields),
  };
  appendEvent(trace, event);
  return { trace, phase: resolveStep(trace, phase), startedAt, started, fields };
}

export function finishSnapshotDiagnosticStage(stage, status = "success", fields = {}) {
  if (!stage) return null;
  const finished = elapsed(stage.trace);
  const failed = status === "failed" || status === "blocked";
  const completionFields = failed ? fields : Object.fromEntries(
    Object.entries(fields).filter(([key]) => key !== "errorCode" && key !== "failedStage" && key !== "sanitizedMessage"),
  );
  const errorCode = completionFields.errorCode ? sanitizeErrorCode(completionFields.errorCode) : null;
  const failedStage = completionFields.failedStage ? safeFailedStage(completionFields.failedStage) : null;
  const event = {
    traceId: stage.trace.traceId,
    step: `${stage.phase}_END`,
    status: safeStatus(status),
    started: stage.started,
    finished,
    durationMs: Math.max(0, Math.round(monotonicNow() - stage.startedAt)),
    elapsedMs: finished,
    ...sanitizeFields({ ...stage.fields, ...completionFields, errorCode, failedStage }),
  };
  appendEvent(stage.trace, event);
  applyOutcomeToEnvironment(event);
  return event;
}

export function snapshotDiagnosticErrorFields(error, failedStage) {
  return {
    errorCode: diagnosticErrorCode(error),
    failedStage: safeFailedStage(failedStage),
  };
}

/** Returns a JSON-safe, size-bounded report containing only trace metadata. */
export function buildSnapshotDiagnosticLog() {
  if (sessionTrace.events.length === 0 && retainedTraces.length === 0) return null;

  const saveTraces = retainedTraces.filter((trace) => trace.kind === "save");
  const latestSaveTrace = saveTraces.at(-1) ?? null;
  const latestRenameTrace = retainedTraces.filter((trace) => trace.kind === "rename").at(-1) ?? null;
  const otherTraces = retainedTraces
    .filter((trace) => trace !== latestSaveTrace && trace !== latestRenameTrace)
    .slice(-2);
  const report = {
    format: "dbx-plan-detective-snapshot-diagnostics/v1",
    exportedAt: new Date().toISOString(),
    environment: {
      pluginVersion: runtimeEnvironment.pluginVersion,
      buildFingerprint: runtimeEnvironment.buildFingerprint,
      dbxVersion: runtimeEnvironment.dbxVersion,
      manifestPermissions: [...runtimeEnvironment.manifestPermissions],
      storage: { ...runtimeEnvironment.storage, permissionStatus: runtimeEnvironment.storage.permissionStatus },
    },
    latestSaveTraceId: latestSaveTrace?.traceId ?? null,
    latestSaveTrace: latestSaveTrace ? serializeTrace(latestSaveTrace) : null,
    latestRenameTraceId: latestRenameTrace?.traceId ?? null,
    latestRenameTrace: latestRenameTrace ? serializeTrace(latestRenameTrace) : null,
    recentTraces: otherTraces.map(serializeTrace),
    sessionEvents: sessionTrace.events.slice(-MAX_SESSION_EVENTS),
  };

  let serialized = JSON.stringify(report, null, 2);
  while (serialized.length > MAX_EXPORT_CHARS && report.sessionEvents.length > 8) {
    report.sessionEvents.splice(0, Math.ceil(report.sessionEvents.length / 3));
    serialized = JSON.stringify(report, null, 2);
  }
  while (serialized.length > MAX_EXPORT_CHARS && report.recentTraces.length > 0) {
    report.recentTraces.shift();
    serialized = JSON.stringify(report, null, 2);
  }
  return serialized.length <= MAX_EXPORT_CHARS ? serialized : JSON.stringify({
    format: report.format,
    exportedAt: report.exportedAt,
    environment: report.environment,
    latestSaveTraceId: report.latestSaveTraceId,
    latestSaveTrace: report.latestSaveTrace,
    latestRenameTraceId: report.latestRenameTraceId,
    latestRenameTrace: report.latestRenameTrace,
    recentTraces: [],
    sessionEvents: [],
    truncated: true,
  });
}

export function hasSnapshotDiagnosticEvents() {
  return sessionTrace.events.length > 0 || retainedTraces.some((trace) => trace.events.length > 0);
}

export function diagnosticErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "UNKNOWN_ERROR";
  return SAFE_ERROR_CODES.has(code) ? code : "UNKNOWN_ERROR";
}

export function detectDbxVersion(bridge, navigatorLike = globalThis.navigator) {
  for (const property of ["dbxVersion", "hostVersion"]) {
    try {
      const version = safeVersion(bridge?.[property]);
      if (version !== "unknown") return version;
    } catch {
      // Ignore unknown bridge getters; diagnostics must never disrupt the UI.
    }
  }
  try {
    const userAgent = navigatorLike?.userAgent;
    const match = typeof userAgent === "string" ? userAgent.match(/DBX(?: Desktop)?\/[v]?([0-9]+(?:\.[0-9]+){1,3})/i) : null;
    return match?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function makeTrace(kind) {
  traceCounter += 1;
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now().toString(36)}${traceCounter.toString(36)}`;
  return {
    traceId: `snapshot-${random}`,
    kind: kind === "history" ? "history" : kind === "save" ? "save" : kind === "rename" ? "rename" : "session",
    startedAt: new Date().toISOString(),
    monotonicStartedAt: monotonicNow(),
    status: "pending",
    events: [],
  };
}

function appendEvent(trace, event) {
  trace.events.push(event);
  if (trace.events.length > MAX_EVENTS_PER_TRACE) trace.events.splice(0, trace.events.length - MAX_EVENTS_PER_TRACE);
}

function serializeTrace(trace) {
  return {
    traceId: trace.traceId,
    kind: trace.kind,
    startedAt: trace.startedAt,
    finishedAt: trace.finishedAt ?? null,
    status: trace.status,
    events: trace.events,
  };
}

function elapsed(trace) {
  return Math.max(0, Math.round(monotonicNow() - trace.monotonicStartedAt));
}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function safeStep(step) {
  return /^[A-Z0-9_]{1,80}$/.test(step) ? step : "SNAPSHOT_DIAGNOSTIC_EVENT";
}

function resolveStep(trace, step) {
  const alias = STAGE_ALIASES[trace?.kind]?.[step];
  return safeStep(alias ?? step);
}

function safeStatus(status) {
  return ["pending", "success", "failed", "blocked", "info"].includes(status) ? status : "info";
}

function sanitizeFields(fields = {}) {
  const safe = {};
  if (typeof fields.storageAvailable === "boolean") safe.storageAvailable = fields.storageAvailable;
  if (typeof fields.storageAdvertised === "boolean") safe.storageAdvertised = fields.storageAdvertised;
  if (typeof fields.sessionStructured === "boolean") safe.sessionStructured = fields.sessionStructured;
  if (typeof fields.saveDisabled === "boolean") safe.saveDisabled = fields.saveDisabled;
  if (typeof fields.saveEntryDisabled === "boolean") safe.saveEntryDisabled = fields.saveEntryDisabled;
  if (typeof fields.saveConfirmDisabled === "boolean") safe.saveConfirmDisabled = fields.saveConfirmDisabled;
  if (typeof fields.saving === "boolean") safe.saving = fields.saving;
  if (typeof fields.titlePresent === "boolean") safe.titlePresent = fields.titlePresent;
  for (const key of [
    "formAssociated", "formConnected", "formNoValidate", "formValid",
    "submitterDisabled", "disabledStateMismatch", "domTitlePresent", "framed",
    "eventTrusted", "eventDefaultPrevented", "eventCancelBubble",
    "valueMissing", "tooLong", "customError",
  ]) if (typeof fields[key] === "boolean") safe[key] = fields[key];
  if (["title", "note"].includes(fields.invalidField)) safe.invalidField = fields.invalidField;
  if (typeof fields.initialized === "boolean") safe.initialized = fields.initialized;
  if (typeof fields.bridgeAvailable === "boolean") safe.bridgeAvailable = fields.bridgeAvailable;
  if (typeof fields.capabilityAvailable === "boolean") safe.capabilityAvailable = fields.capabilityAvailable;
  if (typeof fields.capabilityAdvertised === "boolean") safe.capabilityAdvertised = fields.capabilityAdvertised;
  if (typeof fields.permissionDeclared === "boolean") safe.permissionDeclared = fields.permissionDeclared;
  if (typeof fields.attempt === "number" && Number.isInteger(fields.attempt) && fields.attempt >= 0 && fields.attempt <= 2) safe.attempt = fields.attempt;
  if (typeof fields.loadState === "string" && SAFE_LOAD_STATES.has(fields.loadState)) safe.loadState = fields.loadState;
  if (typeof fields.permissionStatus === "string" && SAFE_PERMISSION_STATES.has(fields.permissionStatus)) safe.permissionStatus = fields.permissionStatus;
  if (typeof fields.reasonCode === "string" && /^[A-Z0-9_]{1,64}$/.test(fields.reasonCode)) safe.reasonCode = fields.reasonCode;
  if (fields.errorCode !== undefined && fields.errorCode !== null) safe.errorCode = sanitizeErrorCode(fields.errorCode);
  if (fields.failedStage !== undefined && fields.failedStage !== null) safe.failedStage = safeFailedStage(fields.failedStage);
  if (typeof fields.dbxVersion === "string") safe.dbxVersion = safeVersion(fields.dbxVersion);
  if (typeof fields.pluginVersion === "string") safe.pluginVersion = safeVersion(fields.pluginVersion);
  if (typeof fields.buildFingerprint === "string") safe.buildFingerprint = safeFingerprint(fields.buildFingerprint);
  if (typeof fields.operation === "string" && ["initial", "manual", "open", "post-save", "verification"].includes(fields.operation)) safe.operation = fields.operation;
  if (typeof fields.readRole === "string" && ["base", "prewrite", "verify", "history"].includes(fields.readRole)) safe.readRole = fields.readRole;
  if (typeof fields.sanitizedMessage === "string" && fields.errorCode) safe.sanitizedMessage = diagnosticMessage(sanitizeErrorCode(fields.errorCode), safeFailedStage(fields.failedStage));
  else if (fields.errorCode) safe.sanitizedMessage = diagnosticMessage(sanitizeErrorCode(fields.errorCode), safeFailedStage(fields.failedStage));
  return safe;
}

function sanitizeErrorCode(code) {
  return SAFE_ERROR_CODES.has(code) ? code : "UNKNOWN_ERROR";
}

function safeFailedStage(stage) {
  return SAFE_FAILED_STAGES.has(stage) ? stage : "repository.save";
}

function diagnosticMessage(errorCode, failedStage) {
  const messages = {
    STORAGE_API_UNAVAILABLE: "Host Storage capability or methods are unavailable.",
    STORAGE_PERMISSION_DENIED: "The Host rejected the declared Storage permission.",
    STORAGE_VALUE_TOO_LARGE: "The Host rejected a Storage operation because of a capacity limit.",
    HOST_STORAGE_ERROR: "A Host Storage operation failed; sensitive Host text was omitted.",
    SNAPSHOT_WRITE_UNCONFIRMED: "The write result could not be confirmed; no Storage write retry was made.",
    SNAPSHOT_LIST_NOT_READY: "The history list was not ready when save was submitted.",
    SNAPSHOT_NOT_COMPARABLE: "The current session was not a structured analysis.",
    FRONTEND_VALIDATION_REJECTED: "Browser form validation prevented submission.",
    FORM_SUBMIT_NOT_OBSERVED: "The click or capture event did not reach the submit handler; no write started.",
    FORM_ASSOCIATION_MISMATCH: "The save button was not associated with the expected connected form.",
    DUPLICATE_SUBMISSION: "A snapshot operation was already in progress; this submission did not write.",
    SUBMITTER_DISABLED: "The submit button was disabled when the activation arrived; nothing was written.",
    UNKNOWN_ERROR: "An unexpected error occurred; raw error text was omitted.",
  };
  return messages[errorCode] ?? `The operation failed at ${failedStage}; raw error text was omitted.`;
}

function defaultFailedStage(phase) {
  if (phase.includes("HOST_STORAGE_GET")) return "storage.get";
  if (phase.includes("STORAGE_SET")) return "storage.set";
  if (phase.includes("STORAGE_VERIFY")) return "storage.verify";
  if (phase.includes("HISTORY_REFRESH")) return "history.refresh";
  if (phase.includes("VALIDATE")) return "store.validate";
  if (phase.includes("BRIDGE")) return "host.initialize";
  return "repository.save";
}

function applyOutcomeToEnvironment(event) {
  const isStorageResult = event.step === "SNAPSHOT_HOST_STORAGE_GET_END" || event.step === "SNAPSHOT_STORAGE_SET_END";
  const permissionWas = runtimeEnvironment.storage.permissionStatus;
  if (event.errorCode === "STORAGE_PERMISSION_DENIED") {
    runtimeEnvironment.storage.permissionStatus = "denied";
  } else if (event.status === "success" && isStorageResult) {
    runtimeEnvironment.storage.permissionStatus = "usable";
  }
  if (event.storageAvailable !== undefined) runtimeEnvironment.storage.capabilityAvailable = event.storageAvailable;
  if (event.storageAdvertised !== undefined) runtimeEnvironment.storage.capabilityAdvertised = event.storageAdvertised;
  if (isStorageResult && permissionWas !== runtimeEnvironment.storage.permissionStatus) {
    recordSnapshotDiagnosticEvent(sessionTrace, "SNAPSHOT_HOST_PERMISSION_STATUS", "info", {
      permissionDeclared: runtimeEnvironment.manifestPermissions.includes("host.storage"),
      permissionStatus: runtimeEnvironment.storage.permissionStatus,
    });
  }
}

function safeVersion(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(value) ? value : "unknown";
}

function safeFingerprint(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) ? value : "unknown";
}
