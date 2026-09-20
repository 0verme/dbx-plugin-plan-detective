<script>
  import { onMount } from "svelte";
  import { FIXTURE_CATALOG } from "virtual:plan-detective-fixtures";
  import AnalysisNotice from "./components/AnalysisNotice.svelte";
  import ConnectionContext from "./components/ConnectionContext.svelte";
  import FixtureSelector from "./components/FixtureSelector.svelte";
  import FindingsList from "./components/FindingsList.svelte";
  import HostAudit from "./components/HostAudit.svelte";
  import NodeInspector from "./components/NodeInspector.svelte";
  import PlanSummary from "./components/PlanSummary.svelte";
  import PlanTree from "./components/PlanTree.svelte";
  import RawPlanViewer from "./components/RawPlanViewer.svelte";
  import SqlInput from "./components/SqlInput.svelte";
  import { describePlanApi, resolvePlanBridge } from "./host/index.js";
  import { idleAnalysis, loadPlanCapabilities, loadingAnalysis, runHostAnalysis } from "./lib/analysis-session.js";
  import { analyzeFixture, countByMode, findCatalogEntry, pickDefaultFixture } from "./lib/fixture-catalog.js";
  import {
    describeAnalysisError,
    describeAnalysisNotice,
    describeCapabilities,
    describeConnectionContext,
    describeHostGate,
    describePlanWarning,
    formatRawPlan,
  } from "./lib/host-view-model.js";
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
   * Two data paths, one renderer.
   *
   *   Host mode (production):    window.dbxPlugin -> Host Plan API -> adapter -> parser -> rules
   *   Fixture mode (development): fixtures/postgres/** -> analyzePlan()
   *
   * Host mode is the production path. Fixture mode stays for offline development
   * and UI review; it is not a fallback for a host failure.
   */

  const bridge = resolvePlanBridge();
  /** Fixtures / host audit are development tools and stay out of production UI. */
  const isDev = import.meta.env.DEV;

  let planApi = $state(describePlanApi(bridge));

  /* ------------------------------------------------------------- fixtures -- */

  const catalog = FIXTURE_CATALOG;
  const catalogCounts = countByMode(catalog);
  const initialEntry = pickDefaultFixture(catalog);

  /* ---------------------------------------------------------------- state -- */

  let view = $state("host");
  let hostContext = $state(null);
  let manualConnectionId = $state("");
  let sqlText = $state("");
  let capabilities = $state(null);
  let capabilitiesConnectionId = $state(null);
  let capabilityState = $state("idle");
  let capabilityError = $state(null);
  let session = $state(idleAnalysis());

  let selectedFixtureId = $state(initialEntry?.id ?? null);
  let selectedNodeId = $state("0");
  let collapsedIds = $state(new Set());

  /* ------------------------------------------------------- host lifecycle -- */

  onMount(() => {
    if (bridge === null) return undefined;

    const syncContext = () => {
      hostContext = bridge.context ?? null;
      const contextSql = hostContext?.sql;
      if (sqlText.length === 0 && typeof contextSql === "string" && contextSql.trim().length > 0) {
        sqlText = contextSql;
      }
    };

    // `window.dbxPlugin` exists before the host init message fills
    // `capabilities`. Re-evaluate the capability gate whenever init arrives; a
    // pre-init bridge stays "initializing" and is never probed.
    const syncPlanApi = () => {
      planApi = describePlanApi(bridge, { initialized: true });
    };

    const handleInit = () => {
      syncPlanApi();
      syncContext();
    };

    const offContext = typeof bridge.onContext === "function" ? bridge.onContext(syncContext) : null;
    const offInit = typeof bridge.onInit === "function" ? bridge.onInit(handleInit) : null;
    Promise.resolve(bridge.ready).then(handleInit, handleInit);

    return () => {
      offContext?.();
      offInit?.();
    };
  });

  const contextView = $derived(describeConnectionContext(hostContext));
  const hostGate = $derived(describeHostGate(planApi));
  const effectiveConnectionId = $derived(contextView.connectionId ?? (manualConnectionId.trim().length > 0 ? manualConnectionId.trim() : null));
  const capabilitiesView = $derived(describeCapabilities(capabilities));
  const capabilityMatches = $derived(capabilitiesConnectionId !== null && capabilitiesConnectionId === effectiveConnectionId);

  let capabilityToken = 0;

  async function refreshCapabilities() {
    const connectionId = effectiveConnectionId;
    if (!planApi.available || connectionId === null) {
      capabilityToken += 1;
      capabilityState = "idle";
      capabilities = null;
      capabilitiesConnectionId = null;
      capabilityError = null;
      return;
    }

    const token = ++capabilityToken;
    capabilityState = "loading";
    capabilityError = null;
    const result = await loadPlanCapabilities({ bridge, connectionId });
    if (token !== capabilityToken) return;

    if (result.status === "ready") {
      capabilities = result.capabilities;
      capabilitiesConnectionId = connectionId;
      capabilityState = "ready";
      capabilityError = null;
    } else {
      capabilities = null;
      capabilitiesConnectionId = null;
      capabilityState = "error";
      capabilityError = result.error;
    }
  }

  // A result-view open carries its connectionId; load its capabilities once.
  $effect(() => {
    if (contextView.connectionId !== null) refreshCapabilities();
  });

  const analyzeDisabledReason = $derived.by(() => {
    if (!planApi.available) return planApi.reason ?? "DBX Plan API is unavailable.";
    if (effectiveConnectionId === null) return "缺少 connectionId";
    if (sqlText.trim().length === 0) return "请输入 SQL";
    if (capabilityState === "loading") return "正在读取宿主能力…";
    if (capabilityState === "error") return "连接能力读取失败";
    if (!capabilityMatches) return "请先刷新 Plan Capabilities";
    if (capabilities?.supports.estimatedPlan !== true) return "该方言不支持 Estimated Plan";
    return null;
  });

  const analysisReady = $derived(analyzeDisabledReason === null);

  async function analyze() {
    if (!analysisReady || effectiveConnectionId === null) return;

    session = loadingAnalysis();
    selectedNodeId = "0";
    collapsedIds = new Set();

    const maxTimeoutMs = capabilities?.limits.maxTimeoutMs;
    const timeoutMs = typeof maxTimeoutMs === "number" ? Math.min(15_000, maxTimeoutMs) : null;

    session = await runHostAnalysis({
      bridge,
      connectionId: effectiveConnectionId,
      sql: sqlText,
      database: contextView.database,
      schema: contextView.schema,
      timeoutMs,
    });
  }

  /* ------------------------------------------------------ active analysis -- */

  const fixtureAnalysis = $derived.by(() => {
    const entry = findCatalogEntry(catalog, selectedFixtureId);
    if (entry === null) return null;
    try {
      return { result: analyzeFixture(entry), error: null };
    } catch (cause) {
      return { result: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  const hostStructured = $derived(session.status === "structured" ? session.analysis : null);
  const activeAnalysis = $derived(view === "host" ? hostStructured : (fixtureAnalysis?.result ?? null));

  const rows = $derived(activeAnalysis ? buildTreeRows(activeAnalysis.normalized.root) : []);
  const rowsById = $derived(indexRowsById(rows));
  const nodesById = $derived(activeAnalysis ? indexNodesById(activeAnalysis.normalized.root) : new Map());
  const summary = $derived(activeAnalysis ? buildPlanSummary(activeAnalysis.metrics) : null);
  const findingViews = $derived(activeAnalysis ? buildFindingViews(activeAnalysis.findings, rowsById) : []);
  const findingCounts = $derived(countFindingsBySeverity(activeAnalysis?.findings ?? []));
  const findingsByNodeRef = $derived(groupFindingsByNodeRef(activeAnalysis?.findings ?? []));
  const inspector = $derived(activeAnalysis ? buildNodeInspector(nodesById.get(selectedNodeId)) : null);
  const selectedNodeFindings = $derived(findingViews.filter((finding) => finding.nodeRef === selectedNodeId));

  /* ---------------------------------------------------- host view mapping -- */

  const analysisNotice = $derived(describeAnalysisNotice(session));
  const analysisError = $derived(
    session.status === "error"
      ? { ...describeAnalysisError(session.error.code), code: session.error.code, message: session.error.message, hostMessage: session.error.hostMessage }
      : null,
  );
  const rawPlanPreview = $derived(session.hostResult ? formatRawPlan(session.hostResult) : null);
  const rawPlanWarnings = $derived((session.hostResult?.warnings ?? []).map(describePlanWarning));

  /* --------------------------------------------------------------- events -- */

  function selectFixture(id) {
    if (id === selectedFixtureId) return;
    selectedFixtureId = id;
    selectedNodeId = "0";
    collapsedIds = new Set();
  }

  function selectNode(nodeId) {
    if (activeAnalysis === null || nodeId === selectedNodeId) return;
    collapsedIds = expandAncestors(collapsedIds, rowsById.get(nodeId));
    selectedNodeId = nodeId;
  }

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
      {#if view === "host"}
        <span class="badge {hostGate.tone}">{hostGate.badgeLabel}</span>
      {:else if isDev}
        <span class="badge offline">Offline / Fixture Mode</span>
      {/if}
      <nav class="view-switch" aria-label="视图切换">
        <button type="button" class:active={view === "host"} onclick={() => (view = "host")}>Host 分析</button>
        {#if isDev}
          <button type="button" class:active={view === "fixtures"} onclick={() => (view = "fixtures")}>Fixtures（开发）</button>
          <button type="button" class:active={view === "audit"} onclick={() => (view = "audit")}>宿主审计（开发）</button>
        {/if}
      </nav>
    </div>
  </header>

  {#if isDev && view === "audit"}
    <HostAudit />
  {:else if isDev && view === "fixtures"}
    <p class="mode-note">
      当前为 <strong>Offline / Fixture Mode</strong>（开发用）：数据来自仓库内 <code>fixtures/postgres/**</code>，
      经 <code>RawPlanInput → analyzePlan()</code> 离线分析。它不访问 DBX、数据库或网络。
    </p>

    <FixtureSelector {catalog} selectedId={selectedFixtureId} onSelect={selectFixture} />

    {#if fixtureAnalysis?.error}
      <p class="panel error-panel">分析 fixture 失败：{fixtureAnalysis.error}</p>
    {:else if fixtureAnalysis?.result}
      <FindingsList views={findingViews} counts={findingCounts} selectedNodeRef={selectedNodeId} onSelectNode={selectNode} />
      <div class="workspace">
        <PlanSummary {summary} selectedNodeId={selectedNodeId} onSelectNode={selectNode} />
        <PlanTree {rows} collapsed={collapsedIds} selectedId={selectedNodeId} {findingsByNodeRef} onSelect={selectNode} onToggle={toggleNode} />
        <NodeInspector {inspector} nodeFindings={selectedNodeFindings} />
      </div>
    {:else}
      <p class="panel empty">没有可用的 fixture（{catalogCounts.total} 个）。</p>
    {/if}
  {:else}
    <p class="mode-note">
      当前为 <strong>DBX Host Mode</strong>：计划来自 <code>window.dbxPlugin.explainPlan</code>（仅
      <code>mode: "estimated"</code>）。插件不建立数据库连接、不读取凭据、不执行 SQL；<code>EXPLAIN</code> 由 DBX 宿主生成。
    </p>

    {#if hostGate.state === "initializing"}
      <section class="panel" aria-live="polite">
        <strong>{hostGate.badgeLabel}</strong>
        <p>{hostGate.message}</p>
      </section>
    {:else if !planApi.available}
      <section class="panel error-panel" role="alert">
        <strong>{describeAnalysisError("PLAN_API_UNAVAILABLE").title}</strong>
        <p>{hostGate.message ?? "DBX Plan API is unavailable."}</p>
        {#if isDev}
          <p class="hint">离线开发可切换到 Fixtures（开发）视图；该视图不访问宿主。</p>
        {/if}
      </section>
    {:else}
      <div class="host-input">
        <ConnectionContext
          {contextView}
          bind:manualConnectionId
          capabilities={capabilitiesView}
          {capabilityState}
          {capabilityError}
          onRefresh={refreshCapabilities}
        />
        <SqlInput bind:sql={sqlText} disabled={!analysisReady} loading={session.status === "loading"} disabledReason={analyzeDisabledReason} onAnalyze={analyze} />
      </div>

      <AnalysisNotice status={session.status} notice={analysisNotice} error={analysisError} onRetry={analyze} />

      {#if session.status === "structured" && hostStructured}
        <FindingsList views={findingViews} counts={findingCounts} selectedNodeRef={selectedNodeId} onSelectNode={selectNode} />
        <div class="workspace">
          <PlanSummary {summary} selectedNodeId={selectedNodeId} onSelectNode={selectNode} />
          <PlanTree {rows} collapsed={collapsedIds} selectedId={selectedNodeId} {findingsByNodeRef} onSelect={selectNode} onToggle={toggleNode} />
          <NodeInspector {inspector} nodeFindings={selectedNodeFindings} />
        </div>
      {/if}

      <RawPlanViewer hostResult={session.hostResult ?? null} preview={rawPlanPreview} warningLabels={rawPlanWarnings} />
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

  .host-input {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
    margin-bottom: 10px;
  }

  .error-panel {
    margin: 12px 0 0;
    padding: 10px 12px;
    color: var(--pd-high-fg);
  }

  .error-panel p {
    margin: 6px 0 0;
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
    .host-input {
      grid-template-columns: minmax(0, 1fr);
    }

    .workspace {
      grid-template-columns: minmax(0, 1fr);
    }

    .workspace :global(.inspector-panel) {
      grid-column: auto;
    }
  }
</style>
