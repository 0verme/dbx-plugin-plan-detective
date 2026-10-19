export const PLUGIN_STORAGE_PERMISSION = "host.storage";
export const PLUGIN_STORAGE_MAX_VALUE_BYTES = 256 * 1024;
export const PLUGIN_STORAGE_MAX_TOTAL_BYTES = 1024 * 1024;
export const PLUGIN_STORAGE_MAX_KEYS = 1_024;
export const PLUGIN_STORAGE_MAX_KEY_CHARS = 256;

export const PLUGIN_STORAGE_STATES = Object.freeze({
  initializing: "initializing",
  available: "available",
  unavailable: "unavailable",
});

/** Stable host-storage error contract; raw values are never included in messages. */
export class HostStorageError extends Error {
  /** @param {string} code @param {string} message @param {string|null} [hostMessage] */
  constructor(code, message, hostMessage = null) {
    super(message);
    this.name = "HostStorageError";
    this.code = code;
    this.hostMessage = hostMessage;
  }
}

/** Resolve only the public DBX Plugin Host bridge. */
export function resolvePluginStorageBridge(target = globalThis) {
  const bridge = target?.dbxPlugin;
  return bridge !== null && typeof bridge === "object" ? bridge : null;
}

/**
 * Describe the officially advertised Host Storage surface without probing it.
 * A pre-init bridge stays initializing; after init, a missing/false capability
 * or incomplete method surface fails closed.
 *
 * @param {unknown} bridge
 * @param {{initialized?: boolean}} [options]
 */
export function describePluginStorage(bridge, options = {}) {
  if (bridge === null || typeof bridge !== "object") {
    return unavailable(["storage.get", "storage.set", "storage.delete"], "当前不在 DBX 宿主中：window.dbxPlugin 不存在。", "BRIDGE_UNAVAILABLE");
  }

  const storage = bridge.storage;
  const missing = [];
  if (storage === null || typeof storage !== "object") {
    missing.push("storage");
  } else {
    if (typeof storage.get !== "function") missing.push("storage.get");
    if (typeof storage.set !== "function") missing.push("storage.set");
    if (typeof storage.delete !== "function") missing.push("storage.delete");
  }

  const advertised = bridge.capabilities?.storage === true;
  if (advertised && missing.length === 0) {
    return { state: PLUGIN_STORAGE_STATES.available, available: true, advertised: true, missing: [], reason: null };
  }
  if (advertised) {
    return {
      state: PLUGIN_STORAGE_STATES.unavailable,
      available: false,
      advertised: true,
      missing,
      reason: `宿主声明 capabilities.storage，但缺少方法：${missing.join(", ")}。`,
      reasonCode: "STORAGE_METHODS_MISSING",
    };
  }

  if (options.initialized !== true && canStillInitialize(bridge)) {
    return {
      state: PLUGIN_STORAGE_STATES.initializing,
      available: false,
      advertised: false,
      missing,
      reason: "DBX 宿主尚未完成初始化，暂时无法确认 Host Storage 能力；不会调用 storage 方法。",
      reasonCode: "INITIALIZING",
    };
  }

  return unavailable(
    missing,
    "宿主未声明 capabilities.storage；当前不会调用 Host Storage。请确认 DBX 版本与插件 host.storage 权限。",
    "CAPABILITY_UNAVAILABLE",
  );
}

/** Read one JSON value through the DBX host. An unset key is returned as null by the host contract. */
export async function getPluginStorageValue(bridge, key) {
  const storage = requireAvailableStorage(bridge);
  const normalizedKey = requireStorageKey(key);
  try {
    return await storage.get(normalizedKey);
  } catch (error) {
    throw mapStorageError(error, "read");
  }
}

/** Write one JSON value through the DBX host, preflighting its UTF-8 JSON byte size. */
export async function setPluginStorageValue(bridge, key, value) {
  const storage = requireAvailableStorage(bridge);
  const normalizedKey = requireStorageKey(key);
  const normalizedValue = value === undefined ? null : value;
  let serialized;
  try {
    serialized = JSON.stringify(normalizedValue);
  } catch {
    throw new HostStorageError("INVALID_STORAGE_VALUE", "Storage value must be JSON serializable.");
  }
  if (typeof serialized !== "string") {
    throw new HostStorageError("INVALID_STORAGE_VALUE", "Storage value must be JSON serializable.");
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > PLUGIN_STORAGE_MAX_VALUE_BYTES) {
    throw new HostStorageError("STORAGE_VALUE_TOO_LARGE", `Storage value exceeds the DBX ${PLUGIN_STORAGE_MAX_VALUE_BYTES}-byte limit.`);
  }
  try {
    await storage.set(normalizedKey, normalizedValue);
  } catch (error) {
    throw mapStorageError(error, "write");
  }
}

/** Delete one key through the DBX host. */
export async function deletePluginStorageValue(bridge, key) {
  const storage = requireAvailableStorage(bridge);
  const normalizedKey = requireStorageKey(key);
  try {
    await storage.delete(normalizedKey);
  } catch (error) {
    throw mapStorageError(error, "delete");
  }
}

function requireAvailableStorage(bridge) {
  const api = describePluginStorage(bridge, { initialized: true });
  if (api.available) return bridge.storage;
  throw new HostStorageError("STORAGE_API_UNAVAILABLE", api.reason ?? "DBX Host Storage is unavailable.");
}

function requireStorageKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > PLUGIN_STORAGE_MAX_KEY_CHARS || /[\u0000-\u001f]/.test(key)) {
    throw new HostStorageError("INVALID_STORAGE_KEY", "Storage key must be non-empty, contain no control characters, and fit the DBX key limit.");
  }
  return key;
}

function canStillInitialize(bridge) {
  const ready = bridge.ready;
  const hasReady = ready !== null && (typeof ready === "object" || typeof ready === "function") && typeof ready.then === "function";
  return hasReady || typeof bridge.onInit === "function";
}

function unavailable(missing, reason, reasonCode) {
  return { state: PLUGIN_STORAGE_STATES.unavailable, available: false, advertised: false, missing, reason, reasonCode };
}

function mapStorageError(error, operation) {
  const hostMessage = error instanceof Error ? error.message : String(error);
  if (/permission|not declared/i.test(hostMessage) && /storage/i.test(hostMessage)) {
    return new HostStorageError("STORAGE_PERMISSION_DENIED", "DBX rejected Host Storage permission; check the installed manifest permissions.", hostMessage);
  }
  if (/exceeds|quota|too large/i.test(hostMessage)) {
    return new HostStorageError("STORAGE_VALUE_TOO_LARGE", "DBX rejected the Host Storage value because a capacity limit was exceeded.", hostMessage);
  }
  if (/unavailable|unsupported/i.test(hostMessage)) {
    return new HostStorageError("STORAGE_API_UNAVAILABLE", "DBX Host Storage is unavailable on this host.", hostMessage);
  }
  return new HostStorageError("HOST_STORAGE_ERROR", `DBX Host Storage ${operation} failed.`, hostMessage);
}
