<script>
  import FindingsList from "./FindingsList.svelte";
  import HotspotsList from "./HotspotsList.svelte";
  import NodeInspector from "./NodeInspector.svelte";
  import PlanSummary from "./PlanSummary.svelte";
  import PlanTree from "./PlanTree.svelte";
  import { createTranslator } from "../lib/i18n/index.js";

  /**
   * Page-level analysis layout. The child panels render their own content, but
   * this component owns the shared Summary / Workspace / Inspector geometry.
   */
  let {
    locale = "zh-CN",
    summary = null,
    selectedNodeId = null,
    onSelectNode = () => {},
    hotspotView = { items: [], costNote: null },
    hotspotCounts = { total: 0 },
    findingViews = [],
    findingCounts = { total: 0 },
    rows = [],
    collapsed = new Set(),
    findingsByNodeRef = new Map(),
    hotspotsByNodeRef = new Map(),
    inspector = null,
    selectedNodeFindings = [],
    onToggleNode = () => {},
  } = $props();

  const t = $derived(createTranslator(locale).t);
</script>

<div class="analysis-grid">
  <aside class="summary-column" aria-label={t("layout.summary.ariaLabel")}>
    <PlanSummary {locale} {summary} {selectedNodeId} onSelectNode={onSelectNode} />
  </aside>

  <main class="workspace-column" aria-label={t("layout.workspace.ariaLabel")}>
    <FindingsList {locale} views={findingViews} counts={findingCounts} selectedNodeRef={selectedNodeId} onSelectNode={onSelectNode} />
    <HotspotsList {locale} view={hotspotView} counts={hotspotCounts} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
    <PlanTree
      {locale}
      {rows}
      {collapsed}
      selectedId={selectedNodeId}
      {findingsByNodeRef}
      {hotspotsByNodeRef}
      onSelect={onSelectNode}
      onToggle={onToggleNode}
    />
  </main>

  <aside class="inspector-column" aria-label={t("layout.inspector.ariaLabel")}>
    <NodeInspector {locale} inspector={inspector} nodeFindings={selectedNodeFindings} />
  </aside>
</div>

<style>
  .analysis-grid {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr) 340px;
    gap: var(--pd-layout-gap);
    align-items: start;
    width: 100%;
    min-width: 0;
    margin-top: var(--pd-layout-gap);
  }

  .summary-column,
  .workspace-column,
  .inspector-column {
    min-width: 0;
  }

  .workspace-column {
    display: flex;
    flex-direction: column;
    gap: var(--pd-layout-gap);
    min-width: 0;
  }

  @media (min-width: 900px) and (max-width: 1279px) {
    .analysis-grid {
      grid-template-columns: 280px minmax(0, 1fr);
    }

    .inspector-column {
      grid-column: 2;
    }
  }

  @media (max-width: 899px) {
    .analysis-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
