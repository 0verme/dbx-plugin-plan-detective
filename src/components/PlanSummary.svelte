<script>
  /**
   * Plan Summary: renders the metrics the offline core already computed.
   * It does not score, rank or re-derive anything.
   */
  import { createTranslator } from "../lib/i18n/index.js";

  let {
    locale = "zh-CN",
    summary = null,
    findingCount = 0,
    selectedNodeId = null,
    onSelectNode = () => {},
  } = $props();
  const t = $derived(createTranslator(locale).t);
  const primaryMetricKeys = ["totalEstimatedCost", "rootEstimatedRows", "nodeCount"];
</script>

<section class="panel summary-panel">
  <header class="panel-head">
    <h2>{t("summary.title")}</h2>
    <span class="hint">{t("summary.source")}</span>
  </header>

  {#if summary}
    <dl class="key-metrics" aria-label={t("summary.keyMetrics.ariaLabel")}>
      {#each summary.rows as row (row.key)}
        {#if primaryMetricKeys.includes(row.key)}
          <div
            class="key-metric"
            class:cost={row.key === "totalEstimatedCost"}
            title={row.hint}
          >
            <dt class="key-label">{row.label}</dt>
            <dd class:missing={row.value === null}>{row.value ?? "—"}</dd>
            {#if row.key === "totalEstimatedCost"}
              <span class="key-hint">{row.hint}</span>
            {/if}
          </div>
        {/if}
      {/each}
      <div class="key-metric findings-count">
        <dt class="key-label">{t("findings.title")}</dt>
        <dd>{findingCount ?? 0}</dd>
      </div>
    </dl>

    <details class="secondary-details">
      <summary>{t("summary.secondary")}</summary>
      <dl class="metrics">
        {#each summary.rows as row (row.key)}
          {#if !primaryMetricKeys.includes(row.key)}
            <div class="metric" title={row.hint}>
              <dt>{row.label}</dt>
              <dd class:missing={row.value === null}>{row.value ?? "—"}</dd>
            </div>
          {/if}
        {/each}
      </dl>

      <h3 class="subhead">{t("summary.highlights")}</h3>
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
              {#if highlight.note}
                <span class="hl-note">{highlight.note}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </details>
  {:else}
    <p class="empty">{t("summary.empty")}</p>
  {/if}
</section>

<style>
  .key-metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    margin: 0;
    padding: 8px 10px 10px;
  }

  .key-metric {
    display: flex;
    min-width: 0;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    padding: 6px 8px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface-muted);
  }

  .key-metric.cost,
  .key-metric.findings-count {
    grid-column: 1 / -1;
  }

  .key-label {
    color: var(--pd-muted);
    font-size: 11px;
  }

  .key-metric dd {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: 15px;
    font-variant-numeric: tabular-nums;
    font-weight: 650;
  }

  .key-metric.cost dd {
    font-size: 18px;
  }

  .key-metric dd.missing {
    color: var(--pd-muted);
    font-weight: 400;
  }

  .key-hint {
    color: var(--pd-muted);
    font-size: 10px;
    line-height: 1.35;
  }

  .secondary-details > summary {
    padding: 8px 12px;
    border-top: 1px solid var(--pd-border);
    color: var(--pd-muted);
    font-size: 11px;
    font-weight: 650;
    cursor: pointer;
    user-select: none;
  }

  .metrics {
    margin: 0;
    padding: 4px 12px 8px;
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

  .hl-note {
    grid-column: 1 / -1;
    color: var(--pd-muted);
    font-size: 11px;
    line-height: 1.4;
  }
</style>
