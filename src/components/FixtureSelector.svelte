<script>
  import { countByMode, filterCatalog, findCatalogEntry } from "../lib/fixture-catalog.js";

  /**
   * Fixture picker for the offline / demo mode. The catalog is embedded at
   * build time from fixtures/postgres/**; provenance is shown as-is and
   * synthetic fixtures are clearly marked.
   */
  let { catalog = [], selectedId = null, onSelect = () => {} } = $props();

  let mode = $state("all");
  let query = $state("");

  const counts = $derived(countByMode(catalog));
  const filtered = $derived(filterCatalog(catalog, { mode, query }));
  const selected = $derived(findCatalogEntry(catalog, selectedId));

  const tabs = $derived([
    { id: "all", label: `全部 ${counts.total}` },
    { id: "estimated", label: `estimated ${counts.estimated}` },
    { id: "actual", label: `actual ${counts.actual}` },
  ]);
</script>

<section class="panel fixture-panel">
  <header class="panel-head">
    <h2>Fixture</h2>
    <span class="hint">仓库内离线样本，仅用于开发与演示</span>
  </header>

  <div class="controls">
    <div class="tabs" role="tablist" aria-label="fixture mode">
      {#each tabs as tab (tab.id)}
        <button
          type="button"
          role="tab"
          aria-selected={mode === tab.id}
          class="tab"
          class:active={mode === tab.id}
          onclick={() => (mode = tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </div>
    <input
      class="search"
      type="search"
      placeholder="搜索 fixture / SQL / feature…"
      bind:value={query}
      aria-label="搜索 fixture"
    />
  </div>

  <div class="body">
    <ul class="list">
      {#each filtered as entry (entry.id)}
        <li>
          <button
            type="button"
            class="item"
            class:active={entry.id === selectedId}
            aria-current={entry.id === selectedId}
            onclick={() => onSelect(entry.id)}
          >
            <span class="item-name mono">{entry.id}</span>
            <span class="item-meta">
              <span class="muted">{entry.rootNodeType}</span>
              {#if entry.isSynthetic}<span class="badge synthetic">synthetic</span>{/if}
            </span>
          </button>
        </li>
      {:else}
        <li class="empty">没有匹配的 fixture</li>
      {/each}
    </ul>

    {#if selected}
      <div class="detail">
        <div class="detail-grid">
          <span class="key">database</span>
          <span class="value mono">{selected.database}{selected.databaseVersion ? ` ${selected.databaseVersion}` : ""}</span>
          <span class="key">mode</span>
          <span class="value mono">{selected.mode}</span>
          <span class="key">root</span>
          <span class="value">{selected.rootNodeType}</span>
          <span class="key">provenance</span>
          <span class="value">
            <span class="badge {selected.provenance.kind}">{selected.provenance.kind}</span>
          </span>
          <span class="key">capturedAt</span>
          <span class="value mono">{selected.capturedAt ?? "—"}</span>
        </div>

        {#if selected.captureCommand}
          <p class="source-row">
            <span class="key">captureCommand</span>
            <code>{selected.captureCommand}</code>
          </p>
        {/if}
        {#if selected.sql}
          <p class="source-row">
            <span class="key">SQL</span>
            <code>{selected.sql}</code>
          </p>
        {/if}

        <ul class="features">
          {#each selected.features as feature (feature)}
            <li>{feature}</li>
          {/each}
        </ul>

        <p class="provenance">{selected.provenance.detail}</p>
        {#if selected.provenance.reference}
          <p class="provenance mono">{selected.provenance.reference}</p>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--pd-border);
  }

  .tabs {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface-muted);
  }

  .tab {
    border: 0;
    border-radius: 4px;
    padding: 3px 9px;
    background: transparent;
    color: var(--pd-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .tab.active {
    background: var(--pd-surface);
    color: var(--pd-text);
    box-shadow: 0 1px 2px rgb(16 24 40 / 0.08);
  }

  .search {
    flex: 1 1 200px;
    min-width: 160px;
    padding: 4px 8px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface);
    color: inherit;
    font: inherit;
    font-size: 12px;
  }

  .body {
    display: grid;
    grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
  }

  .list {
    max-height: 260px;
    margin: 0;
    padding: 6px;
    overflow: auto;
    border-right: 1px solid var(--pd-border);
    list-style: none;
  }

  .item {
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: 1px;
    padding: 5px 8px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }

  .item:hover {
    background: var(--pd-surface-muted);
  }

  .item.active {
    border-color: var(--pd-accent);
    background: var(--pd-accent-soft);
  }

  .item-name {
    font-size: 12px;
  }

  .item-meta {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 11px;
  }

  .detail {
    min-width: 0;
    padding: 10px 12px;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 3px 12px;
    margin-bottom: 8px;
  }

  .key {
    color: var(--pd-muted);
    font-size: 11px;
    font-family: var(--pd-mono);
  }

  .value {
    min-width: 0;
    word-break: break-word;
  }

  .source-row {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 12px;
    margin: 0 0 6px;
  }

  .source-row code {
    overflow-wrap: anywhere;
    font-size: 12px;
  }

  .features {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 8px 0;
    padding: 0;
    list-style: none;
  }

  .features li {
    padding: 1px 7px;
    border: 1px solid var(--pd-border);
    border-radius: 999px;
    background: var(--pd-surface-muted);
    color: var(--pd-muted);
    font-size: 11px;
  }

  .provenance {
    margin: 6px 0 0;
    color: var(--pd-muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  @media (max-width: 760px) {
    .body {
      grid-template-columns: minmax(0, 1fr);
    }

    .list {
      max-height: 200px;
      border-right: 0;
      border-bottom: 1px solid var(--pd-border);
    }
  }
</style>
