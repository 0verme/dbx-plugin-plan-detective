/**
 * Dispatch the platform's Cmd/Ctrl+Enter SQL-input shortcut.
 *
 * The shortcut is consumed even while analysis is disabled or loading, but it
 * only invokes the action when the input is ready. Returns whether the event
 * matched the shortcut so callers can distinguish it from ordinary typing.
 *
 * @param {KeyboardEvent} event
 * @param {{ disabled?: boolean, loading?: boolean, onAnalyze?: () => void }} [options]
 * @returns {boolean}
 */
export function handleAnalyzeShortcut(event, { disabled = false, loading = false, onAnalyze = () => {} } = {}) {
  if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return false;

  event.preventDefault();
  if (!disabled && !loading) onAnalyze();
  return true;
}
