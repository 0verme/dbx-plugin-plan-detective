<script>
  import { createTranslator } from "../lib/i18n/index.js";

  // ---------------------------------------------------------------------------
  // Phase 0 · Host Capability Audit Harness (development view)
  //
  // Kept next to the fixture-driven analysis UI because it is the tool that
  // verifies the Host API surface of the DBX build under test. t8y2/dbx#9692
  // (Host API 1.2) is merged, so the real plan path lives in the Host 分析
  // view; this harness stays as a raw-bridge inspector. It implements NO Plan
  // Detective business logic: no plan parser, no metrics, no rules, no database
  // driver, no query execution of its own.
  //
  // It only:
  //   1. prints the bridge surface injected as `window.dbxPlugin`
  //   2. prints the host `init` message (permissions, locale, identity)
  //   3. prints `dbxPlugin.context` and `request("host.getContext")`
  //   4. probes candidate host method names and classifies the replies
  //
  // Method names that are never called with side effects: mutating methods are
  // probed with invalid/empty params, which returns an argument or permission
  // error for a registered method and "Unsupported plugin host method" for an
  // unknown one.
  // ---------------------------------------------------------------------------

  /** Methods the public plugin-host bridge is documented to dispatch. */
  const DOCUMENTED_PROBES = [
    { method: "host.getContext", params: undefined, note: "workbench context snapshot" },
    { method: "host.getPlanCapabilities", params: { connectionId: "__audit__" }, note: "Plan API 1.2: capability probe (expects connection error, proves registration)" },
    { method: "host.explainPlan", params: { connectionId: "__audit__", sql: "SELECT 1", mode: "estimated" }, note: "Plan API 1.2: estimated plan probe (expects connection error, proves registration)" },
    { method: "ui.readAsset", params: { path: "../escape" }, note: "invalid path → validation error proves registration" },
    { method: "host.copy", params: {}, note: "missing text → validation error" },
    { method: "host.saveFile", params: {}, note: "missing payload → validation error" },
    { method: "host.openWorkbench", params: {}, note: "permission gate / validation error" },
    { method: "host.openFilesystem", params: {}, note: "permission gate / validation error" },
    { method: "host.reopenConnection", params: {}, note: "invalid connectionId → validation error" },
    { method: "backend.invoke", params: { method: "audit/ping", timeoutMs: 2000 }, note: "plugin sidecar RPC (this plugin has no backend)" },
    { method: "backend.notify", params: { method: "audit/ping" }, note: "plugin sidecar notification" },
  ];

  /** Candidate names that would be required for execution-plan intelligence. */
  const CAPABILITY_PROBES = [
    "host.executeQuery",
    "host.executeSql",
    "host.query",
    "query/execute",
    "sql/execute",
    "host.explain",
    "sql/explain",
    "explain",
    "host.getExecutionPlan",
    "host.getQueryPlan",
    "host.getPlan",
    "host.getRawPlan",
    "host.getQueryContext",
    "host.getCurrentSql",
    "host.getConnection",
    "host.getConnections",
    "host.getDatabases",
    "host.getSchema",
    "host.getDatabaseVersion",
    "host.getServerVersion",
    "connection/list",
    "connection/get",
    "schema/list",
    "database/list",
    "host.cancelQuery",
    "query/cancel",
    "host.timeout",
  ];

  const UNSUPPORTED_PATTERN = /Unsupported plugin host method/i;

  let initMessage = $state(null);
  let bridgeSurface = $state([]);
  let liveContext = $state(null);
  let bridgedContext = $state(null);
  let probes = $state([]);
  let running = $state(false);
  let error = $state(null);
  let reportData = $state(null);

  let { locale = "zh-CN" } = $props();
  const t = $derived(createTranslator(locale).t);
  const auditNotice = $derived(t("dev.audit.notice"));
  const report = $derived(reportData === null ? "" : JSON.stringify({ ...reportData, auditNotice }, null, 2));

  /** The public bridge is only injected inside a real DBX host. */
  function hostBridge() {
    return typeof window === "undefined" ? null : (window.dbxPlugin ?? null);
  }

  const hasBridge = hostBridge() !== null;

  function summarize(value) {
    if (value === undefined) return "undefined";
    try {
      const text = JSON.stringify(value);
      if (text === undefined) return String(value);
      return text.length > 900 ? `${text.slice(0, 900)}… (${text.length} chars)` : text;
    } catch (cause) {
      return `[unserializable: ${String(cause)}]`;
    }
  }

  function classify(method, outcome) {
    if (outcome.status === "resolved") return "RESOLVED";
    if (UNSUPPORTED_PATTERN.test(outcome.message)) return "UNSUPPORTED";
    return "REJECTED";
  }

  async function probe(method, params) {
    const bridge = hostBridge();
    const startedAt = Date.now();
    if (bridge === null) {
      return { method, params: params ?? null, status: "UNSUPPORTED", outcome: "window.dbxPlugin is not available in this context", ms: 0 };
    }
    const outcome = await new Promise((resolve) => {
      try {
        Promise.resolve(bridge.request(method, params)).then(
          (value) => resolve({ status: "resolved", value }),
          (cause) => resolve({ status: "rejected", message: cause instanceof Error ? cause.message : String(cause) }),
        );
      } catch (cause) {
        resolve({ status: "threw", message: cause instanceof Error ? cause.message : String(cause) });
      }
    });
    return {
      method,
      params: params === undefined ? null : params,
      status: outcome.status === "resolved" ? "RESOLVED" : classify(method, outcome),
      outcome: outcome.status === "resolved" ? summarize(outcome.value) : (outcome.message ?? ""),
      ms: Date.now() - startedAt,
    };
  }

  async function refreshContext() {
    const bridge = hostBridge();
    if (bridge === null) {
      liveContext = null;
      bridgedContext = null;
      return;
    }
    liveContext = bridge.context ?? null;
    try {
      bridgedContext = await bridge.request("host.getContext");
    } catch (cause) {
      bridgedContext = { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async function runAudit() {
    const bridge = hostBridge();
    if (bridge === null) {
      error = { key: "dev.audit.error.noHost" };
      return;
    }
    running = true;
    error = null;
    try {
      bridgeSurface = Object.keys(bridge).sort();
      await refreshContext();
      const results = [];
      for (const entry of DOCUMENTED_PROBES) {
        results.push({ ...(await probe(entry.method, entry.params)), note: entry.note });
      }
      for (const method of CAPABILITY_PROBES) {
        results.push({
          ...(await probe(method, { connectionId: bridgedContext?.connectionId ?? null, sql: "SELECT 1" })),
          note: "execution-plan capability candidate",
        });
      }
      probes = results;
      reportData = {
          harness: "phase0-host-capability-audit",
          generatedAt: new Date().toISOString(),
          auditNotice,
          host: { userAgent: navigator.userAgent, locale: bridge.locale },
          initMessage,
          bridgeSurface,
          context: liveContext,
          bridgedContext,
          probes,
        };
    } catch (cause) {
      error = { message: cause instanceof Error ? cause.message : String(cause) };
    } finally {
      running = false;
    }
  }

  function statusClass(status) {
    if (status === "RESOLVED") return "ok";
    if (status === "UNSUPPORTED") return "missing";
    return "denied";
  }

  $effect(() => {
    const bridge = hostBridge();
    if (bridge === null) return;
    bridge.ready.then(() => {
      liveContext = bridge.context ?? null;
      void refreshContext();
    });
    const onInit = (event) => {
      initMessage = event.detail ?? null;
    };
    document.addEventListener("dbx-plugin-init", onInit);
    return () => document.removeEventListener("dbx-plugin-init", onInit);
  });
</script>

<section class="panel audit-panel">
  <header class="panel-head">
    <h2>{t("dev.audit.title")}</h2>
    <span class="hint">{t("dev.audit.hint")}</span>
  </header>

  <div class="audit-body">
    <p class="notice">{auditNotice}</p>
    {#if !hasBridge}
      <p class="notice">
        {t("dev.audit.noHost")}
      </p>
    {/if}
    <p class="hint">
      {t("dev.audit.description")}
    </p>
    <button type="button" class="run" onclick={runAudit} disabled={running}>
      {running ? t("dev.audit.running") : t("dev.audit.run")}
    </button>
    {#if error}<p class="error">{error.key ? t(error.key) : error.message}</p>{/if}

    <h3 class="section-title">{t("dev.audit.bridgeSurface")}</h3>
    <code class="surface">{bridgeSurface.join(", ") || "…"}</code>

    <h3 class="section-title">{t("dev.audit.initMessage")}</h3>
    <pre>{initMessage === null ? t("dev.audit.notReceived") : JSON.stringify(initMessage, null, 2)}</pre>

    <h3 class="section-title">{t("dev.audit.context")}</h3>
    <h4 class="label">{t("dev.audit.bridgeContext")}</h4>
    <pre>{JSON.stringify(liveContext, null, 2) ?? "null"}</pre>
    <h4 class="label">{t("dev.audit.requestContext")}</h4>
    <pre>{JSON.stringify(bridgedContext, null, 2) ?? "null"}</pre>

    {#if probes.length > 0}
      <h3 class="section-title">{t("dev.audit.probes")}</h3>
      <table class="probe-table">
        <thead>
          <tr><th>{t("dev.audit.method")}</th><th>{t("dev.audit.status")}</th><th>{t("dev.audit.outcome")}</th><th>{t("dev.audit.milliseconds")}</th></tr>
        </thead>
        <tbody>
          {#each probes as entry (entry.method)}
            <tr>
              <td><code>{entry.method}</code></td>
              <td><span class="probe-status {statusClass(entry.status)}">{entry.status}</span></td>
              <td class="outcome"><code>{entry.outcome}</code></td>
              <td>{entry.ms}</td>
            </tr>
          {/each}
        </tbody>
      </table>

      <h3 class="section-title">{t("dev.audit.machineReport")}</h3>
      <pre data-audit-report>{report}</pre>
    {/if}
  </div>
</section>

<style>
  .audit-body {
    padding: 10px 12px 14px;
  }

  .notice {
    margin: 0 0 8px;
    padding: 8px 10px;
    border: 1px solid var(--pd-high-border);
    border-radius: 6px;
    background: var(--pd-high-bg);
    color: var(--pd-high-fg);
    font-weight: 600;
  }

  .run {
    margin: 10px 0 14px;
    border: 0;
    border-radius: 6px;
    padding: 7px 14px;
    background: var(--pd-accent);
    color: #fff;
    font: inherit;
    cursor: pointer;
  }

  .run:disabled {
    opacity: 0.6;
    cursor: progress;
  }

  .error {
    color: var(--pd-high-fg);
    font-weight: 600;
  }

  .section-title {
    margin: 16px 0 6px;
    font-size: 12px;
  }

  .label {
    margin: 8px 0 4px;
    color: var(--pd-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  pre {
    max-width: 100%;
    max-height: 320px;
    margin: 0;
    padding: 10px;
    overflow: auto;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface-muted);
    font-family: var(--pd-mono);
    font-size: 11px;
  }

  .surface {
    display: block;
    padding: 8px 10px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface-muted);
    font-size: 11px;
    word-break: break-word;
  }

  .probe-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }

  .probe-table th,
  .probe-table td {
    padding: 4px 6px;
    border-bottom: 1px solid var(--pd-border);
    text-align: left;
    vertical-align: top;
  }

  .outcome {
    max-width: 520px;
    word-break: break-word;
    font-family: var(--pd-mono);
  }

  .probe-status {
    display: inline-flex;
    padding: 0 7px;
    border-radius: 999px;
    font-weight: 600;
  }

  .probe-status.ok {
    background: rgba(22, 163, 74, 0.16);
    color: #15803d;
  }

  .probe-status.denied {
    background: var(--pd-warning-bg);
    color: var(--pd-warning-fg);
  }

  .probe-status.missing {
    background: var(--pd-high-bg);
    color: var(--pd-high-fg);
  }
</style>
