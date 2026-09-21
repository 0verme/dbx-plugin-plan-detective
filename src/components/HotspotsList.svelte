<script>
  /**
   * Hotspots: deterministic attention list produced by the core.
   *
   * Findings answer "which known rule fired"; hotspots answer "where to look
   * first". This component only renders the core's reasons and evidence, adds
   * the finding cross-reference as a lookup and never ranks or advises.
   */
  let { view = { items: [], costNote: null }, counts = { total: 0 }, selectedNodeId = null, onSelectNode = () => {} } = $props();
</script>

<section class="panel hotspots-panel">
  <header class="panel-head">
    <h2>Hotspots</h2>
    <span class="total mono">{counts.total}</span>
    <span class="severity-summary">
      {#if counts.high}<span class="badge high">high {counts.high}</span>{/if}
      {#if counts.warning}<span class="badge warning">warning {counts.warning}</span>{/if}
      {#if counts.info}<span class="badge info">info {counts.info}</span>{/if}
    </span>
    <span class="hint">确定性信号聚合的注意力顺序，不是性能评分，也不等于 Finding</span>
  </header>

  {#if view.costNote}
    <p class="cost-note">{view.costNote}</p>
  {/if}

  {#if view.items.length === 0}
    <p class="empty">
      当前计划没有达到阈值的 hotspot 节点。Hotspot 只聚合确定性信号；空结果不代表计划没有问题。
    </p>
  {:else}
    <ol class="hotspot-list">
      {#each view.items as item (item.id)}
        <li class="hotspot" class:active={item.nodeId === selectedNodeId}>
          <button type="button" class="hotspot-head" onclick={() => onSelectNode(item.nodeId)}>
            <span class="rank mono">#{item.rank}</span>
            <span class="badge {item.level}">{item.level}</span>
            <span class="hotspot-node">{item.nodeLabel}</span>
            <span class="hotspot-ref mono">{item.nodeId}</span>
          </button>

          <ul class="reasons">
            {#each item.reasons as reason (reason.code)}
              <li class="reason">
                <div class="reason-line">
                  <span class="badge {reason.level}">{reason.level}</span>
                  <span class="reason-text">{reason.statement}</span>
                </div>
                <div class="reason-meta mono">{reason.code} · {reason.source}</div>
              </li>
            {/each}
          </ul>

          {#if item.findingRuleIds.length > 0}
            <p class="cross-ref">
              同时命中 Finding 规则：
              {#each item.findingRuleIds as ruleId (ruleId)}<span class="mono chip">{ruleId}</span>{/each}
            </p>
          {/if}

          <details class="evidence">
            <summary>Evidence · {item.evidence.length} 项{item.estimateOnly ? " · Estimated Plan（非 runtime truth）" : ""}</summary>
            <dl class="evidence-list">
              {#each item.evidence as row (row.path)}
                <div class="evidence-row" style="--depth: {row.depth}">
                  <dt class="mono">{row.path}</dt>
                  <dd class="mono">{row.value}</dd>
                </div>
              {/each}
            </dl>
          </details>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .total {
    padding: 0 6px;
    border-radius: 999px;
    background: var(--pd-surface-muted);
    color: var(--pd-muted);
    font-size: 11px;
    font-weight: 600;
  }

  .severity-summary {
    display: inline-flex;
    gap: 4px;
    margin-left: auto;
  }

  .cost-note {
    margin: 0;
    padding: 8px 12px;
    border-bottom: 1px solid var(--pd-border);
    background: var(--pd-surface-muted);
    color: var(--pd-muted);
    font-size: 12px;
  }

  .hotspot-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 10px;
    list-style: none;
  }

  .hotspot {
    min-width: 0;
    border: 1px solid var(--pd-border);
    border-left: 3px solid var(--pd-border-strong);
    border-radius: 6px;
    background: var(--pd-surface-muted);
  }

  .hotspot.high {
    border-left-color: var(--pd-high-fg);
  }

  .hotspot.warning {
    border-left-color: var(--pd-warning-fg);
  }

  .hotspot.info {
    border-left-color: var(--pd-info-fg);
  }

  .hotspot.active {
    border-color: var(--pd-accent);
    border-left-color: var(--pd-accent);
    background: var(--pd-accent-soft);
  }

  .hotspot-head {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    width: 100%;
    padding: 7px 10px;
    border: 0;
    border-bottom: 1px solid var(--pd-border);
    background: transparent;
    color: inherit;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }

  .hotspot-head:hover .hotspot-node {
    text-decoration: underline;
  }

  .rank {
    color: var(--pd-muted);
    font-size: 11px;
  }

  .hotspot-node {
    font-weight: 650;
  }

  .hotspot-ref {
    margin-left: auto;
    color: var(--pd-muted);
    font-size: 11px;
  }

  .reasons {
    margin: 0;
    padding: 8px 10px;
    list-style: none;
  }

  .reason + .reason {
    margin-top: 6px;
  }

  .reason-line {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }

  .reason-text {
    font-size: 12px;
  }

  .reason-meta {
    margin-top: 2px;
    color: var(--pd-muted);
    font-size: 11px;
  }

  .cross-ref {
    margin: 0;
    padding: 0 10px 8px;
    color: var(--pd-muted);
    font-size: 11px;
  }

  .chip {
    display: inline-block;
    margin-left: 4px;
    padding: 0 5px;
    border: 1px solid var(--pd-border-strong);
    border-radius: 999px;
    color: var(--pd-text);
  }

  .evidence {
    border-top: 1px solid var(--pd-border);
  }

  .evidence summary {
    padding: 5px 10px;
    color: var(--pd-muted);
    font-size: 11px;
    cursor: pointer;
    user-select: none;
  }

  .evidence-list {
    margin: 0;
    padding: 2px 10px 8px;
  }

  .evidence-row {
    display: grid;
    grid-template-columns: minmax(140px, max-content) minmax(0, 1fr);
    gap: 10px;
    padding: 1px 0 1px calc(var(--depth) * 14px);
    font-size: 11px;
  }

  .evidence-row dt {
    color: var(--pd-muted);
    overflow-wrap: anywhere;
  }

  .evidence-row dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  @media (max-width: 899px) {
    .evidence-row {
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
    }
  }
</style>
