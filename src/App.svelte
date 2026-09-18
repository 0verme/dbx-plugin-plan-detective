<script>
  // ---------------------------------------------------------------------------
  // Phase 0 · Host Capability Audit Harness
  //
  // DEVELOPMENT / AUDIT ONLY. This page exists to observe what the public DBX
  // Plugin Host API exposes to a sandboxed plugin workbench. It intentionally
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
    const startedAt = Date.now();
    const outcome = await new Promise((resolve) => {
      try {
        Promise.resolve(window.dbxPlugin.request(method, params)).then(
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
    liveContext = window.dbxPlugin.context ?? null;
    try {
      bridgedContext = await window.dbxPlugin.request("host.getContext");
    } catch (cause) {
      bridgedContext = { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async function runAudit() {
    running = true;
    error = "";
    try {
      bridgeSurface = Object.keys(window.dbxPlugin).sort();
      await refreshContext();
      const results = [];
      for (const entry of DOCUMENTED_PROBES) {
        results.push({ ...(await probe(entry.method, entry.params)), note: entry.note });
      }
      for (const method of CAPABILITY_PROBES) {
        results.push({ ...(await probe(method, { connectionId: bridgedContext?.connectionId ?? null, sql: "SELECT 1" })), note: "execution-plan capability candidate" });
      }
      probes = results;
      report = JSON.stringify(
        {
          harness: "phase0-host-capability-audit",
          generatedAt: new Date().toISOString(),
          auditNotice: AUDIT_NOTICE,
          host: { userAgent: navigator.userAgent, locale: window.dbxPlugin.locale },
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
    window.dbxPlugin.ready.then(() => {
      liveContext = window.dbxPlugin.context ?? null;
      void refreshContext();
    });
    const onInit = (event) => {
      initMessage = event.detail ?? null;
    };
    document.addEventListener("dbx-plugin-init", onInit);
    return () => document.removeEventListener("dbx-plugin-init", onInit);
  });
</script>

<svelte:head><title>DBX Plan Detective · Host Capability Audit (dev)</title></svelte:head>

<main>
  <div class="eyebrow">Phase 0 · Host Capability Audit</div>
  <h1>Host Capability Audit Harness</h1>
  <p class="notice">{AUDIT_NOTICE}</p>
  <p class="hint">
    本页仅用于观察公开 Plugin Host API 的实际暴露面，不实现任何业务诊断逻辑，也不自行连接数据库。
    英文方法名、参数与错误原文保持原样，以作为审计证据。
  </p>
  <button type="button" onclick={runAudit} disabled={running}>{running ? "Running…" : "Run capability audit"}</button>
  {#if error}<p class="error">{error}</p>{/if}

  <section class="dbx-card">
    <h2 class="dbx-section-title">Bridge surface (window.dbxPlugin)</h2>
    <code class="surface">{bridgeSurface.join(", ") || "…"}</code>
  </section>

  <section class="dbx-card">
    <h2 class="dbx-section-title">Host init message</h2>
    <pre>{JSON.stringify(initMessage, null, 2) ?? "not received"}</pre>
  </section>

  <section class="dbx-card">
    <h2 class="dbx-section-title">Context</h2>
    <h3 class="dbx-label">dbxPlugin.context</h3>
    <pre>{JSON.stringify(liveContext, null, 2) ?? "null"}</pre>
    <h3 class="dbx-label">request("host.getContext")</h3>
    <pre>{JSON.stringify(bridgedContext, null, 2) ?? "null"}</pre>
  </section>

  {#if probes.length > 0}
    <section class="dbx-card">
      <h2 class="dbx-section-title">Host method probes</h2>
      <table class="dbx-table">
        <thead>
          <tr><th>Method</th><th>Status</th><th>Outcome</th><th>ms</th></tr>
        </thead>
        <tbody>
          {#each probes as entry (entry.method)}
            <tr>
              <td><code>{entry.method}</code></td>
              <td><span class="badge {statusClass(entry.status)}">{entry.status}</span></td>
              <td class="outcome"><code>{entry.outcome}</code></td>
              <td>{entry.ms}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
    <section class="dbx-card">
      <h2 class="dbx-section-title">Machine-readable report</h2>
      <pre data-audit-report>{report}</pre>
    </section>
  {/if}
</main>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; min-height: 100vh; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: CanvasText; background: Canvas; }
  main { min-height: 100vh; padding: clamp(20px, 5vw, 56px); background: radial-gradient(circle at top left, rgba(109, 93, 252, .18), transparent 42%), Canvas; }
  .eyebrow { color: #6d5dfc; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  h1 { margin: 12px 0 8px; font-size: clamp(26px, 4vw, 42px); }
  h2 { margin-bottom: 10px; }
  h3 { display: block; margin: 12px 0 6px; }
  p { max-width: 760px; line-height: 1.6; }
  .notice { margin-top: 14px; padding: 10px 12px; border-radius: 10px; background: rgba(220, 38, 38, .12); color: #b91c1c; font-weight: 600; }
  .hint { opacity: .72; font-size: 13px; }
  .error { color: #b91c1c; font-weight: 600; }
  button { margin: 8px 0 18px; border: 0; border-radius: 10px; padding: 11px 16px; color: white; background: #6d5dfc; font: inherit; cursor: pointer; }
  button:disabled { opacity: .6; cursor: progress; }
  section { margin-bottom: 16px; }
  pre { max-width: 100%; max-height: 340px; margin: 0; padding: 12px; overflow: auto; border-radius: 8px; background: color-mix(in srgb, CanvasText 7%, transparent); font-size: 12px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .surface { display: block; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, CanvasText 7%, transparent); font-size: 12px; word-break: break-word; }
  .outcome { max-width: 520px; word-break: break-word; font-size: 12px; }
  .badge { display: inline-flex; padding: 0 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .badge.ok { background: rgba(22, 163, 74, .16); color: #15803d; }
  .badge.denied { background: rgba(217, 119, 6, .18); color: #b45309; }
  .badge.missing { background: rgba(220, 38, 38, .16); color: #b91c1c; }
</style>
