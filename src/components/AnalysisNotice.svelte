<script>
  /**
   * Host acquisition status: loading, success, raw-only, unsupported, error.
   *
   * The copy is computed by the pure view model; this component only renders
   * it. Host errors keep their original message as a detail line instead of
   * collapsing into a generic "Analysis failed".
   */
  let {
    status = "idle",
    notice = null,
    error = null,
    onRetry = () => {},
  } = $props();
</script>

{#if status === "loading"}
  <p class="banner info" role="status">{notice?.title ?? "正在获取计划…"}</p>
{:else if status === "error" && error}
  <section class="banner error" role="alert">
    <div class="error-head">
      <strong>{error.title}</strong>
      <span class="code mono">{error.code}</span>
      <button type="button" class="retry" onclick={onRetry}>重试</button>
    </div>
    <p class="hint-line">{error.hint}</p>
    {#if error.message}
      <p class="detail mono">插件：{error.message}</p>
    {/if}
    {#if error.hostMessage}
      <p class="detail mono">宿主：{error.hostMessage}</p>
    {/if}
  </section>
{:else if notice}
  <p class="banner {notice.tone}" role="status">
    <strong>{notice.title}</strong>
    {#if notice.detail}<span class="detail-text"> · {notice.detail}</span>{/if}
  </p>
{/if}

<style>
  .banner {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--pd-border);
    border-left-width: 3px;
    border-radius: 6px;
    background: var(--pd-surface);
  }

  .banner.info {
    border-left-color: var(--pd-info-border);
  }

  .banner.success {
    border-left-color: var(--pd-ok-fg);
  }

  .banner.warning {
    border-left-color: var(--pd-warning-border);
    background: var(--pd-warning-bg);
    color: var(--pd-warning-fg);
  }

  .banner.error {
    border-left-color: var(--pd-high-border);
    background: var(--pd-high-bg);
    color: var(--pd-high-fg);
  }

  .error-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
  }

  .code {
    font-size: 11px;
    opacity: 0.8;
  }

  .retry {
    margin-left: auto;
    padding: 2px 8px;
    border: 1px solid currentColor;
    border-radius: 5px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .hint-line {
    margin: 4px 0 0;
  }

  .detail {
    margin: 4px 0 0;
    font-size: 11px;
    opacity: 0.85;
    overflow-wrap: anywhere;
  }

  .detail-text {
    color: var(--pd-muted);
  }
</style>
