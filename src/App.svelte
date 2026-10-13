<script>
  import { onMount } from "svelte";
  import { FIXTURE_CATALOG } from "virtual:plan-detective-fixtures";
  import AnalysisNotice from "./components/AnalysisNotice.svelte";
  import ConnectionContext from "./components/ConnectionContext.svelte";
  import FixtureSelector from "./components/FixtureSelector.svelte";
  import HostAudit from "./components/HostAudit.svelte";
  import PlanAnalysisLayout from "./components/PlanAnalysisLayout.svelte";
  import RawPlanViewer from "./components/RawPlanViewer.svelte";
  import SqlInput from "./components/SqlInput.svelte";
  import { describePlanApi, resolvePlanBridge } from "./host/index.js";
  import { buildAiAnalysisPrompt } from "./lib/ai-analysis-prompt.js";
  import { idleAnalysis, loadPlanCapabilities, loadingAnalysis, runHostAnalysis } from "./lib/analysis-session.js";
  import { copyTextToClipboard } from "./lib/clipboard-copy.js";
  import { analyzeFixture, countByMode, findCatalogEntry, pickDefaultFixture } from "./lib/fixture-catalog.js";
  import { createTranslator, normalizeLocale } from "./lib/i18n/index.js";
  import { readLocalePreference, resolveLocalePreference, saveLocalePreference } from "./lib/i18n/locale-preference.js";
  import {
    describeAnalysisError,
    describeAnalysisNotice,
    describeCapabilities,
    describeConnectionContext,
    describeCopyPromptAction,
    describeHostGate,
    describePlanWarning,
    formatRawPlan,
  } from "./lib/host-view-model.js";
  import {
    buildFindingViews,
    buildHotspotViews,
    buildNodeInspector,
    buildPlanSummary,
    buildTreeRows,
    countFindingsBySeverity,
    countHotspotLevels,
    expandAncestors,
    groupFindingsByNodeRef,
    groupHotspotsByNodeRef,
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
  const storedLocale = readLocalePreference();
  let manualLocale = $state(null);
  const initialHostLocale = bridge?.locale ?? null;
  let hostLocale = $state(initialHostLocale);
  let locale = $state(resolveLocalePreference({ storedLocale, hostLocale: initialHostLocale }));
  const t = $derived(createTranslator(locale).t);

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
  /** `idle` | `copying` | `copied` | `failed` — see describeCopyPromptAction. */
  let copyState = $state("idle");
  let copyResetTimer = null;

  let selectedFixtureId = $state(initialEntry?.id ?? null);
  let selectedNodeId = $state("0");
  let collapsedIds = $state(new Set());

  /* ------------------------------------------------------- host lifecycle -- */

  onMount(() => {
    if (bridge === null) return undefined;

    const syncLocale = () => {
      hostLocale = bridge.locale ?? null;
      locale = resolveLocalePreference({ manualLocale, storedLocale, hostLocale });
    };

    const syncContext = () => {
      hostContext = bridge.context ?? null;
      syncLocale();
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
      if (copyResetTimer !== null) clearTimeout(copyResetTimer);
    };
  });

  const contextView = $derived(describeConnectionContext(hostContext));
  const hostGate = $derived(describeHostGate(planApi, locale));
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
    if (effectiveConnectionId === null) return t("app.disabled.noConnection");
    if (sqlText.trim().length === 0) return t("app.disabled.noSql");
    if (capabilityState === "loading") return t("app.disabled.capabilitiesLoading");
    if (capabilityState === "error") return t("app.disabled.capabilitiesError");
    if (!capabilityMatches) return t("app.disabled.refreshCapabilities");
    if (capabilities?.supports.estimatedPlan !== true) return t("app.disabled.unsupported");
    return null;
  });

  const analysisReady = $derived(analyzeDisabledReason === null);

  async function analyze() {
    if (!analysisReady || effectiveConnectionId === null) return;

    session = loadingAnalysis();
    selectedNodeId = "0";
    collapsedIds = new Set();
    copyState = "idle";

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
  const summary = $derived(activeAnalysis ? buildPlanSummary(activeAnalysis.metrics, locale) : null);
  const findingViews = $derived(activeAnalysis ? buildFindingViews(activeAnalysis.findings, rowsById, locale) : []);
  const findingCounts = $derived(countFindingsBySeverity(activeAnalysis?.findings ?? []));
  const findingsByNodeRef = $derived(groupFindingsByNodeRef(activeAnalysis?.findings ?? []));
  const hotspotViews = $derived(
    activeAnalysis ? buildHotspotViews(activeAnalysis.hotspots, rowsById, activeAnalysis.findings, locale) : { items: [], costNote: null },
  );
  const hotspotCounts = $derived(countHotspotLevels(hotspotViews.items));
  const hotspotsByNodeRef = $derived(groupHotspotsByNodeRef(hotspotViews.items));
  const inspector = $derived(activeAnalysis ? buildNodeInspector(nodesById.get(selectedNodeId), locale) : null);
  const selectedNodeFindings = $derived(findingViews.filter((finding) => finding.nodeRef === selectedNodeId));

  /* ---------------------------------------------------- host view mapping -- */

  const analysisNotice = $derived(describeAnalysisNotice(session, locale));
  const analysisError = $derived(
    session.status === "error"
      ? { ...describeAnalysisError(session.error.code, locale), code: session.error.code, message: session.error.message, hostMessage: session.error.hostMessage }
      : null,
  );
  const rawPlanPreview = $derived(session.hostResult ? formatRawPlan(session.hostResult) : null);
  const rawPlanWarnings = $derived((session.hostResult?.warnings ?? []).map((warning) => describePlanWarning(warning, locale)));
  const copyPromptAction = $derived(
    session.status === "structured" ? { ...describeCopyPromptAction(copyState, locale), onCopy: copyAiAnalysisPrompt } : null,
  );

  /* ------------------------------------------------------------ copy prompt -- */

  /**
   * Build the local AI analysis prompt and copy it. The prompt builder is a
   * pure function and the copy path is host.copy -> navigator.clipboard; this
   * handler performs no network request and sends nothing anywhere.
   */
  async function copyAiAnalysisPrompt() {
    if (session.status !== "structured" || session.analysis === null || session.rawInput === null) return;

    copyState = "copying";
    const prompt = buildAiAnalysisPrompt({
      rawInput: session.rawInput,
      analysis: session.analysis,
      databaseType: session.capabilities?.dbType ?? null,
      locale,
    });
    const result = await copyTextToClipboard({ bridge, text: prompt });
    copyState = result.ok ? "copied" : "failed";

    if (copyResetTimer !== null) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copyState = "idle";
      copyResetTimer = null;
    }, 2500);
  }

  /* --------------------------------------------------------------- events -- */

  function selectLocale(nextLocale) {
    manualLocale = normalizeLocale(nextLocale);
    locale = resolveLocalePreference({ manualLocale, storedLocale, hostLocale });
    saveLocalePreference(manualLocale);
  }

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

