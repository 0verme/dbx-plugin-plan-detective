<script>
  /**
   * Connection Context: what DBX already knows about the current connection.
   *
   * The plugin never opens, tests or manages a connection and never asks for a
   * credential. When the DBX workbench context carries a connectionId (the
   * result-view entry does), it is used as-is; otherwise the user may type the
   * connection id of an already-open connection. Capability state comes from
   * `getPlanCapabilities` in the parent.
   */
  let {
    contextView = { connectionId: null, database: null, schema: null, contextSql: null, hasConnection: false, source: "none" },
    manualConnectionId = $bindable(""),
    capabilities = null,
    capabilityState = "idle",
    capabilityError = null,
    onRefresh = () => {},
  } = $props();

  const sourceLabel = $derived(
    contextView.source === "result-view"
      ? "来自 DBX 查询结果上下文"
      : contextView.source === "workbench"
        ? "来自 DBX workbench 上下文"
        : "当前上下文未提供连接",
  );
</script>

<section class="panel context-panel">
  <header class="panel-head">
    <h2>Connection Context</h2>
    <span class="hint">只读引用 DBX 已打开的连接</span>
  </header>

  <div class="body">
    <p class="source {contextView.hasConnection ? 'ok' : 'warn'}">{sourceLabel}</p>

    {#if contextView.hasConnection}
      <dl class="facts">
        <div class="fact">
          <dt>Connection</dt>
          <dd class="mono">{contextView.connectionId}</dd>
        </div>
        {#if contextView.database}
          <div class="fact">
            <dt>Database</dt>
            <dd class="mono">{contextView.database}</dd>
          </div>
        {/if}
        {#if contextView.schema}
          <div class="fact">
            <dt>Schema</dt>
            <dd class="mono">{contextView.schema}</dd>
          </div>
        {/if}
      </dl>
    {:else}
      <label class="manual">
        <span>Connection ID（仅引用已打开连接）</span>
        <input
          type="text"
          bind:value={manualConnectionId}
          placeholder="例如 conn-1"
          spellcheck="false"
          autocomplete="off"
        />
      </label>
      <p class="manual-hint">
        插件不创建连接、不读取凭据。若从 DBX 查询结果页打开 Plan Detective，connectionId 会自动带入。
      </p>
    {/if}

    <div class="cap-head">
      <span class="cap-title">Plan Capabilities</span>
      <button type="button" class="refresh" onclick={onRefresh} disabled={!contextView.hasConnection && !manualConnectionId.trim()}>
        刷新
      </button>
    </div>

    {#if capabilityState === "loading"}
      <p class="cap-state">正在读取宿主能力…</p>
    {:else if capabilityState === "error"}
      <p class="cap-state error">{capabilityError?.message ?? "读取能力失败"}</p>
    {:else if capabilities}
      <dl class="facts">
        <div class="fact">
          <dt>dbType</dt>
          <dd class="mono">{capabilities.dbType}{capabilities.dbVersion ? ` · ${capabilities.dbVersion}` : ""}</dd>
        </div>
        <div class="fact">
          <dt>estimatedPlan</dt>
          <dd>
            <span class="badge {capabilities.estimatedPlan ? 'info' : 'warning'}">
              {capabilities.estimatedPlan ? "supported" : "unsupported"}
            </span>
          </dd>
        </div>
        <div class="fact">
          <dt>limits</dt>
          <dd class="mono">timeout ≤ {capabilities.maxTimeoutMs} ms · plan ≤ {capabilities.maxPlanBytes}</dd>
        </div>
      </dl>
    {:else}
      <p class="cap-state">尚未读取。输入 connectionId 后自动读取。</p>
    {/if}
  </div>
</section>

<style>
  .body {
    padding: 10px 12px 12px;
  }

  .source {
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 600;
  }

  .source.ok {
    color: var(--pd-ok-fg);
  }

  .source.warn {
    color: var(--pd-warning-fg);
  }

  .facts {
    display: grid;
    gap: 4px;
    margin: 0;
  }

  .fact {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: 6px;
    align-items: baseline;
  }

  .fact dt {
    color: var(--pd-muted);
    font-size: 11px;
  }

  .fact dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .manual {
    display: block;
  }

  .manual span {
    display: block;
    margin-bottom: 3px;
    color: var(--pd-muted);
    font-size: 11px;
  }

  .manual input {
    width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface-muted);
    color: var(--pd-text);
    font: inherit;
    font-family: var(--pd-mono);
    font-size: 12px;
  }

  .manual-hint {
    margin: 5px 0 0;
    color: var(--pd-muted);
    font-size: 11px;
  }

  .cap-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 12px 0 6px;
    padding-top: 8px;
    border-top: 1px solid var(--pd-border);
  }

  .cap-title {
    color: var(--pd-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .refresh {
    padding: 2px 8px;
    border: 1px solid var(--pd-border);
    border-radius: 5px;
    background: var(--pd-surface);
    color: var(--pd-text);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .refresh:disabled {
    color: var(--pd-muted);
    cursor: default;
  }

  .cap-state {
    margin: 0;
    color: var(--pd-muted);
    font-size: 12px;
  }

  .cap-state.error {
    color: var(--pd-high-fg);
  }
</style>
