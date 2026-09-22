/**
 * Clipboard copy with an explicit channel order.
 *
 *     host.copy (DBX IPC)  ->  navigator.clipboard.writeText (browser fallback)
 *
 * The DBX host registers `host.copy`; Phase 0 runtime evidence
 * (`docs/evidence/phase0-host-capability-audit-runtime.json`) shows the method
 * rejects a missing payload with `host.copy requires text`, so the documented
 * request is `bridge.request("host.copy", { text })`.
 *
 * This module performs no network request and touches no DOM beyond the
 * injected clipboard object. The bridge and the clipboard are parameters so the
 * whole fallback path is testable in Node without a DBX host.
 */

/** Channel that actually delivered the text. */
export const COPY_CHANNEL = Object.freeze({ host: "host", clipboard: "clipboard" });

/**
 * Copy `text`, preferring the DBX host and falling back to the browser
 * clipboard API. Both failures are reported to the caller: nothing fails
 * silently.
 *
 * @param {{
 *   bridge?: Record<string, unknown>|null,
 *   text?: unknown,
 *   clipboard?: { writeText?: (text: string) => Promise<unknown> }|null,
 *   hostMethod?: string,
 * }} [input]
 * @returns {Promise<
 *   | { ok: true, channel: "host"|"clipboard", hostError: string|null }
 *   | { ok: false, reason: string, hostError: string|null, browserError: string|null }
 * >}
 */
export async function copyTextToClipboard(input = {}) {
  const text = input?.text;
  if (typeof text !== "string" || text.length === 0) {
    return { ok: false, reason: "EMPTY_TEXT", hostError: null, browserError: null };
  }

  const hostError = await requestHostCopy(input?.bridge ?? null, input?.hostMethod ?? "host.copy", text);
  if (hostError === null) {
    return { ok: true, channel: COPY_CHANNEL.host, hostError: null };
  }

  const browser = await writeWithNavigator(resolveClipboard(input?.clipboard), text);
  if (browser.ok) {
    return { ok: true, channel: COPY_CHANNEL.clipboard, hostError };
  }

  return { ok: false, reason: "COPY_FAILED", hostError, browserError: browser.error };
}

/**
 * @param {unknown} bridge
 * @param {string} method
 * @param {string} text
 * @returns {Promise<string|null>} `null` on success, an error description otherwise
 */
async function requestHostCopy(bridge, method, text) {
  if (bridge === null || typeof bridge !== "object" || typeof bridge.request !== "function") {
    return "host.copy is unavailable: bridge.request is not a function";
  }

  try {
    await bridge.request(method, { text });
    return null;
  } catch (error) {
    return describeError(error);
  }
}

/**
 * @param {{ writeText?: (text: string) => Promise<unknown> }|null} clipboard
 * @param {string} text
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function writeWithNavigator(clipboard, text) {
  if (clipboard === null || typeof clipboard.writeText !== "function") {
    return { ok: false, error: "navigator.clipboard.writeText is unavailable" };
  }

  try {
    await clipboard.writeText(text);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Read the browser clipboard lazily: the global may not exist in Node, and
 * touching it eagerly would make this module environment-dependent.
 *
 * @param {unknown} injected
 */
function resolveClipboard(injected) {
  if (injected !== null && injected !== undefined) return injected;
  const navigatorLike = globalThis?.navigator;
  return navigatorLike?.clipboard ?? null;
}

/** @param {unknown} error */
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
