<script>
  import { FIXTURE_CATALOG } from "virtual:plan-detective-fixtures";
  import FixtureSelector from "./components/FixtureSelector.svelte";
  import FindingsList from "./components/FindingsList.svelte";
  import HostAudit from "./components/HostAudit.svelte";
  import NodeInspector from "./components/NodeInspector.svelte";
  import PlanSummary from "./components/PlanSummary.svelte";
  import PlanTree from "./components/PlanTree.svelte";
  import { analyzeFixture, countByMode, findCatalogEntry, pickDefaultFixture } from "./lib/fixture-catalog.js";
  import {
    buildFindingViews,
    buildNodeInspector,
    buildPlanSummary,
    buildTreeRows,
    countFindingsBySeverity,
    expandAncestors,
    groupFindingsByNodeRef,
    indexNodesById,
    indexRowsById,
    toggleCollapsed,
  } from "./lib/view-model.js";

  /**
   * Fixture-driven MVP shell.
   *
   * Data path: fixture (RawPlanInput) -> analyzePlan() (existing offline core)
   * -> pure view model -> components. The UI never talks to DBX, a database or
   * the network; the only data source is the catalog embedded at build time
   * from fixtures/postgres/**.
   */

  const catalog = FIXTURE_CATALOG;
  const catalogCounts = countByMode(catalog);
  const initialEntry = pickDefaultFixture(catalog);

  let view = $state("analysis");
  let selectedFixtureId = $state(initialEntry?.id ?? null);
  let selectedNodeId = $state("0");
  let collapsedIds = $state(new Set());

  const selectedEntry = $derived(findCatalogEntry(catalog, selectedFixtureId));
  const analysis = $derived.by(() => {
    if (selectedEntry === null) return null;
    try {
      return { result: analyzeFixture(selectedEntry), error: null };
    } catch (cause) {
      return { result: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  const result = $derived(analysis?.result ?? null);
  const rows = $derived(result ? buildTreeRows(result.normalized.root) : []);
  const rowsById = $derived(indexRowsById(rows));
  const nodesById = $derived(result ? indexNodesById(result.normalized.root) : new Map());
  const summary = $derived(result ? buildPlanSummary(result.metrics) : null);
  const findingViews = $derived(result ? buildFindingViews(result.findings, rowsById) : []);
  const findingCounts = $derived(countFindingsBySeverity(result?.findings ?? []));
  const findingsByNodeRef = $derived(groupFindingsByNodeRef(result?.findings ?? []));
  const inspector = $derived(result ? buildNodeInspector(nodesById.get(selectedNodeId)) : null);
  const selectedNodeFindings = $derived(findingViews.filter((finding) => finding.nodeRef === selectedNodeId));

  /** @param {string} id */
  function selectFixture(id) {
    if (id === selectedFixtureId) return;
    selectedFixtureId = id;
    selectedNodeId = "0";
    collapsedIds = new Set();
  }

  /** @param {string} nodeId */
  function selectNode(nodeId) {
    if (result === null || nodeId === selectedNodeId) return;
    collapsedIds = expandAncestors(collapsedIds, rowsById.get(nodeId));
    selectedNodeId = nodeId;
  }

  /** @param {string} nodeId */
  function toggleNode(nodeId) {
    collapsedIds = toggleCollapsed(collapsedIds, nodeId);
  }
</script>

<svelte:head><title>DBX Plan Detective</title></svelte:head>

<div class="app">
  <header class="app-header">
    <div class="brand">
      <span class="eyebrow">DBX Plan Detective</span>
      <h1>执行计划分析</h1>
    </div>
    <div class="header-right">
      <span class="badge offline">Offline / Fixture Mode</span>
      <nav class="view-switch" aria-label="视图切换">
        <button type="button" class:active={view === "analysis"} onclick={() => (view = "analysis")}>分析视图</button>
        <button type="button" class:active={view === "audit"} onclick={() => (view = "audit")}>宿主审计（开发）</button>
      </nav>
    </div>
  </header>

  {#if view === "audit"}
    <HostAudit />
  {:else}
    <p class="mode-note">
      当前为 <strong>Offline / Fixture Mode</strong>：数据来自仓库内 <code>fixtures/postgres/**</code>，
      经 <code>RawPlanInput → analyzePlan()</code> 离线分析并展示。未连接数据库，未调用 DBX Host API；
      真实 Host 接入等待上游 t8y2/dbx#9692 / #9675 合并与 release。
    </p>

    <FixtureSelector {catalog} selectedId={selectedFixtureId} onSelect={selectFixture} />

    {#if analysis?.error}
      <p class="panel error-panel">分析 fixture 失败：{analysis.error}</p>
    {:else if result}
      <FindingsList
        views={findingViews}
        counts={findingCounts}
        selectedNodeRef={selectedNodeId}
        onSelectNode={selectNode}
      />

      <div class="workspace">
        <PlanSummary {summary} selectedNodeId={selectedNodeId} onSelectNode={selectNode} />
        <PlanTree
          {rows}
          collapsed={collapsedIds}
          selectedId={selectedNodeId}
          {findingsByNodeRef}
          onSelect={selectNode}
          onToggle={toggleNode}
        />
        <NodeInspector {inspector} nodeFindings={selectedNodeFindings} />
      </div>
    {:else}
      <p class="panel empty">没有可用的 fixture（{catalogCounts.total} 个）。</p>
    {/if}
  {/if}
</div>

<style>
  .app {
    max-width: 1680px;
    margin: 0 auto;
    padding: 14px 16px 28px;
  }

  .app-header {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: flex-end;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .eyebrow {
    display: block;
    color: var(--pd-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  h1 {
    margin: 2px 0 0;
    font-size: 19px;
    font-weight: 650;
  }

  .header-right {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .view-switch {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface);
  }

  .view-switch button {
    border: 0;
    border-radius: 4px;
    padding: 4px 10px;
    background: transparent;
    color: var(--pd-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .view-switch button.active {
    background: var(--pd-accent-soft);
    color: var(--pd-accent);
    font-weight: 600;
  }

  .mode-note {
    margin: 0 0 10px;
    padding: 8px 10px;
    border: 1px solid var(--pd-border);
    border-left: 3px solid var(--pd-accent);
    border-radius: 6px;
    background: var(--pd-surface);
    color: var(--pd-muted);
  }

  .mode-note strong {
    color: var(--pd-text);
  }

  .mode-note code {
    font-size: 12px;
  }

  .error-panel {
    margin: 12px 0 0;
    padding: 10px 12px;
    color: var(--pd-high-fg);
  }

  .workspace {
    display: grid;
    grid-template-columns: 250px minmax(0, 1fr) 310px;
    gap: 10px;
    align-items: start;
    margin-top: 10px;
  }

  @media (max-width: 1180px) {
    .workspace {
      grid-template-columns: 240px minmax(0, 1fr);
    }

    .workspace :global(.inspector-panel) {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 760px) {
    .workspace {
      grid-template-columns: minmax(0, 1fr);
    }

    .workspace :global(.inspector-panel) {
      grid-column: auto;
    }
  }
</style>
