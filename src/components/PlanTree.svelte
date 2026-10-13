<script>
  import { tick } from "svelte";
  import { formatNumber } from "../lib/format.js";
  import { treeKeyboardAction, visibleTreeRows } from "../lib/view-model.js";
  import { createTranslator } from "../lib/i18n/index.js";

  /**
   * Plan Tree: a scannable nested list of rows, no canvas / DAG. Collapse
   * state, finding and hotspot markers come from the pure view model.
   */
  let {
    locale = "zh-CN",
    rows = [],
    collapsed = new Set(),
    selectedId = null,
    findingsByNodeRef = new Map(),
    hotspotsByNodeRef = new Map(),
    onSelect = () => {},
    onToggle = () => {},
  } = $props();

  const visible = $derived(visibleTreeRows(rows, collapsed));
  const activeTreeRowId = $derived(visible.some((row) => row.id === selectedId) ? selectedId : (visible[0]?.id ?? null));
  const t = $derived(createTranslator(locale).t);
  let treeElement = $state(null);

  $effect(() => {
    const nodeId = selectedId;
    const tree = treeElement;
    if (nodeId === null || tree === null) return;

    void tick().then(() => {
      const target = Array.from(tree.querySelectorAll("[data-node-id]")).find((element) => element.dataset.nodeId === nodeId);
      target?.scrollIntoView({ block: "nearest" });
    });
  });

  function focusTreeRow(event, nodeId) {
    const tree = event.currentTarget.closest('[role="tree"]');
    const target = Array.from(tree?.querySelectorAll("[data-node-id]") ?? []).find((element) => element.dataset.nodeId === nodeId);
    onSelect(nodeId);
    target?.focus();
  }

  /** @param {KeyboardEvent} event @param {{ id: string }} row */
  function handleKeydown(event, row) {
    if (event.target !== event.currentTarget) return;

    const action = treeKeyboardAction(rows, row.id, event.key, collapsed);
    if (action === null) return;
    event.preventDefault();
    if (action.type === "toggle") onToggle(action.nodeId);
    else if (action.type === "select") focusTreeRow(event, action.nodeId);
  }
</script>

<section class="panel tree-panel">
  <header class="panel-head">
    <h2>{t("tree.title")}</h2>
    <span class="hint">{t("tree.hint", { count: rows.length })}</span>
  </header>

  <div bind:this={treeElement} class="tree" role="tree" aria-label={t("tree.ariaLabel")}>
    {#each visible as row (row.id)}
      {@const finding = findingsByNodeRef.get(row.id)}
      {@const hotspot = hotspotsByNodeRef.get(row.id)}
      <div
        class="tree-row"
        class:selected={row.id === selectedId}
        style="--depth: {row.depth}"
        role="treeitem"
        data-node-id={row.id}
        aria-selected={row.id === selectedId}
        aria-level={row.depth + 1}
        aria-expanded={row.hasChildren ? !collapsed.has(row.id) : undefined}
        tabindex={row.id === activeTreeRowId ? 0 : -1}
        onclick={() => onSelect(row.id)}
        onkeydown={(event) => handleKeydown(event, row)}
      >
        <span class="caret-cell">
          {#if row.hasChildren}
            <button
              type="button"
              class="caret"
              aria-label={collapsed.has(row.id) ? t("tree.expand") : t("tree.collapse")}
              aria-expanded={!collapsed.has(row.id)}
              tabindex="-1"
              onclick={(event) => {
                event.stopPropagation();
                onToggle(row.id);
              }}
            >
              {collapsed.has(row.id) ? "▸" : "▾"}
            </button>
          {:else}
            <span class="caret-space" aria-hidden="true"></span>
          {/if}
        </span>

        <span class="label">
          {#if hotspot}
            <span class="hotspot-marker {hotspot.level}" title={t("tree.hotspots.tooltip", { count: hotspot.count })}>◆</span>
          {/if}
          {row.label}
        </span>

        {#if finding}
          <span class="badge {finding.severity}" title={t("tree.findings.tooltip", { count: finding.count })}>
            {finding.count}
          </span>
        {/if}

        <span class="metric mono">
          {row.estimatedRows === null ? "" : t("tree.rows", { value: formatNumber(row.estimatedRows) })}
        </span>
        <span class="metric mono">
          {row.totalCost === null ? "" : t("tree.cost", { value: formatNumber(row.totalCost) })}
        </span>
      </div>
    {/each}
  </div>
</section>

<style>
  .tree {
    max-height: 52vh;
    padding: 4px 0;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .tree-row {
    display: flex;
    flex-wrap: wrap;
    min-width: 0;
    gap: 4px 8px;
    align-items: center;
    padding: 3px 10px 3px calc(4px + min(var(--depth), 6) * 12px);
    border-left: 2px solid transparent;
    cursor: pointer;
  }

  .tree-row:hover {
    background: var(--pd-surface-muted);
  }

  .tree-row:focus-visible {
    outline: 2px solid var(--pd-accent);
    outline-offset: -2px;
  }

  .tree-row.selected {
    border-left-color: var(--pd-accent);
    background: var(--pd-accent-soft);
  }

  .caret-cell {
    display: inline-flex;
    flex: 0 0 20px;
    justify-content: center;
  }

  .caret {
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--pd-muted);
    font-size: 10px;
    line-height: 1;
    cursor: pointer;
  }

  .caret:hover {
    background: var(--pd-border);
  }

  .caret-space {
    display: inline-block;
    width: 16px;
  }

  .label {
    min-width: 0;
    flex: 1 1 120px;
    overflow-wrap: anywhere;
  }

  .tree-row > .badge {
    flex: 0 0 auto;
  }

  .hotspot-marker {
    margin-right: 4px;
    font-size: 10px;
  }

  .hotspot-marker.high {
    color: var(--pd-high-fg);
  }

  .hotspot-marker.warning {
    color: var(--pd-warning-fg);
  }

  .hotspot-marker.info {
    color: var(--pd-info-fg);
  }

  .metric {
    min-width: 0;
    max-width: 100%;
    flex: 0 1 auto;
    color: var(--pd-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
</style>