<div class="app" lang={locale}>
  <header class="app-header">
    <div class="brand">
      <span class="eyebrow">DBX Plan Detective</span>
      <h1>{t("app.header.title")}</h1>
    </div>
    <div class="header-right">
      {#if view === "host"}
        <span class="badge {hostGate.tone}">{hostGate.badgeLabel}</span>
      {:else if isDev}
        <span class="badge offline">{t("app.badge.offline")}</span>
      {/if}
      <nav class="view-switch" aria-label={t("app.a11y.viewSwitcher")}>
        <button type="button" class:active={view === "host"} onclick={() => (view = "host")}>{t("app.view.host")}</button>
        {#if isDev}
          <button type="button" class:active={view === "fixtures"} onclick={() => (view = "fixtures")}>{t("app.view.fixtures")}</button>
          <button type="button" class:active={view === "audit"} onclick={() => (view = "audit")}>{t("app.view.audit")}</button>
        {/if}
      </nav>
      <div class="language-switch" role="group" aria-label={t("locale.switcher.label")}>
        <button
          type="button"
          class:active={locale === "zh-CN"}
          aria-pressed={locale === "zh-CN"}
          onclick={() => selectLocale("zh-CN")}
        >{t("locale.switcher.chinese")}</button>
        <button
          type="button"
          class:active={locale === "en"}
          aria-pressed={locale === "en"}
          onclick={() => selectLocale("en")}
        >{t("locale.switcher.english")}</button>
      </div>
    </div>
  </header>

  {#if isDev && view === "audit"}
    <HostAudit {locale} />
  {:else if isDev && view === "fixtures"}
    <p class="mode-note">{t("app.mode.fixture", { mode: "Offline / Fixture Mode" })}</p>

    <FixtureSelector {locale} {catalog} selectedId={selectedFixtureId} onSelect={selectFixture} />

    {#if fixtureAnalysis?.error}
      <p class="panel error-panel">{t("app.fixture.error", { error: fixtureAnalysis.error })}</p>
    {:else if fixtureAnalysis?.result}
      <PlanAnalysisLayout
        {locale}
        {summary}
        selectedNodeId={selectedNodeId}
        onSelectNode={selectNode}
        hotspotView={hotspotViews}
        hotspotCounts={hotspotCounts}
        findingViews={findingViews}
        findingCounts={findingCounts}
        {rows}
        collapsed={collapsedIds}
        {findingsByNodeRef}
        {hotspotsByNodeRef}
        {inspector}
        selectedNodeFindings={selectedNodeFindings}
        onToggleNode={toggleNode}
      />
    {:else}
      <p class="panel empty">{t("app.fixture.empty", { count: catalogCounts.total })}</p>
    {/if}
  {:else}
    <p class="mode-note">{t("app.mode.host")}</p>

    {#if hostGate.state === "initializing"}
      <section class="panel" aria-live="polite">
        <strong>{hostGate.badgeLabel}</strong>
        <p>{hostGate.message}</p>
      </section>
    {:else if !planApi.available}
      <section class="panel error-panel" role="alert">
        <strong>{describeAnalysisError("PLAN_API_UNAVAILABLE", locale).title}</strong>
        <p>{hostGate.message ?? t("host.gate.unavailable")}</p>
        {#if isDev}
          <p class="hint">{t("app.host.offlineHint")}</p>
        {/if}
      </section>
    {:else}
      <div class="input-grid">
        <ConnectionContext
          {locale}
          {contextView}
          bind:manualConnectionId
          capabilities={capabilitiesView}
          {capabilityState}
          {capabilityError}
          onRefresh={refreshCapabilities}
        />
        <div class="sql-workspace">
          <SqlInput {locale} bind:sql={sqlText} disabled={!analysisReady} loading={session.status === "loading"} disabledReason={analyzeDisabledReason} onAnalyze={analyze} />
          <AnalysisNotice {locale} status={session.status} notice={analysisNotice} error={analysisError} onRetry={analyze} copyPrompt={copyPromptAction} />
        </div>
      </div>

      {#if session.status === "structured" && hostStructured}
        <PlanAnalysisLayout
          {locale}
          {summary}
          selectedNodeId={selectedNodeId}
          onSelectNode={selectNode}
          hotspotView={hotspotViews}
          hotspotCounts={hotspotCounts}
          findingViews={findingViews}
          findingCounts={findingCounts}
          {rows}
          collapsed={collapsedIds}
          {findingsByNodeRef}
          {hotspotsByNodeRef}
          {inspector}
          selectedNodeFindings={selectedNodeFindings}
          onToggleNode={toggleNode}
        />
      {/if}

      <div class="raw-plan-section">
        <RawPlanViewer {locale} hostResult={session.hostResult ?? null} preview={rawPlanPreview} warningLabels={rawPlanWarnings} />
      </div>
    {/if}
  {/if}
</div>

<style>
  .app {
    max-width: 1680px;
    min-width: 0;
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
    min-width: 0;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
  }

  .view-switch {
    display: inline-flex;
    flex-wrap: wrap;
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

  .language-switch {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface);
  }

  .language-switch button {
    min-height: 24px;
    padding: 3px 8px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--pd-muted);
    font: inherit;
    font-size: 11px;
    white-space: nowrap;
    cursor: pointer;
  }

  .language-switch button.active {
    background: var(--pd-accent-soft);
    color: var(--pd-accent);
    font-weight: 650;
  }

  .language-switch button:focus-visible,
  .view-switch button:focus-visible {
    outline: 2px solid var(--pd-accent);
    outline-offset: 1px;
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

  .input-grid {
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    gap: var(--pd-layout-gap);
    align-items: start;
  }

  .sql-workspace {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--pd-layout-gap);
  }

  .raw-plan-section {
    margin-top: var(--pd-layout-gap);
  }

  .error-panel {
    margin: 12px 0 0;
    padding: 10px 12px;
    color: var(--pd-high-fg);
  }

  .error-panel p {
    margin: 6px 0 0;
  }

  @media (max-width: 899px) {
    .app-header {
      align-items: flex-start;
    }

    .header-right {
      justify-content: flex-start;
    }

    .input-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
