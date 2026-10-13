<script>
  /**
   * Hotspots: deterministic attention list produced by the core.
   *
   * Findings answer "which known rule fired"; hotspots answer "where to look
   * first". This component only renders the core's reasons and evidence, adds
   * the finding cross-reference as a lookup and never ranks or advises.
   */
  import { createTranslator } from "../lib/i18n/index.js";

  let { locale = "zh-CN", view = { items: [], costNote: null }, counts = { total: 0 }, selectedNodeId = null, onSelectNode = () => {} } = $props();
  const t = $derived(createTranslator(locale).t);
</script>

<section class="panel hotspots-panel">
  <header class="panel-head">
    <h2>{t("hotspots.title")}</h2>
    <span class="total mono">{counts.total}</span>
    <span class="severity-summary">
      {#if counts.high}<span class="badge high">{t("severity.high")} {counts.high}</span>{/if}
      {#if counts.warning}<span class="badge warning">{t("severity.warning")} {counts.warning}</span>{/if}
      {#if counts.info}<span class="badge info">{t("severity.info")} {counts.info}</span>{/if}
    </span>
    <span class="hint">{t("hotspots.hint")}</span>
  </header>

  {#if view.costNote}
    <p class="cost-note">{view.costNote}</p>
  {/if}

  {#if view.items.length === 0}
    <p class="empty">
      {t("hotspots.empty")}
    </p>
  {:else}
    <ol class="hotspot-list">
      {#each view.items as item (item.id)}
        <li class="hotspot" class:active={item.nodeId === selectedNodeId}>
          <button
            type="button"
            class="hotspot-head"
            aria-label={t("hotspots.openNode", { node: item.nodeLabel })}
            onclick={() => onSelectNode(item.nodeId)}
          >
            <span class="rank mono">#{item.rank}</span>
            <span class="badge {item.level}">{t(`severity.${item.level}`)}</span>
            <span class="hotspot-node">{item.nodeLabel}</span>
            <span class="hotspot-ref mono">{item.nodeId}</span>
          </button>

          <ul class="reasons">
            {#each item.reasons as reason (reason.code)}
              <li class="reason">
                <div class="reason-line">
                  <span class="badge {reason.level}">{t(`severity.${reason.level}`)}</span>
                  <span class="reason-human">{reason.summary ?? reason.statement}</span>
                </div>
                {#if reason.summary}
                  <div class="reason-text">{reason.statement}</div>
                {/if}
                {#if reason.caveat}
                  <div class="reason-caveat">{reason.caveat}</div>
                {/if}
                <div class="reason-meta mono">{reason.code} · {reason.source}</div>
              </li>
            {/each}
          </ul>

          {#if item.findingRuleIds.length > 0}
            <p class="cross-ref">
              {t("hotspots.findingsCrossReference")}
              {#each item.findingRuleIds as ruleId (ruleId)}<span class="mono chip">{ruleId}</span>{/each}
            </p>
          {/if}

          <details class="evidence">
            <summary>{t("diagnosis.section.evidence", { count: item.evidence.length })}{item.estimateOnly ? ` · ${t("hotspots.tooltip.estimateOnly")}` : ""}</summary>
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

  .reason-human {
    font-size: 12px;
  }

  .reason-text {
    margin-top: 2px;
    color: var(--pd-muted);
    font-size: 11px;
  }

  .reason-caveat {
    margin-top: 2px;
    color: var(--pd-muted);
    font-size: 11px;
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
