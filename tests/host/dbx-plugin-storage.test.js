import assert from "node:assert/strict";
import test from "node:test";
import {
  describePluginStorage,
  deletePluginStorageValue,
  getPluginStorageValue,
  HostStorageError,
  PLUGIN_STORAGE_MAX_VALUE_BYTES,
  PLUGIN_STORAGE_STATES,
  resolvePluginStorageBridge,
  setPluginStorageValue,
} from "../../src/host/dbx-plugin-storage.js";

function createBridge({ advertised = true, storage = {} } = {}) {
  return {
    capabilities: { storage: advertised },
    storage: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      ...storage,
    },
  };
}

test("resolves only the public DBX plugin bridge", () => {
  const bridge = createBridge();
  assert.equal(resolvePluginStorageBridge({ dbxPlugin: bridge }), bridge);
  assert.equal(resolvePluginStorageBridge({}), null);
  assert.equal(resolvePluginStorageBridge({ dbxPlugin: null }), null);
});

test("waits for init and fails closed when a host has no storage capability", () => {
  let resolveReady;
  const bridge = {
    storage: { get() {}, set() {}, delete() {} },
    capabilities: {},
    ready: new Promise((resolve) => { resolveReady = resolve; }),
    onInit() { return () => {}; },
  };

  assert.deepEqual(describePluginStorage(bridge), {
    state: PLUGIN_STORAGE_STATES.initializing,
    available: false,
    advertised: false,
    missing: [],
    reason: "DBX 宿主尚未完成初始化，暂时无法确认 Host Storage 能力；不会调用 storage 方法。",
  });
  assert.equal(describePluginStorage(bridge, { initialized: true }).state, "unavailable");
  bridge.capabilities = { storage: false };
  assert.equal(describePluginStorage(bridge, { initialized: true }).available, false);
  bridge.capabilities = { storage: true };
  assert.equal(describePluginStorage(bridge).available, true);
  resolveReady();
});

test("requires an advertised complete storage namespace, not method presence alone", () => {
  assert.equal(describePluginStorage(null).available, false);
  assert.equal(describePluginStorage(createBridge({ advertised: false })).available, false);
  const half = describePluginStorage({ capabilities: { storage: true }, storage: { get() {}, set() {} } });
  assert.equal(half.state, "unavailable");
  assert.equal(half.advertised, true);
  assert.deepEqual(half.missing, ["storage.delete"]);
  assert.equal(describePluginStorage(createBridge()).available, true);
});

test("uses the formal storage.get/set/delete methods without probing unavailable hosts", async () => {
  const calls = [];
  const bridge = createBridge({ storage: {
    get: async (key) => { calls.push(["get", key]); return { title: "baseline" }; },
    set: async (key, value) => { calls.push(["set", key, value]); },
    delete: async (key) => { calls.push(["delete", key]); },
  } });

  assert.deepEqual(await getPluginStorageValue(bridge, "snapshot-store"), { title: "baseline" });
  await setPluginStorageValue(bridge, "snapshot-store", { revision: 1 });
  await deletePluginStorageValue(bridge, "snapshot-store");
  assert.deepEqual(calls, [
    ["get", "snapshot-store"],
    ["set", "snapshot-store", { revision: 1 }],
    ["delete", "snapshot-store"],
  ]);

  let called = false;
  const unsupported = createBridge({ advertised: false, storage: { get: async () => { called = true; } } });
  await assert.rejects(getPluginStorageValue(unsupported, "snapshot-store"), (error) => error.code === "STORAGE_API_UNAVAILABLE");
  assert.equal(called, false);
});

test("validates keys and budgets serialized UTF-8 bytes rather than character count", async () => {
  const calls = [];
  const bridge = createBridge({ storage: { set: async (...args) => calls.push(args) } });
  await setPluginStorageValue(bridge, "a".repeat(256), { ok: true });
  assert.equal(calls.length, 1);
  for (const key of ["", "a".repeat(257), "bad\u0001key"]) {
    await assert.rejects(setPluginStorageValue(bridge, key, 1), (error) => error.code === "INVALID_STORAGE_KEY");
  }

  const fits = "你".repeat(87_380);
  await setPluginStorageValue(bridge, "utf8", fits);
  assert.equal(new TextEncoder().encode(JSON.stringify(fits)).byteLength, 262_142);
  const exceeds = "你".repeat(87_381);
  assert.equal(new TextEncoder().encode(JSON.stringify(exceeds)).byteLength, PLUGIN_STORAGE_MAX_VALUE_BYTES + 1);
  await assert.rejects(setPluginStorageValue(bridge, "utf8", exceeds), (error) => error.code === "STORAGE_VALUE_TOO_LARGE");
  assert.equal(calls.length, 2, "oversized data must be rejected before calling the host");
  await assert.rejects(setPluginStorageValue(bridge, "bad-json", 1n), (error) => error.code === "INVALID_STORAGE_VALUE");
});

test("maps missing permission, quota, and generic host failures to stable errors", async () => {
  const noPermission = createBridge({ storage: { get: async () => { throw new Error("Plugin has not declared permission 'host.storage'"); } } });
  await assert.rejects(getPluginStorageValue(noPermission, "key"), (error) => {
    assert.ok(error instanceof HostStorageError);
    assert.equal(error.code, "STORAGE_PERMISSION_DENIED");
    assert.match(error.message, /permission/i);
    return true;
  });

  const quota = createBridge({ storage: { set: async () => { throw new Error("plugin UI storage exceeds 1048576 bytes"); } } });
  await assert.rejects(setPluginStorageValue(quota, "key", 1), (error) => error.code === "STORAGE_VALUE_TOO_LARGE");

  const failed = createBridge({ storage: { delete: async () => { throw new Error("disk I/O failed"); } } });
  await assert.rejects(deletePluginStorageValue(failed, "key"), (error) => {
    assert.equal(error.code, "HOST_STORAGE_ERROR");
    assert.equal(error.hostMessage, "disk I/O failed");
    return true;
  });
});
