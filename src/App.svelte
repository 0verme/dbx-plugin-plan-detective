<script>
  import { onMount } from "svelte";
  import { FIXTURE_CATALOG } from "virtual:plan-detective-fixtures";
  import AnalysisNotice from "./components/AnalysisNotice.svelte";
  import ConnectionContext from "./components/ConnectionContext.svelte";
  import FixtureSelector from "./components/FixtureSelector.svelte";
  import HostAudit from "./components/HostAudit.svelte";
  import PlanAnalysisLayout from "./components/PlanAnalysisLayout.svelte";
  import PlanDiffView from "./components/PlanDiffView.svelte";
  import RawPlanViewer from "./components/RawPlanViewer.svelte";
  import SnapshotManager from "./components/SnapshotManager.svelte";
  import SqlInput from "./components/SqlInput.svelte";
  import { describePlanApi, describePluginStorage, resolvePlanBridge } from "./host/index.js";
  import pluginPackage from "../package.json";
  import pluginManifest from "../manifest.json";
  import {
    detectDbxVersion,
    finishSnapshotDiagnosticStage,
    getSnapshotDiagnosticSessionTrace,
    recordSnapshotDiagnosticEvent,
    setSnapshotDiagnosticEnvironment,
    startSnapshotDiagnosticStage,
  } from "./lib/snapshot-diagnostic-trace.js";
  import { buildAiAnalysisPrompt } from "./lib/ai-analysis-prompt.js";
  import { idleAnalysis, loadPlanCapabilities, loadingAnalysis, runHostAnalysis } from "./lib/analysis-session.js";
  import { describeHostEntryState } from "./lib/host-entry-state.js";
  import { copyTextToClipboard } from "./lib/clipboard-copy.js";
  import { analyzeFixture, countByMode, findCatalogEntry, pickDefaultFixture } from "./lib/fixture-catalog.js";
  import { createTranslator, normalizeLocale } from "./lib/i18n/index.js";
  import { readLocalePreference, resolveLocalePreference, saveLocalePreference } from "./lib/i18n/locale-preference.js";
  import { createPlanSnapshotRepository } from "./lib/plan-snapshot-store.js";
  import { createPlanSnapshotView, formatPlanSnapshotTime } from "./lib/plan-snapshot-view.js";
  import { buildEstimatedPlanDiff } from "./core/diff/plan-diff-report.js";
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
  const diagnosticSessionTrace = getSnapshotDiagnosticSessionTrace();
  const buildFingerprint = typeof __PD_BUILD_FINGERPRINT__ === "string" ? __PD_BUILD_FINGERPRINT__ : "unknown";
  const initialPlanApi = describePlanApi(bridge);
  const initialStorageApi = describePluginStorage(bridge);
  setSnapshotDiagnosticEnvironment({
    pluginVersion: pluginPackage.version,
    buildFingerprint,
    dbxVersion: detectDbxVersion(bridge),
    manifestPermissions: pluginManifest.permissions,
    storage: initialStorageApi,
  });
  recordSnapshotDiagnosticEvent(diagnosticSessionTrace, "SNAPSHOT_HOST_BRIDGE_RESOLVE", "success", { bridgeAvailable: bridge !== null });
  const initialStorageCheck = startSnapshotDiagnosticStage(diagnosticSessionTrace, "SNAPSHOT_STORAGE_CAPABILITY_CHECK", {
    bridgeAvailable: bridge !== null,
    initialized: initialStorageApi.state !== "initializing",
  });
  finishSnapshotDiagnosticStage(initialStorageCheck, "success", {
    capabilityAdvertised: initialStorageApi.advertised === true,
    capabilityAvailable: initialStorageApi.available === true,
    permissionDeclared: pluginManifest.permissions.includes("host.storage"),
    reasonCode: initialStorageApi.reasonCode,
  });
  recordSnapshotDiagnosticEvent(diagnosticSessionTrace, "SNAPSHOT_HOST_PERMISSION_STATUS", "info", {
    permissionDeclared: pluginManifest.permissions.includes("host.storage"),
    permissionStatus: "not-verified",
  });
  /** Fixtures / host audit are development tools and stay out of production UI. */
  const isDev = import.meta.env.DEV;

  let planApi = $state(initialPlanApi);
  let storageApi = $state(initialStorageApi);
  let snapshotRepository = $state(initialStorageApi.available ? createPlanSnapshotRepository(bridge) : null);
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
  let hostContext = $state(bridge?.context ?? null);
  let hostContextReady = $state(bridge === null || initialPlanApi.state === "unavailable");
  let manualMode = $state(false);
  let manualConnectionId = $state("");
  let sqlText = $state(typeof bridge?.context?.sql === "string" ? bridge.context.sql : "");
  let capabilities = $state(null);
  let capabilitiesConnectionId = $state(null);
  let capabilityState = $state("idle");
  let capabilityError = $state(null);
  let session = $state(idleAnalysis());
  let activeSnapshot = $state(null);
  let baselineSnapshot = $state(null);
  let diffState = $state(null);
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
      hostContextReady = true;
    };

    // `window.dbxPlugin` exists before the host init message fills
    // `capabilities`. Re-evaluate the capability gate whenever init arrives; a
    // pre-init bridge stays "initializing" and is never probed.
    const syncPlanApi = () => {
      planApi = describePlanApi(bridge, { initialized: true });
    };

    const syncStorageApi = () => {
      const capabilityCheck = startSnapshotDiagnosticStage(diagnosticSessionTrace, "SNAPSHOT_STORAGE_CAPABILITY_CHECK", {
        bridgeAvailable: true,
        initialized: true,
      });
      storageApi = describePluginStorage(bridge, { initialized: true });
      snapshotRepository = storageApi.available ? createPlanSnapshotRepository(bridge) : null;
      setSnapshotDiagnosticEnvironment({
        pluginVersion: pluginPackage.version,
        buildFingerprint,
        dbxVersion: detectDbxVersion(bridge),
        manifestPermissions: pluginManifest.permissions,
        storage: storageApi,
      });
      finishSnapshotDiagnosticStage(capabilityCheck, "success", {
        capabilityAdvertised: storageApi.advertised === true,
        capabilityAvailable: storageApi.available === true,
        permissionDeclared: pluginManifest.permissions.includes("host.storage"),
        reasonCode: storageApi.reasonCode,
      });
      recordSnapshotDiagnosticEvent(diagnosticSessionTrace, "SNAPSHOT_HOST_PERMISSION_STATUS", "info", {
        permissionDeclared: pluginManifest.permissions.includes("host.storage"),
        permissionStatus: "not-verified",
      });
    };

    let hostInitHandled = false;
    let hostInitSettled = false;
    const hostInitStage = startSnapshotDiagnosticStage(diagnosticSessionTrace, "SNAPSHOT_HOST_BRIDGE_INIT", {
      bridgeAvailable: true,
      initialized: false,
    });
    const settleHostInit = (status, fields = {}) => {
      if (hostInitSettled) return;
      hostInitSettled = true;
      finishSnapshotDiagnosticStage(hostInitStage, status, fields);
    };
    const handleInit = () => {
      if (!hostInitHandled) {
        hostInitHandled = true;
        syncPlanApi();
        syncStorageApi();
      }
      settleHostInit("success", { bridgeAvailable: true, initialized: true });
      syncContext();
    };

    const offContext = typeof bridge.onContext === "function" ? bridge.onContext(syncContext) : null;
    const offInit = typeof bridge.onInit === "function" ? bridge.onInit(handleInit) : null;
    Promise.resolve(bridge.ready).then(
      handleInit,
      () => {
        settleHostInit("failed", { errorCode: "UNKNOWN_ERROR", failedStage: "host.initialize" });
        handleInit();
      },
    );

    return () => {
      offContext?.();
      offInit?.();
      if (copyResetTimer !== null) clearTimeout(copyResetTimer);
    };
  });

  const contextView = $derived(describeConnectionContext(hostContext));
  const hostGate = $derived(describeHostGate(planApi, locale));
  const effectiveConnectionId = $derived(contextView.connectionId ?? (manualConnectionId.trim().length > 0 ? manualConnectionId.trim() : null));
  const hostEntryState = $derived(describeHostEntryState({
    contextReady: hostContextReady,
    planApiState: planApi.state,
    planApiAvailable: planApi.available,
    hasContext: contextView.hasConnection || contextView.contextSql !== null,
    manualMode,
    connectionId: effectiveConnectionId,
    sql: sqlText,
  }));
  const capabilitiesView = $derived(describeCapabilities(capabilities));
  const capabilityMatches = $derived(capabilitiesConnectionId !== null && capabilitiesConnectionId === effectiveConnectionId);

  let capabilityToken = 0;
  let analysisRequestToken = 0;
  let lastAnalyzedInputKey = null;

  function currentAnalysisInputKey() {
    return JSON.stringify([effectiveConnectionId, sqlText, contextView.database, contextView.schema]);
  }

  $effect(() => {
    const currentKey = currentAnalysisInputKey();
    if (lastAnalyzedInputKey === null || lastAnalyzedInputKey === currentKey) return;

    // Editing SQL or changing the target invalidates the displayed plan and any
    // still-pending response, so results cannot drift to a different request.
    lastAnalyzedInputKey = null;
    analysisRequestToken += 1;
    session = idleAnalysis();
    activeSnapshot = null;
    diffState = null;
    selectedNodeId = "0";
    collapsedIds = new Set();
    copyState = "idle";
  });

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

    const requestToken = ++analysisRequestToken;
    lastAnalyzedInputKey = currentAnalysisInputKey();
    activeSnapshot = null;
    diffState = null;
    session = loadingAnalysis();
    selectedNodeId = "0";
    collapsedIds = new Set();
    copyState = "idle";

    const maxTimeoutMs = capabilities?.limits.maxTimeoutMs;
    const timeoutMs = typeof maxTimeoutMs === "number" ? Math.min(15_000, maxTimeoutMs) : null;

    const result = await runHostAnalysis({
      bridge,
      connectionId: effectiveConnectionId,
      sql: sqlText,
      database: contextView.database,
      schema: contextView.schema,
      timeoutMs,
    });
    if (requestToken !== analysisRequestToken || lastAnalyzedInputKey !== currentAnalysisInputKey()) return;
    session = result;
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

  const displaySession = $derived(activeSnapshot?.session ?? session);
  const hostStructured = $derived(displaySession.status === "structured" ? displaySession.analysis : null);
  const activeAnalysis = $derived(view === "host" ? hostStructured : (fixtureAnalysis?.result ?? null));

  const diffReport = $derived.by(() => {
    if (diffState === null || diffState.error || !diffState.baseline || !diffState.current) return null;
    try {
      return buildEstimatedPlanDiff({
        baseline: diffState.baseline,
        current: diffState.current,
        baselineMeta: diffState.baselineMeta,
        currentMeta: diffState.currentMeta,
      });
    } catch {
      return null;
    }
  });
  const diffBaselineSession = $derived.by(() => {
    if (diffState === null || diffState.error || !diffState.baseline) return null;
    const view = diffState.baseline;
    return view.session?.analysis ?? view.analysis ?? null;
  });
  const diffCurrentSession = $derived.by(() => {
    if (diffState === null || diffState.error || !diffState.current) return null;
    const view = diffState.current;
    return view.session?.analysis ?? view.analysis ?? null;
  });

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

  const analysisNotice = $derived.by(() => {
    const notice = describeAnalysisNotice(displaySession, locale);
    if (activeSnapshot === null || notice === null) return notice;
    if (displaySession.status === "structured") return { ...notice, title: t("snapshot.history.analysis.structured") };
    if (displaySession.status === "raw-only") return { ...notice, title: t("snapshot.history.analysis.rawOnly") };
    return notice;
  });
  const analysisError = $derived(
    displaySession.status === "error"
      ? { ...describeAnalysisError(displaySession.error.code, locale), code: displaySession.error.code, message: displaySession.error.message, hostMessage: displaySession.error.hostMessage }
      : null,
  );
  const rawPlanPreview = $derived(displaySession.hostResult ? formatRawPlan(displaySession.hostResult) : null);
  const rawPlanWarnings = $derived((displaySession.hostResult?.warnings ?? []).map((warning) => describePlanWarning(warning, locale)));
  const copyPromptAction = $derived(
    displaySession.status === "structured" ? { ...describeCopyPromptAction(copyState, locale), onCopy: copyAiAnalysisPrompt } : null,
  );

  /* ------------------------------------------------------------ copy prompt -- */

  /**
   * Build the local AI analysis prompt and copy it. The prompt builder is a
   * pure function and the copy path is host.copy -> navigator.clipboard; this
   * handler performs no network request and sends nothing anywhere.
   */
  async function copyAiAnalysisPrompt() {
    const currentSession = displaySession;
    if (currentSession.status !== "structured" || currentSession.analysis === null || currentSession.rawInput === null) return;

    copyState = "copying";
    const prompt = buildAiAnalysisPrompt({
      rawInput: currentSession.rawInput,
      analysis: currentSession.analysis,
      databaseType: currentSession.capabilities?.dbType ?? currentSession.rawInput.database ?? null,
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

  function openSnapshot(snapshot) {
    activeSnapshot = createPlanSnapshotView(snapshot);
    diffState = null;
    selectedNodeId = "0";
    collapsedIds = new Set();
    copyState = "idle";
  }

  function returnToCurrentAnalysis() {
    activeSnapshot = null;
    diffState = null;
    selectedNodeId = "0";
    collapsedIds = new Set();
    copyState = "idle";
  }

  function selectBaseline(snapshot) {
    baselineSnapshot = snapshot ?? null;
    diffState = null;
  }

  function snapshotMeta(snapshot) {
    return {
      kind: "snapshot",
      id: snapshot.snapshotId,
      title: snapshot.title,
      savedAt: snapshot.savedAt,
      capturedAt: snapshot.capturedAt,
      producerVersion: snapshot.producerVersion,
    };
  }

  /** Open a comparison without replacing the current analysis or active snapshot. */
  function startDiff({ baseline = null, current = null } = {}) {
    if (baseline === null || current === null) return;
    try {
      const baselineView = createPlanSnapshotView(baseline);
      const currentIsSnapshot = typeof current.snapshotId === "string";
      diffState = {
        baseline: baselineView,
        current: currentIsSnapshot ? createPlanSnapshotView(current) : current,
        baselineMeta: snapshotMeta(baseline),
        currentMeta: currentIsSnapshot ? snapshotMeta(current) : { kind: "current" },
      };
    } catch (error) {
      diffState = {
        error: { code: error?.code ?? "GENERIC", message: error instanceof Error ? error.message : String(error) },
        baseline: null,
        current: null,
        baselineMeta: null,
        currentMeta: null,
      };
    }
  }

  function swapDiff() {
    if (diffState === null || diffState.error || !diffState.baseline || !diffState.current) return;
    diffState = {
      baseline: diffState.current,
      current: diffState.baseline,
      baselineMeta: diffState.currentMeta,
      currentMeta: diffState.baselineMeta,
    };
  }

  function exitDiff() {
    diffState = null;
  }

  function updateActiveSnapshot(snapshot) {
    if (activeSnapshot?.snapshot.snapshotId === snapshot.snapshotId) {
      activeSnapshot = { ...activeSnapshot, snapshot };
    }
    if (baselineSnapshot?.snapshotId === snapshot.snapshotId) {
      baselineSnapshot = { ...baselineSnapshot, ...snapshot };
    }
  }

  function handleSnapshotDeleted(snapshotId) {
    if (activeSnapshot?.snapshot.snapshotId === snapshotId) returnToCurrentAnalysis();
    if (baselineSnapshot?.snapshotId === snapshotId) baselineSnapshot = null;
    if (diffState?.baselineMeta?.id === snapshotId || diffState?.currentMeta?.id === snapshotId) diffState = null;
  }

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
      {#if view === "host" && hostEntryState !== "empty" && hostEntryState !== "loading"}
        <span class="badge {hostGate.tone}">{hostGate.badgeLabel}</span>
      {:else if isDev && view !== "host"}
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

  {#if view === "host"}
    <SnapshotManager
      {locale}
      storageState={storageApi}
      repository={snapshotRepository}
      currentSession={activeSnapshot === null ? session : null}
      activeSnapshotId={activeSnapshot?.snapshot.snapshotId ?? null}
      baselineSnapshotId={baselineSnapshot?.snapshotId ?? null}
      producerVersion={pluginPackage.version}
      diagnosticBridge={bridge}
      onOpenSnapshot={openSnapshot}
      onSelectBaseline={selectBaseline}
      onCompareSnapshots={startDiff}
      onCompareCurrent={startDiff}
      onDeleteSnapshot={handleSnapshotDeleted}
      onUpdateSnapshot={updateActiveSnapshot}
    />
  {/if}

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
    {#if diffState !== null}
      <PlanDiffView
        {locale}
        report={diffReport}
        baselineAnalysis={diffBaselineSession}
        currentAnalysis={diffCurrentSession}
        error={diffState.error ?? null}
        onSwap={swapDiff}
        onExit={exitDiff}
      />
    {:else if activeSnapshot !== null}
      <section class="snapshot-history" aria-labelledby="snapshot-history-title">
        <div class="snapshot-history-head">
          <span class="badge info">{t("snapshot.history.label")}</span>
          <button type="button" class="secondary-link" onclick={returnToCurrentAnalysis}>{t("snapshot.history.return")}</button>
        </div>
        <h2 id="snapshot-history-title">{activeSnapshot.snapshot.title}</h2>
        <p class="snapshot-history-reanalysis">
          {t("snapshot.history.reanalysis", {
            savedVersion: activeSnapshot.snapshot.producerVersion ?? t("snapshot.unknownVersion"),
            currentVersion: pluginPackage.version,
          })}
        </p>
        <div class="snapshot-history-metadata">
          <span>{t("snapshot.meta.database", {
            database: activeSnapshot.snapshot.rawInput.database,
            version: activeSnapshot.snapshot.rawInput.databaseVersion ?? t("snapshot.unknown"),
          })}</span>
          <span>{t("snapshot.meta.savedAt", { time: formatPlanSnapshotTime(activeSnapshot.snapshot.savedAt, locale) ?? t("snapshot.unknown") })}</span>
          <span>{t("snapshot.meta.capturedAt", { time: formatPlanSnapshotTime(activeSnapshot.snapshot.capturedAt, locale) ?? t("snapshot.unknown") })}</span>
          <span>{t("snapshot.meta.producer", { version: activeSnapshot.snapshot.producerVersion ?? t("snapshot.unknownVersion") })}</span>
          {#if activeSnapshot.snapshot.source.databaseName || activeSnapshot.snapshot.source.schema}
            <span>{t("snapshot.meta.source", {
              source: [activeSnapshot.snapshot.source.databaseName, activeSnapshot.snapshot.source.schema].filter(Boolean).join(" / "),
            })}</span>
          {/if}
        </div>
        {#if activeSnapshot.snapshot.note}
          <p class="snapshot-history-note">{activeSnapshot.snapshot.note}</p>
        {/if}
        {#if activeSnapshot.snapshot.rawInput.sql}
          <details class="snapshot-history-sql">
            <summary>{t("snapshot.history.sql")}</summary>
            <pre>{activeSnapshot.snapshot.rawInput.sql}</pre>
          </details>
        {/if}
      </section>

      <AnalysisNotice {locale} status={displaySession.status} notice={analysisNotice} error={analysisError} copyPrompt={copyPromptAction} />
      {#if displaySession.status === "structured" && hostStructured}
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
        <RawPlanViewer {locale} hostResult={displaySession.hostResult ?? null} preview={rawPlanPreview} warningLabels={rawPlanWarnings} />
      </div>
    {:else}
    {#if hostEntryState === "loading"}
      <section class="panel context-loading" role="status" aria-live="polite">
        <p>{t("app.context.loading")}</p>
      </section>
    {:else if hostEntryState === "unavailable"}
      <section class="panel error-panel" role="alert">
        <strong>{describeAnalysisError("PLAN_API_UNAVAILABLE", locale).title}</strong>
        <p>{hostGate.message ?? t("host.gate.unavailable")}</p>
        {#if bridge !== null}
          <p class="hint">{describeAnalysisError("PLAN_API_UNAVAILABLE", locale).hint}</p>
        {/if}
        {#if isDev}
          <p class="hint">{t("app.host.offlineHint")}</p>
        {/if}
      </section>
    {:else if hostEntryState === "empty"}
      <section class="empty-state" aria-labelledby="empty-state-title">
        <div class="empty-state-card">
          <svg class="empty-state-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
            <ellipse cx="24" cy="10" rx="15" ry="6"></ellipse>
            <path d="M9 10v28c0 3.3 6.7 6 15 6s15-2.7 15-6V10"></path>
            <path d="M9 19c0 3.3 6.7 6 15 6s15-2.7 15-6M9 28c0 3.3 6.7 6 15 6s15-2.7 15-6"></path>
          </svg>
          <h2 id="empty-state-title">{t("app.empty.title")}</h2>
          <p class="empty-state-description">{t("app.empty.description")}</p>
          <ol class="empty-state-path" aria-label={t("app.empty.path.ariaLabel")}>
            <li>{t("app.empty.path.connection")}<span aria-hidden="true">→</span></li>
            <li>{t("app.empty.path.execute")}<span aria-hidden="true">→</span></li>
            <li>{t("app.empty.path.results")}<span aria-hidden="true">→</span></li>
            <li>{t("app.empty.path.plugin")}</li>
          </ol>
          <p class="empty-state-helper">{t("app.empty.helper")}</p>
          <button type="button" class="secondary-link" onclick={() => (manualMode = true)}>
            {t("app.empty.manual")}
          </button>
        </div>
      </section>
    {:else}
      {#if hostEntryState === "needs-sql"}
        <p class="entry-guidance" role="status" aria-live="polite">{t("app.context.needsSql")}</p>
      {:else if hostEntryState === "needs-connection"}
        <p class="entry-guidance" role="status" aria-live="polite">{t("app.context.needsConnection")}</p>
      {/if}

      {#if manualMode && !contextView.hasConnection && contextView.contextSql === null}
        <div class="manual-mode-actions">
          <button type="button" class="secondary-link" onclick={() => (manualMode = false)}>
            {t("app.entry.returnToGuide")}
          </button>
        </div>
      {/if}

      <div class="input-grid">
        <div class="connection-workspace">
          <ConnectionContext
            {locale}
            {contextView}
            bind:manualConnectionId
            capabilities={capabilitiesView}
            {capabilityState}
            {capabilityError}
            onRefresh={refreshCapabilities}
          />
        </div>
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
        <RawPlanViewer {locale} hostResult={displaySession.hostResult ?? null} preview={rawPlanPreview} warningLabels={rawPlanWarnings} />
      </div>
    {/if}
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

  .empty-state {
    display: grid;
    min-height: min(62vh, 520px);
    place-items: center;
    padding: 16px 0;
  }

  .empty-state-card {
    width: min(100%, 720px);
    padding: clamp(16px, 4vw, 32px);
    border: 1px solid var(--pd-border);
    border-radius: var(--pd-radius);
    background: var(--pd-surface);
    text-align: center;
  }

  .empty-state-icon {
    width: 40px;
    height: 40px;
    margin-bottom: 9px;
    fill: none;
    stroke: var(--pd-accent);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2.1;
  }

  .empty-state-card h2 {
    margin: 0;
    font-size: clamp(18px, 2.4vw, 21px);
    font-weight: 650;
  }

  .empty-state-description {
    max-width: 580px;
    margin: 10px auto 0;
    color: var(--pd-muted);
  }

  .empty-state-path {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px 12px;
    max-width: 660px;
    margin: 20px auto 14px;
    padding: 11px 12px;
    border: 1px solid var(--pd-border);
    border-radius: var(--pd-radius);
    background: var(--pd-accent-soft);
    list-style: none;
  }

  .empty-state-path li {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }

  .empty-state-path li span {
    color: var(--pd-accent);
    font-weight: 700;
  }

  .empty-state-helper {
    margin: 0 auto;
    color: var(--pd-muted);
    font-size: 12px;
  }

  .secondary-link {
    min-height: 40px;
    margin-top: 8px;
    padding: 8px 12px;
    border: 0;
    background: transparent;
    color: var(--pd-muted);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .secondary-link:hover {
    color: var(--pd-accent);
  }

  .secondary-link:focus-visible {
    outline: 2px solid var(--pd-accent);
    outline-offset: 2px;
  }

  .context-loading {
    max-width: 720px;
    margin: 24px auto;
    padding: 20px;
    color: var(--pd-muted);
    text-align: center;
  }

  .context-loading p {
    margin: 0;
  }

  .entry-guidance {
    margin: 0 0 10px;
    padding: 9px 12px;
    border: 1px solid var(--pd-border);
    border-left: 3px solid var(--pd-accent);
    border-radius: 6px;
    background: var(--pd-surface);
    color: var(--pd-muted);
  }

  .manual-mode-actions {
    margin: 0 0 6px;
  }

  .input-grid {
    display: flex;
    flex-wrap: wrap;
    min-width: 0;
    gap: var(--pd-layout-gap);
    align-items: flex-start;
  }

  .connection-workspace {
    min-width: 0;
    flex: 1 1 280px;
  }

  .sql-workspace {
    display: flex;
    min-width: 0;
    flex: 3 1 620px;
    flex-direction: column;
    gap: var(--pd-layout-gap);
  }

  .snapshot-history {
    margin: 0 0 var(--pd-layout-gap);
    padding: 12px;
    border: 1px solid var(--pd-border);
    border-left: 3px solid var(--pd-accent);
    border-radius: 6px;
    background: var(--pd-surface);
  }

  .snapshot-history-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .snapshot-history h2 {
    margin: 6px 0 0;
    font-size: 16px;
    overflow-wrap: anywhere;
  }

  .snapshot-history-reanalysis,
  .snapshot-history-note {
    margin: 6px 0 0;
    color: var(--pd-muted);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .snapshot-history-metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin-top: 8px;
    color: var(--pd-muted);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .snapshot-history-sql {
    margin-top: 8px;
  }

  .snapshot-history-sql summary {
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  }

  .snapshot-history-sql pre {
    max-height: 240px;
    margin: 6px 0 0;
    padding: 8px;
    overflow: auto;
    border: 1px solid var(--pd-border);
    border-radius: 5px;
    background: var(--pd-surface-muted);
    font-size: 11px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
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
  }
</style>
