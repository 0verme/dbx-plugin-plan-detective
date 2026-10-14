import assert from "node:assert/strict";
import test from "node:test";
import { createPlanSnapshot } from "../../src/lib/plan-snapshot.js";
import {
  createPlanSnapshotRepository,
  MAX_PLAN_SNAPSHOT_RECORD_BYTES,
  MAX_PLAN_SNAPSHOT_STORE_BYTES,
  PLAN_SNAPSHOT_STORAGE_KEY,
  PlanSnapshotStoreError,
} from "../../src/lib/plan-snapshot-store.js";

const NOW = new Date("2026-10-14T03:04:05.000Z");
const BASE_INPUT = {
  database: "postgresql",
  mode: "estimated",
  format: "json",
  sql: "SELECT * FROM orders;",
  databaseVersion: "17.2",
  plan: [{ Plan: { "Node Type": "Seq Scan", "Relation Name": "orders", "Plan Rows": 10 } }],
};

function makeSnapshot(snapshotId, overrides = {}) {
  const session = {
    status: "structured",
    capturedAt: "2026-10-14T03:00:00.000Z",
    source: { databaseName: "analytics", schema: "public" },
    rawInput: { ...BASE_INPUT, ...(overrides.rawInput ?? {}) },
    analysis: { status: "structured" },
    hostResult: { truncated: false },
  };
  return createPlanSnapshot({
    session,
    title: `基线 ${snapshotId}`,
    note: "",
    producerVersion: "0.7.1",
    snapshotId,
    now: NOW,
    ...overrides,
  });
}

