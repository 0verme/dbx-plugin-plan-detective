<script>
  /**
   * SQL input for the Host mode.
   *
   * The button is deliberately named "Analyze Plan": the plugin never executes
   * the statement. The host builds the EXPLAIN statement and only plans it.
   * No IDE features (multi-tab, history, rewrite, formatting) belong here.
   */
  let {
    sql = $bindable(""),
    disabled = true,
    loading = false,
    disabledReason = null,
    onAnalyze = () => {},
  } = $props();

  function handleKeydown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (!disabled && !loading) onAnalyze();
    }
  }
</script>

<section class="panel sql-panel">
  <header class="panel-head">
    <h2>SQL Input</h2>
    <span class="hint">只提交给宿主生成 Estimated Plan，不执行 SQL</span>
  </header>

  <div class="body">
    <textarea
      bind:value={sql}
      onkeydown={handleKeydown}
      spellcheck="false"
      rows="7"
      placeholder="SELECT ..."
      aria-label="要分析执行计划的 SQL"
    ></textarea>

    <div class="actions">
      <button type="button" class="analyze" onclick={onAnalyze} disabled={disabled || loading}>
        {loading ? "Analyzing…" : "Analyze Plan / 分析执行计划"}
      </button>
      <span class="shortcut hint">Ctrl/Cmd + Enter</span>
      {#if disabled && disabledReason}
        <span class="reason">{disabledReason}</span>
      {/if}
    </div>
  </div>
</section>

<style>
  .body {
    padding: 10px 12px 12px;
  }

  textarea {
    display: block;
    width: 100%;
    min-height: 120px;
    padding: 8px 10px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface-muted);
    color: var(--pd-text);
    font-family: var(--pd-mono);
    font-size: 12px;
    line-height: 1.5;
    resize: vertical;
  }

  textarea:focus {
    outline: 2px solid var(--pd-accent);
    outline-offset: -1px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }

  .analyze {
    padding: 5px 12px;
    border: 1px solid var(--pd-accent);
    border-radius: 6px;
    background: var(--pd-accent);
    color: #fff;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .analyze:disabled {
    border-color: var(--pd-border-strong);
    background: var(--pd-surface-muted);
    color: var(--pd-muted);
    cursor: default;
  }

  .reason {
    color: var(--pd-muted);
    font-size: 11px;
  }
</style>
