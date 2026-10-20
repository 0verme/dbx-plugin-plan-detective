/**
 * DBX renders plugin iframes with `sandbox="allow-scripts"` and no
 * `allow-forms` (see `PluginWorkbenchHost.vue`). In that frame the browser
 * rejects native default submission *and* `form.requestSubmit()` before native
 * validation or `submit` ever run, so a real click on a `type="submit"` button
 * produced no validation feedback, no `submit` event and no handler call —
 * exactly the failure already fixed for snapshot saving and still present on
 * snapshot renaming.
 *
 * Keep the real submit button so implicit Enter/Space activation, `required`
 * and `maxlength` stay authoritative, then take over only the dispatch step:
 * cancel the blocked default action, run `reportValidity()` explicitly, and
 * dispatch one cancelable `SubmitEvent` at the same form. The sandbox is never
 * relaxed, the form's own submit handler stays the single write entry point,
 * and nothing is retried or written on a validation failure.
 */

/** A `submit` event was dispatched at the form; the form handler took over. */
export const SANDBOX_SUBMIT_DISPATCHED = "dispatched";
/** Native validation rejected the form; nothing was dispatched. */
export const SANDBOX_SUBMIT_INVALID = "invalid";
/** The click was refused before validation (association, disabled, busy). */
export const SANDBOX_SUBMIT_BLOCKED = "blocked";
/** Dispatch was attempted but never reached the form's submit handler. */
export const SANDBOX_SUBMIT_FAILED = "failed";

export const SANDBOX_SUBMIT_MISMATCH = "FORM_ASSOCIATION_MISMATCH";
export const SANDBOX_SUBMIT_DISABLED = "SUBMITTER_DISABLED";
export const SANDBOX_SUBMIT_UNREACHABLE = "FORM_SUBMIT_NOT_OBSERVED";

/**
 * Complete one submit-button activation without a native form submission.
 *
 * @param {object} options
 * @param {Event|null} options.event activation event (click, or keyboard-implied click)
 * @param {HTMLFormElement|null} options.form the form that owns the handler
 * @param {boolean} [options.disabled] extra derived busy/disabled state
 * @param {() => number|null} [options.readSubmitCount] proves the handler ran
 * @param {(formValid: boolean) => void} [options.onValidationResult] diagnostics only
 * @param {() => void} [options.onBeforeDispatch] diagnostics only
 * @returns {{ status: string, reason?: string, submitter: Element|null }}
 */
export function submitSandboxedForm({
  event = null,
  form = null,
  disabled = false,
  readSubmitCount = null,
  onValidationResult = null,
  onBeforeDispatch = null,
}) {
  // Nothing below can run if the browser keeps its blocked navigation path.
  event?.preventDefault?.();
  const submitter = event?.currentTarget ?? null;
  if (form === null || form.isConnected !== true || submitter === null || submitter.form !== form) {
    return { status: SANDBOX_SUBMIT_BLOCKED, reason: SANDBOX_SUBMIT_MISMATCH, submitter };
  }
  if (submitter.disabled === true || disabled === true) {
    return { status: SANDBOX_SUBMIT_BLOCKED, reason: SANDBOX_SUBMIT_DISABLED, submitter };
  }
  const formValid = form.reportValidity() === true;
  onValidationResult?.(formValid);
  if (!formValid) return { status: SANDBOX_SUBMIT_INVALID, submitter };

  const submissionsBefore = readSubmitCount?.() ?? null;
  onBeforeDispatch?.();
  form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter }));
  if (readSubmitCount !== null && readSubmitCount() === submissionsBefore) {
    return { status: SANDBOX_SUBMIT_FAILED, reason: SANDBOX_SUBMIT_UNREACHABLE, submitter };
  }
  return { status: SANDBOX_SUBMIT_DISPATCHED, submitter };
}