function copy(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function createHarness({ initial = null, hooks = {} } = {}) {
  const values = new Map();
  if (initial !== null) values.set(PLAN_SNAPSHOT_STORAGE_KEY, copy(initial));
  const calls = { get: 0, set: 0, delete: 0 };
  const bridge = {
    capabilities: { storage: true },
    storage: {
      async get(key) {
        calls.get += 1;
        if (hooks.get) return hooks.get({ key, calls, values });
        return values.has(key) ? copy(values.get(key)) : null;
      },
      async set(key, value) {
        calls.set += 1;
        if (hooks.set) return hooks.set({ key, value: copy(value), calls, values });
        values.set(key, copy(value));
      },
      async delete(key) {
        calls.delete += 1;
        if (hooks.delete) return hooks.delete({ key, calls, values });
        values.delete(key);
      },
    },
  };
  return { bridge, values, calls };
}

test("persists the entire record list in one bounded host value and supports save/list/rename/delete/clear", async () => {
  const { bridge, values, calls } = createHarness();
  const repository = createPlanSnapshotRepository(bridge);
  const first = makeSnapshot("one", { note: "原备注" });
  const second = makeSnapshot("two");

  assert.deepEqual(await repository.list(), []);
  assert.deepEqual(await repository.save(first), first);
  await repository.save(second);
  assert.deepEqual((await repository.list()).map((item) => item.snapshotId), ["one", "two"]);
  assert.deepEqual(await repository.get("one"), first);
  assert.equal(await repository.get("missing"), null);
  assert.equal(values.size, 1, "snapshot records and their index share one atomic Host Storage key");
  assert.ok(new TextEncoder().encode(JSON.stringify(values.get(PLAN_SNAPSHOT_STORAGE_KEY))).byteLength <= MAX_PLAN_SNAPSHOT_STORE_BYTES);

  await assert.rejects(repository.save(first), (error) => error.code === "SNAPSHOT_ALREADY_EXISTS");
  assert.equal((await repository.list()).length, 2, "duplicate IDs never overwrite existing snapshots");

  const renamed = await repository.rename("one", "改名后的基线", "只更新说明元数据");
  assert.equal(renamed.title, "改名后的基线");
  assert.equal(renamed.note, "只更新说明元数据");
  assert.deepEqual(renamed.rawInput, first.rawInput);
  assert.equal((await repository.list())[0].title, "改名后的基线");
  const renamedAgain = await repository.rename("one", "只更新名称");
  assert.equal(renamedAgain.note, "只更新说明元数据", "omitting note preserves the previous note");

  assert.equal(await repository.delete("two"), true);
  assert.equal(await repository.delete("missing"), false);
  assert.equal(await repository.clear(), 1);
  assert.deepEqual(await repository.list(), []);
  assert.ok(calls.set >= 4);
  assert.equal(calls.delete, 0, "clear writes one empty versioned document rather than deleting other host settings");
});

test("does not call storage when the host has not advertised the capability", async () => {
  let called = 0;
  const bridge = {
    capabilities: { storage: false },
    storage: {
      async get() { called += 1; return null; },
      async set() { called += 1; },
      async delete() { called += 1; },
    },
  };
  const repository = createPlanSnapshotRepository(bridge);
  await assert.rejects(repository.list(), (error) => error.code === "STORAGE_API_UNAVAILABLE");
  await assert.rejects(repository.save(makeSnapshot("no-storage")), (error) => error.code === "STORAGE_API_UNAVAILABLE");
  assert.equal(called, 0);
});

test("rejects oversized UTF-8 records and whole-store updates before writing", async () => {
  const { bridge, values, calls } = createHarness();
  const repository = createPlanSnapshotRepository(bridge);
  const oversizedRecord = makeSnapshot("too-large-record", {
    rawInput: { format: "text", plan: "你".repeat(44_000) },
  });
  assert.ok(new TextEncoder().encode(JSON.stringify(oversizedRecord)).byteLength > MAX_PLAN_SNAPSHOT_RECORD_BYTES);
  await assert.rejects(repository.save(oversizedRecord), (error) => error.code === "SNAPSHOT_TOO_LARGE");
  assert.equal(calls.set, 0);

  let refusedForTotalCapacity = false;
  for (let index = 0; index < 10; index += 1) {
    const snapshot = makeSnapshot(`medium-${index}`, {
      rawInput: { format: "text", plan: `计划${index}:` + "你".repeat(10_000) },
    });
    const writesBefore = calls.set;
    try {
      await repository.save(snapshot);
    } catch (error) {
      assert.equal(error.code, "SNAPSHOT_STORE_FULL");
      assert.equal(calls.set, writesBefore, "capacity rejection must happen before Host Storage is called");
      refusedForTotalCapacity = true;
      break;
    }
  }
  const stored = values.get(PLAN_SNAPSHOT_STORAGE_KEY);
  assert.equal(refusedForTotalCapacity, true);
  assert.ok(stored.snapshots.length > 0 && stored.snapshots.length < 10);
  assert.ok(new TextEncoder().encode(JSON.stringify(stored)).byteLength <= MAX_PLAN_SNAPSHOT_STORE_BYTES);
});

test("corrupt documents and unknown versions are surfaced and never overwritten", async () => {
  const unknown = { storageSchemaVersion: 99, revision: 7, lastMutationId: "future", snapshots: [] };
  const { bridge, values, calls } = createHarness({ initial: unknown });
  const repository = createPlanSnapshotRepository(bridge);

  await assert.rejects(repository.list(), (error) => error.code === "UNSUPPORTED_STORE_VERSION");
  await assert.rejects(repository.save(makeSnapshot("must-not-overwrite")), (error) => error.code === "UNSUPPORTED_STORE_VERSION");
  assert.equal(calls.set, 0);
  assert.deepEqual(values.get(PLAN_SNAPSHOT_STORAGE_KEY), unknown);

  const corruptHarness = createHarness({ initial: { storageSchemaVersion: 1, revision: 0, lastMutationId: null, snapshots: [null] } });
  const corruptRepository = createPlanSnapshotRepository(corruptHarness.bridge);
  await assert.rejects(corruptRepository.list(), (error) => error.code === "CORRUPT_SNAPSHOT_STORE");
  await assert.rejects(corruptRepository.save(makeSnapshot("must-not-overwrite")), (error) => error.code === "CORRUPT_SNAPSHOT_STORE");
  assert.equal(corruptHarness.calls.set, 0);
});

test("propagates unknown snapshot versions without dropping or replacing their document", async () => {
  const futureSnapshot = { ...makeSnapshot("future"), schemaVersion: 88 };
  const document = { storageSchemaVersion: 1, revision: 2, lastMutationId: "old", snapshots: [futureSnapshot] };
  const { bridge, values, calls } = createHarness({ initial: document });
  const repository = createPlanSnapshotRepository(bridge);
  await assert.rejects(repository.list(), (error) => error.code === "UNSUPPORTED_SNAPSHOT_VERSION");
  await assert.rejects(repository.clear(), (error) => error.code === "UNSUPPORTED_SNAPSHOT_VERSION");
  assert.equal(calls.set, 0);
  assert.deepEqual(values.get(PLAN_SNAPSHOT_STORAGE_KEY), document);
});

test("host write failures leave the previous atomic document intact", async () => {
  const initialSnapshot = makeSnapshot("existing");
  const initial = { storageSchemaVersion: 1, revision: 3, lastMutationId: "prior", snapshots: [initialSnapshot] };
  const { bridge, values } = createHarness({
    initial,
    hooks: { set: async () => { throw new Error("disk I/O failed"); } },
  });
  const repository = createPlanSnapshotRepository(bridge);
  await assert.rejects(repository.save(makeSnapshot("new")), (error) => {
    assert.equal(error.code, "HOST_STORAGE_ERROR");
    return true;
  });
  assert.deepEqual(values.get(PLAN_SNAPSHOT_STORAGE_KEY), initial);
});

test("serializes same-window concurrent repository operations across instances", async () => {
  const { bridge } = createHarness();
  const firstRepository = createPlanSnapshotRepository(bridge);
  const secondRepository = createPlanSnapshotRepository(bridge);

  await Promise.all([
    firstRepository.save(makeSnapshot("parallel-a")),
    secondRepository.save(makeSnapshot("parallel-b")),
  ]);
  const ids = (await firstRepository.list()).map((item) => item.snapshotId).sort();
  assert.deepEqual(ids, ["parallel-a", "parallel-b"]);
});

test("detects a completed cross-window change before writing and reports an explicit conflict", async () => {
  const external = { storageSchemaVersion: 1, revision: 1, lastMutationId: "external", snapshots: [makeSnapshot("other-window")] };
  let gets = 0;
  const { bridge, values, calls } = createHarness({ hooks: {
    async get({ key, values: store }) {
      gets += 1;
      if (gets === 2) store.set(key, copy(external));
      return store.has(key) ? copy(store.get(key)) : null;
    },
  } });
  const repository = createPlanSnapshotRepository(bridge);
  await assert.rejects(repository.save(makeSnapshot("our-window")), (error) => {
    assert.ok(error instanceof PlanSnapshotStoreError);
    assert.equal(error.code, "SNAPSHOT_STORAGE_CONFLICT");
    return true;
  });
  assert.equal(calls.set, 0);
  assert.deepEqual(values.get(PLAN_SNAPSHOT_STORAGE_KEY), external);
});

test("verifies the committed document and reports a concurrent post-write overwrite", async () => {
  const external = { storageSchemaVersion: 1, revision: 5, lastMutationId: "later-window", snapshots: [makeSnapshot("later-window")] };
  const { bridge, values, calls } = createHarness({ hooks: {
    async set({ key, value, values: store }) {
      store.set(key, copy(value));
      store.set(key, copy(external));
    },
  } });
  const repository = createPlanSnapshotRepository(bridge);
  await assert.rejects(repository.save(makeSnapshot("our-window")), (error) => {
    assert.equal(error.code, "SNAPSHOT_STORAGE_CONFLICT");
    return true;
  });
  assert.equal(calls.set, 1);
  assert.deepEqual(values.get(PLAN_SNAPSHOT_STORAGE_KEY), external);
});
