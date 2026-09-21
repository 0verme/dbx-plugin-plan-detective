<script>
  /**
   * Findings: the primary user-facing diagnosis area. Structured findings
   * show a localized explanation first; legacy findings keep their old copy.
   * Evidence remains available as technical detail and the UI never changes
   * severity or re-runs rule logic.
   */
  let { views = [], counts = { total: 0 }, selectedNodeRef = null, onSelectNode = () => {} } = $props();
</script>

<section class="panel findings-panel">
  <header class="panel-head">
    <h2>Findings</h2>
    <span class="total mono">{counts.total}</span>
    <span class="severity-summary">
      {#if counts.high}<span class="badge high">high {counts.high}</span>{/if}
      {#if counts.warning}<span class="badge warning">warning {counts.warning}</span>{/if}
      {#if counts.info}<span class="badge info">info {counts.info}</span>{/if}
    </span>
    <span class="hint">规则观察，不等于优化建议；Estimated Plan 不代表 runtime truth</span>
  </header>

  {#if views.length === 0}
    <p class="empty">
      当前 fixture 没有触发任何规则。规则引擎只报告达到阈值的观察，空结果不代表计划没有问题。
    </p>
  {:else}
    <ul class="finding-list">
      {#each views as view (view.id)}
        <li class="finding" class:active={view.nodeRef === selectedNodeRef}>
          <button type="button" class="finding-head" onclick={() => onSelectNode(view.nodeRef)}>
            <span class="badge {view.severity}">{view.severity}</span>
            <span class="finding-title">{view.title}</span>
            <span class="finding-rule mono">{view.ruleId}</span>
            <span class="finding-node mono">{view.nodeLabel}</span>
          </button>
          {#if view.presentation.structured}
            <div class="diagnosis">
              <section class="diagnosis-section">
                <h3>{view.presentation.labels.summary}</h3>
                <p>{view.presentation.summary}</p>
              </section>

              {#if view.presentation.reasons.length > 0}
                <section class="diagnosis-section">
                  <h3>{view.presentation.labels.reasons}</h3>
                  <ul>
                    {#each view.presentation.reasons as reason (reason)}
                      <li>{reason}</li>
                    {/each}
                  </ul>
                </section>
              {/if}

              {#if view.presentation.actions.length > 0}
                <section class="diagnosis-section">
                  <h3>{view.presentation.labels.actions}</h3>
                  <ul>
                    {#each view.presentation.actions as action (action)}
                      <li>{action}</li>
                    {/each}
                  </ul>
                </section>
              {/if}

              {#if view.presentation.caveats.length > 0}
                <section class="diagnosis-section caveats">
                  <h3>{view.presentation.labels.caveats}</h3>
                  <ul>
                    {#each view.presentation.caveats as caveat (caveat)}
                      <li>{caveat}</li>
                    {/each}
                  </ul>
                </section>
              {/if}
            </div>
          {:else}
            <p class="finding-summary">{view.summary}</p>
          {/if}
          <details class="evidence">
            <summary>{view.presentation.labels.technicalDetails} · {view.evidenceSummary}</summary>
            <dl class="evidence-list">
              {#each view.evidence as row (row.path)}
                <div class="evidence-row" style="--depth: {row.depth}">
                  <dt class="mono">{row.path}</dt>
                  <dd class="mono">{row.value}</dd>
                </div>
              {/each}
            </dl>
          </details>
        </li>
      {/each}
    </ul>
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

  .finding-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 10px;
    list-style: none;
  }

  .finding {
    min-width: 0;
    border: 1px solid var(--pd-border);
    border-left: 3px solid var(--pd-border-strong);
    border-radius: 6px;
    background: var(--pd-surface-muted);
  }

  .finding.high {
    border-left-color: var(--pd-high-fg);
  }

  .finding.warning {
    border-left-color: var(--pd-warning-fg);
  }

  .finding.info {
    border-left-color: var(--pd-info-fg);
  }

  .finding.active {
    border-color: var(--pd-accent);
    border-left-color: var(--pd-accent);
    background: var(--pd-accent-soft);
  }

  .finding-head {
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

  .finding-head:hover .finding-title {
    text-decoration: underline;
  }

  .finding-title {
    font-weight: 650;
  }

  .finding-rule,
  .finding-node {
    color: var(--pd-muted);
    font-size: 11px;
  }

  .finding-node {
    margin-left: auto;
    overflow-wrap: anywhere;
    text-align: right;
  }

  .finding-summary {
    margin: 0;
    padding: 8px 10px;
    font-size: 12px;
  }

  .diagnosis {
    padding: 2px 10px 8px;
  }

  .diagnosis-section {
    padding: 6px 0;
  }

  .diagnosis-section + .diagnosis-section {
    border-top: 1px dashed var(--pd-border);
  }

  .diagnosis-section h3 {
    margin: 0 0 2px;
    color: var(--pd-muted);
    font-size: 11px;
    font-weight: 650;
  }

  .diagnosis-section p,
  .diagnosis-section ul {
    margin: 0;
    font-size: 12px;
  }

  .diagnosis-section ul {
    padding-left: 18px;
  }

  .diagnosis-section li + li {
    margin-top: 2px;
  }

  .diagnosis-section.caveats {
    color: var(--pd-muted);
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
