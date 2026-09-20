<script>
  /**
   * Plan Summary: renders the metrics the offline core already computed.
   * It does not score, rank or re-derive anything.
   */
  let { summary = null, selectedNodeId = null, onSelectNode = () => {} } = $props();
</script>

<section class="panel summary-panel">
  <header class="panel-head">
    <h2>Plan Summary</h2>
    <span class="hint">来自 Core Metrics</span>
  </header>

  {#if summary}
    <dl class="metrics">
      {#each summary.rows as row (row.key)}
        <div class="metric" title={row.hint}>
          <dt>{row.label}</dt>
          <dd class:missing={row.value === null}>{row.value ?? "—"}</dd>
        </div>
      {/each}
    </dl>

    <h3 class="subhead">Highlights</h3>
    <ul class="highlights">
      {#each summary.highlights as highlight (highlight.key)}
        <li>
          <button
            type="button"
            class="highlight"
            class:active={highlight.node !== null && highlight.node.nodeId === selectedNodeId}
            disabled={highlight.node === null}
            onclick={() => highlight.node && onSelectNode(highlight.node.nodeId)}
          >
            <span class="hl-label">{highlight.label}</span>
            {#if highlight.node}
              <span class="hl-node mono">
                {highlight.node.nodeId} · {highlight.node.nodeType}{highlight.node.relation ? ` · ${highlight.node.relation}` : ""}
              </span>
            {/if}
            <span class="hl-value">{highlight.value ?? "—"}</span>
            {#if highlight.detail}
              <span class="hl-detail">{highlight.detail}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">尚无分析结果。</p>
  {/if}
</section>

<style>
  .metrics {
    margin: 0;
    padding: 6px 12px 10px;
  }

  .metric {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 2px 0;
    border-bottom: 1px dashed var(--pd-border);
  }

  .metric:last-child {
    border-bottom: 0;
  }

  .metric dt {
    color: var(--pd-muted);
    font-size: 12px;
  }

  .metric dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .metric dd.missing {
    color: var(--pd-muted);
    font-weight: 400;
  }

  .subhead {
    margin: 0;
    padding: 8px 12px 0;
    border-top: 1px solid var(--pd-border);
    color: var(--pd-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .highlights {
    margin: 0;
    padding: 4px 8px 10px;
    list-style: none;
  }

  .highlight {
    display: grid;
    width: 100%;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0 8px;
    padding: 5px 6px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }

  .highlight:disabled {
    cursor: default;
  }

  .highlight:not(:disabled):hover {
    background: var(--pd-surface-muted);
  }

  .highlight.active {
    border-color: var(--pd-accent);
    background: var(--pd-accent-soft);
  }

  .hl-label {
    grid-column: 1;
    color: var(--pd-muted);
    font-size: 12px;
  }

  .hl-value {
    grid-column: 2;
    grid-row: 1;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .hl-node {
    grid-column: 1;
    overflow: hidden;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hl-detail {
    grid-column: 2;
    color: var(--pd-muted);
    font-size: 11px;
    text-align: right;
  }
</style>
