<script>
  /**
   * Raw Plan viewer.
   *
   * The payload is exactly what the host returned: JSON is pretty-printed for
   * reading, text / XML stay as-is. Nothing is rewritten or re-serialized. The
   * viewer is collapsed by default and caps only the *display* length so a
   * multi-megabyte plan cannot freeze the DOM; the note says when that happens.
   */
  import { createTranslator } from "../lib/i18n/index.js";

  let {
    locale = "zh-CN",
    hostResult = null,
    preview = null,
    warningLabels = [],
  } = $props();

  const t = $derived(createTranslator(locale).t);
  const numberLocale = $derived(locale === "en" ? "en-US" : "zh-CN");

  const formatLabel = $derived(
    hostResult?.format === "json" ? "JSON" : hostResult?.format === "xml" ? "ShowPlanXML" : "text",
  );
</script>

<section class="panel raw-panel">
  <header class="panel-head">
    <h2>{t("raw.title")}</h2>
    {#if hostResult}
      <span class="hint">
        {hostResult.dbType} · {formatLabel}
        {#if hostResult.truncated}<span class="badge warning">{t("raw.truncated")}</span>{/if}
      </span>
    {/if}
  </header>

  {#if hostResult === null || preview === null}
    <p class="empty">{t("raw.empty")}</p>
  {:else}
    <div class="body">
      {#if warningLabels.length > 0}
        <ul class="warnings">
          {#each warningLabels as label (label)}
            <li>{label}</li>
          {/each}
        </ul>
      {/if}

      <details>
        <summary>{t("raw.view", { count: preview.totalChars.toLocaleString(numberLocale) })}</summary>
        {#if preview.truncatedForDisplay}
          <p class="preview-note">{t("raw.previewNote", { count: preview.text.length.toLocaleString(numberLocale) })}</p>
        {/if}
        <pre class="raw mono">{preview.text}</pre>
      </details>
    </div>
  {/if}
</section>

<style>
  .body {
    padding: 10px 12px 12px;
  }

  .warnings {
    margin: 0 0 8px;
    padding-left: 18px;
    color: var(--pd-warning-fg);
    font-size: 11px;
  }

  summary {
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
  }

  .preview-note {
    margin: 6px 0 0;
    color: var(--pd-muted);
    font-size: 11px;
  }

  .raw {
    max-height: 420px;
    margin: 8px 0 0;
    padding: 8px 10px;
    overflow: auto;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface-muted);
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
