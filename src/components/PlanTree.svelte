<script>
  import { formatNumber } from "../lib/format.js";
  import { visibleTreeRows } from "../lib/view-model.js";

  /**
   * Plan Tree: a scannable nested list of rows, no canvas / DAG. Collapse
   * state and finding markers come from the pure view model.
   */
  let {
    rows = [],
    collapsed = new Set(),
    selectedId = null,
    findingsByNodeRef = new Map(),
    onSelect = () => {},
    onToggle = () => {},
  } = $props();

  const visible = $derived(visibleTreeRows(rows, collapsed));

  /**
   * @param {KeyboardEvent} event
   * @param {{ id: string, hasChildren: boolean }} row
   */
  function handleKeydown(event, row) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(row.id);
      return;
    }
    if (!row.hasChildren) return;
    if (event.key === "ArrowRight" && collapsed.has(row.id)) {
      event.preventDefault();
      onToggle(row.id);
    } else if (event.key === "ArrowLeft" && !collapsed.has(row.id)) {
      event.preventDefault();
      onToggle(row.id);
    }
  }
</script>

<section class="panel tree-panel">
  <header class="panel-head">
    <h2>Plan Tree</h2>
    <span class="hint">{rows.length} nodes · 点击节点查看右侧字段</span>
  </header>

  <div class="tree" role="tree" aria-label="Plan tree">
    {#each visible as row (row.id)}
      {@const finding = findingsByNodeRef.get(row.id)}
      <div
        class="tree-row"
        class:selected={row.id === selectedId}
        style="--depth: {row.depth}"
        role="treeitem"
        aria-selected={row.id === selectedId}
        aria-level={row.depth + 1}
        aria-expanded={row.hasChildren ? !collapsed.has(row.id) : undefined}
        tabindex="0"
        onclick={() => onSelect(row.id)}
        onkeydown={(event) => handleKeydown(event, row)}
      >
        <span class="caret-cell">
          {#if row.hasChildren}
            <button
              type="button"
              class="caret"
              aria-label={collapsed.has(row.id) ? "展开子树" : "折叠子树"}
              aria-expanded={!collapsed.has(row.id)}
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

        <span class="label">{row.label}</span>

        {#if finding}
          <span class="badge {finding.severity}" title="{finding.count} finding(s) on this node">
            {finding.count}
          </span>
        {/if}

        <span class="metric mono">
          {row.estimatedRows === null ? "" : `rows ≈ ${formatNumber(row.estimatedRows)}`}
        </span>
        <span class="metric mono">
          {row.totalCost === null ? "" : `cost ${formatNumber(row.totalCost)}`}
        </span>
      </div>
    {/each}
  </div>
</section>

<style>
  .tree {
    max-height: 52vh;
    padding: 4px 0;
    overflow: auto;
  }

  .tree-row {
    display: grid;
    grid-template-columns: 20px minmax(140px, 1fr) auto auto auto;
    gap: 8px;
    align-items: center;
    padding: 3px 10px 3px calc(4px + var(--depth) * 15px);
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
    overflow-wrap: anywhere;
  }

  .metric {
    color: var(--pd-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  @media (max-width: 760px) {
    .tree-row {
      grid-template-columns: 20px minmax(120px, 1fr) auto;
    }

    .metric {
      display: none;
    }
  }
</style>
