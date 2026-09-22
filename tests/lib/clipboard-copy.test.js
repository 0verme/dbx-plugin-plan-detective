import assert from "node:assert/strict";
import test from "node:test";
import { COPY_CHANNEL, copyTextToClipboard } from "../../src/lib/clipboard-copy.js";

/**
 * Copy behavior is pinned with fake bridges / fake clipboards: the DBX host is
 * tried first, the browser clipboard is the fallback, and a total failure is
 * reported to the caller. No test touches a real clipboard or the network.
 */

/** @param {{ request?: (method: string, params: object) => Promise<unknown> }} [overrides] */
function fakeBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    request: async (method, params) => {
      calls.push([method, params]);
      if (typeof overrides.request === "function") return overrides.request(method, params);
      return undefined;
    },
  };
}

function fakeClipboard() {
  const writes = [];
  return {
    writes,
    writeText: async (text) => {
      writes.push(text);
    },
  };
}

test("host.copy is the first channel and receives the documented { text } parameter", async () => {
  const bridge = fakeBridge();
  const clipboard = fakeClipboard();

  const result = await copyTextToClipboard({ bridge, text: "prompt text", clipboard });

  assert.deepEqual(result, { ok: true, channel: COPY_CHANNEL.host, hostError: null });
  assert.deepEqual(bridge.calls, [["host.copy", { text: "prompt text" }]]);
  assert.equal(clipboard.writes.length, 0, "the browser clipboard is not touched when the host succeeds");
});

test("a rejected host.copy falls back to navigator.clipboard", async () => {
  const bridge = fakeBridge({
    request: async () => {
      throw new Error("host.copy is not available");
    },
  });
  const clipboard = fakeClipboard();

  const result = await copyTextToClipboard({ bridge, text: "prompt text", clipboard });

  assert.equal(result.ok, true);
  assert.equal(result.channel, COPY_CHANNEL.clipboard);
  assert.equal(result.hostError, "host.copy is not available");
  assert.deepEqual(clipboard.writes, ["prompt text"]);
});

test("a missing bridge / request method goes straight to the clipboard", async () => {
  const clipboard = fakeClipboard();

  const noBridge = await copyTextToClipboard({ bridge: null, text: "a", clipboard });
  assert.equal(noBridge.ok, true);
  assert.equal(noBridge.channel, COPY_CHANNEL.clipboard);
  assert.match(noBridge.hostError, /bridge\.request/);

  const noRequest = await copyTextToClipboard({ bridge: { capabilities: {} }, text: "b", clipboard });
  assert.equal(noRequest.ok, true);
  assert.equal(noRequest.channel, COPY_CHANNEL.clipboard);
});

test("when both channels fail the failure is reported, never swallowed", async () => {
  const bridge = fakeBridge({
    request: async () => {
      throw new Error("host down");
    },
  });
  const clipboard = {
    writeText: async () => {
      throw new Error("clipboard permission denied");
    },
  };

  const result = await copyTextToClipboard({ bridge, text: "prompt text", clipboard });

  assert.deepEqual(result, {
    ok: false,
    reason: "COPY_FAILED",
    hostError: "host down",
    browserError: "clipboard permission denied",
  });
});

test("an unavailable browser clipboard is reported as a failure", async () => {
  const result = await copyTextToClipboard({ bridge: null, text: "prompt text", clipboard: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "COPY_FAILED");
  assert.match(result.browserError, /unavailable/);
});

test("empty text is rejected before any channel is touched", async () => {
  const bridge = fakeBridge();
  const clipboard = fakeClipboard();

  for (const text of ["", null, undefined, 42]) {
    const result = await copyTextToClipboard({ bridge, text, clipboard });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "EMPTY_TEXT");
  }
  assert.equal(bridge.calls.length, 0);
  assert.equal(clipboard.writes.length, 0);
});

test("the copy path never performs a network request", async () => {
  const bridge = fakeBridge();
  const clipboard = fakeClipboard();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network must not be used");
  };

  try {
    await copyTextToClipboard({ bridge, text: "prompt text", clipboard });
    assert.equal(fetchCalls, 0);
    for (const [method] of bridge.calls) {
      assert.equal(method, "host.copy", "the only host call is host.copy");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
