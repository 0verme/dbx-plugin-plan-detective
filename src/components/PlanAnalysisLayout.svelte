<script>
  import FindingsList from "./FindingsList.svelte";
  import HotspotsList from "./HotspotsList.svelte";
  import NodeInspector from "./NodeInspector.svelte";
  import PlanSummary from "./PlanSummary.svelte";
  import PlanTree from "./PlanTree.svelte";
  import { createTranslator } from "../lib/i18n/index.js";

  /**
   * Page-level analysis layout. The child panels render their own content, but
   * this component owns the shared Summary, adjacent plan / Inspector and
   * diagnostics geometry.
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
    <PlanSummary {locale} {summary} findingCount={findingCounts.total} {selectedNodeId} onSelectNode={onSelectNode} />
  </aside>

  <main class="analysis-column" aria-label={t("layout.workspace.ariaLabel")}>
    <div class="plan-workspace">
      <div class="tree-column">
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
      </div>
      <aside class="inspector-column" aria-label={t("layout.inspector.ariaLabel")}>
        <NodeInspector {locale} inspector={inspector} nodeFindings={selectedNodeFindings} />
      </aside>
    </div>

    <div class="diagnostics-grid">
      <div class="diagnostics-column">
        <FindingsList {locale} views={findingViews} counts={findingCounts} selectedNodeRef={selectedNodeId} onSelectNode={onSelectNode} />
      </div>
      <div class="diagnostics-column">
        <HotspotsList {locale} view={hotspotView} counts={hotspotCounts} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
      </div>
    </div>
  </main>
</div>

<style>
  .analysis-grid {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--pd-layout-gap);
    width: 100%;
    min-width: 0;
    margin-top: var(--pd-layout-gap);
  }

  .summary-column {
    flex: 1 1 280px;
    min-width: 0;
  }

  .analysis-column {
    display: flex;
    min-width: 0;
    flex: 3 1 620px;
    flex-direction: column;
    gap: var(--pd-layout-gap);
  }

  .plan-workspace,
  .diagnostics-grid {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--pd-layout-gap);
    min-width: 0;
  }

  .tree-column,
  .inspector-column {
    flex: 1 1 320px;
    min-width: 0;
  }

  .diagnostics-column {
    flex: 1 1 420px;
    min-width: 0;
  }
</style>
