<script>
  /**
   * Node Inspector: every field the selected node actually reported. Missing
   * values were already dropped by the view model, so the panel never shows
   * `undefined` / `null` placeholders.
   */
  let { inspector = null, nodeFindings = [] } = $props();
</script>

<section class="panel inspector-panel">
  <header class="panel-head">
    <h2>Node Inspector</h2>
    {#if inspector}<span class="hint mono">{inspector.id}</span>{/if}
  </header>

  {#if !inspector}
    <p class="empty">点击计划树中的节点，查看该节点由 plan 实际报告的字段。</p>
  {:else}
    <div class="node-head">
      <span class="node-title">{inspector.title}</span>
      {#if inspector.subtitle}<span class="node-subtitle mono">{inspector.subtitle}</span>{/if}
    </div>

    {#each inspector.groups as group (group.key)}
      <h3 class="group-title">{group.label}</h3>
      <dl class="field-list">
        {#each group.fields as field (field.label)}
          <div class="field">
            <dt>{field.label}</dt>
            <dd class="mono">{field.value}</dd>
          </div>
        {/each}
      </dl>
    {/each}

    {#if nodeFindings.length > 0}
      <h3 class="group-title">Findings on this node</h3>
      <ul class="node-findings">
        {#each nodeFindings as finding (finding.id)}
          <li>
            <span class="badge {finding.severity}">{finding.severity}</span>
            <span class="mono">{finding.ruleId}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .node-head {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--pd-border);
    background: var(--pd-surface-muted);
  }

  .node-title {
    font-weight: 650;
    overflow-wrap: anywhere;
  }

  .node-subtitle {
    color: var(--pd-muted);
    font-size: 11px;
  }

  .group-title {
    margin: 0;
    padding: 8px 12px 2px;
    color: var(--pd-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .field-list {
    margin: 0;
    padding: 0 12px 6px;
  }

  .field {
    display: grid;
    grid-template-columns: minmax(96px, max-content) minmax(0, 1fr);
    gap: 10px;
    padding: 2px 0;
    border-bottom: 1px dashed var(--pd-border);
  }

  .field:last-child {
    border-bottom: 0;
  }

  .field dt {
    color: var(--pd-muted);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .field dd {
    margin: 0;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .node-findings {
    margin: 0;
    padding: 0 12px 10px;
    list-style: none;
  }

  .node-findings li {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 2px 0;
    font-size: 11px;
  }
</style>
