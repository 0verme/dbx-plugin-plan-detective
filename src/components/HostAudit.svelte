<script>
  // ---------------------------------------------------------------------------
  // Phase 0 · Host Capability Audit Harness (development view)
  //
  // Kept next to the fixture-driven analysis UI because it is the tool that
  // verifies the Host API surface once t8y2/dbx#9692 ships. It intentionally
  // implements NO Plan Detective business logic: no plan parser, no metrics, no
  // rules, no database driver, no query execution of its own.
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

  const AUDIT_NOTICE =
    "DEVELOPMENT / AUDIT ONLY — Phase 0 Host Capability Audit. No plan analysis is implemented here.";

  /** Methods the public plugin-host bridge is documented to dispatch. */
  const DOCUMENTED_PROBES = [
    { method: "host.getContext", params: undefined, note: "workbench context snapshot" },
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
  let error = $state("");
  let report = $state("");

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
      error = "未检测到 window.dbxPlugin：当前不是 DBX 宿主，宿主能力审计不可用。";
      return;
    }
    running = true;
    error = "";
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
      report = JSON.stringify(
        {
          harness: "phase0-host-capability-audit",
          generatedAt: new Date().toISOString(),
          auditNotice: AUDIT_NOTICE,
          host: { userAgent: navigator.userAgent, locale: bridge.locale },
          initMessage,
          bridgeSurface,
          context: liveContext,
          bridgedContext,
          probes,
        },
        null,
        2,
      );
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
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
    <h2>Host Capability Audit</h2>
    <span class="hint">Development / audit only · no plan analysis</span>
  </header>

  <div class="audit-body">
    <p class="notice">{AUDIT_NOTICE}</p>
    {#if !hasBridge}
      <p class="notice">
        未检测到 <code>window.dbxPlugin</code>：当前不是 DBX 宿主，宿主能力审计不可用；分析视图的 fixture 模式不受影响。
      </p>
    {/if}
    <p class="hint">
      本页仅用于观察公开 Plugin Host API 的实际暴露面，不实现任何业务诊断逻辑，也不自行连接数据库。
      英文方法名、参数与错误原文保持原样，以作为审计证据。
    </p>
    <button type="button" class="run" onclick={runAudit} disabled={running}>
      {running ? "Running…" : "Run capability audit"}
    </button>
    {#if error}<p class="error">{error}</p>{/if}

    <h3 class="section-title">Bridge surface (window.dbxPlugin)</h3>
    <code class="surface">{bridgeSurface.join(", ") || "…"}</code>

    <h3 class="section-title">Host init message</h3>
    <pre>{JSON.stringify(initMessage, null, 2) ?? "not received"}</pre>

    <h3 class="section-title">Context</h3>
    <h4 class="label">dbxPlugin.context</h4>
    <pre>{JSON.stringify(liveContext, null, 2) ?? "null"}</pre>
    <h4 class="label">request("host.getContext")</h4>
    <pre>{JSON.stringify(bridgedContext, null, 2) ?? "null"}</pre>

    {#if probes.length > 0}
      <h3 class="section-title">Host method probes</h3>
      <table class="probe-table">
        <thead>
          <tr><th>Method</th><th>Status</th><th>Outcome</th><th>ms</th></tr>
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

      <h3 class="section-title">Machine-readable report</h3>
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
