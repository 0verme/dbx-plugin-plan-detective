<script>
  import PlanTree from "./PlanTree.svelte";
  import { DIFF_GROUP_ORDER } from "../core/diff/plan-diff-report.js";
  import { formatNumber } from "../lib/format.js";
  import { createTranslator } from "../lib/i18n/index.js";
  import { presentFinding } from "../lib/finding-presentation.js";
  import { presentHotspotReason } from "../lib/hotspot-presentation.js";
  import {
    buildDiffMarks,
    describeEntryFields,
    entryNodeIds,
    fieldLabel,
    nodePairDetails,
    visibleNodePairDetails,
  } from "../lib/plan-diff-view.js";
  import {
    buildTreeRows,
    expandAncestors,
    indexNodesById,
    nodeLabel,
    toggleCollapsed,
  } from "../lib/view-model.js";

  let {
    locale = "zh-CN",
    report = null,
    baselineAnalysis = null,
    currentAnalysis = null,
    error = null,
    onSwap = () => {},
    onExit = () => {},
  } = $props();

  const t = $derived(createTranslator(locale).t);
  const baselineRows = $derived(baselineAnalysis === null ? [] : buildTreeRows(baselineAnalysis.normalized.root));
  const currentRows = $derived(currentAnalysis === null ? [] : buildTreeRows(currentAnalysis.normalized.root));
  const baselineRowsById = $derived(new Map(baselineRows.map((row) => [row.id, row])));
  const currentRowsById = $derived(new Map(currentRows.map((row) => [row.id, row])));
  const baselineNodesById = $derived(baselineAnalysis === null ? new Map() : indexNodesById(baselineAnalysis.normalized.root));
  const currentNodesById = $derived(currentAnalysis === null ? new Map() : indexNodesById(currentAnalysis.normalized.root));
  const marks = $derived(report === null ? { baseline: new Map(), current: new Map() } : buildDiffMarks(report));
  const beforeToAfter = $derived(new Map((report?.matches ?? []).map((match) => [match.beforeId, match.afterId])));
  const afterToBefore = $derived(new Map((report?.matches ?? []).map((match) => [match.afterId, match.beforeId])));

  let collapsedBaseline = $state(new Set());
  let collapsedCurrent = $state(new Set());
  /** @type {{beforeId: string|null, afterId: string|null, key: string}|null} */
  let focus = $state(null);

  const focusedBefore = $derived(focus?.beforeId ? (baselineNodesById.get(focus.beforeId) ?? null) : null);
  const focusedAfter = $derived(focus?.afterId ? (currentNodesById.get(focus.afterId) ?? null) : null);
  const pairDetails = $derived(visibleNodePairDetails(nodePairDetails(focusedBefore, focusedAfter)));
  const focusedBeforeFindings = $derived((baselineAnalysis?.findings ?? []).filter((finding) => finding.nodeRef === focus?.beforeId));
  const focusedAfterFindings = $derived((currentAnalysis?.findings ?? []).filter((finding) => finding.nodeRef === focus?.afterId));
  const focusedBeforeHotspots = $derived((baselineAnalysis?.hotspots?.items ?? []).filter((hotspot) => hotspot.nodeId === focus?.beforeId));
  const focusedAfterHotspots = $derived((currentAnalysis?.hotspots?.items ?? []).filter((hotspot) => hotspot.nodeId === focus?.afterId));

  const totalChanges = $derived(
    report === null
      ? 0
      : report.summary.changed + report.summary.added + report.summary.removed + report.summary.unmatched + report.summary.ambiguous,
  );

  const DETAIL_FIELD_KEYS = Object.freeze({
    operator: "operator.nodeType",
    relation: "relation.name",
    alias: "relation.alias",
    index: "relation.indexName",
    rows: "estimatedRows",
    cost: "cost",
    filter: "filter",
    indexCondition: "indexCondition",
    joinType: "joinType",
    joinCondition: "joinCondition",
    sortKeys: "sortKeys",
    groupKeys: "groupKeys",
    message: "engineSpecific.mysql.message",
  });

  function fieldKey(key) {
    return DETAIL_FIELD_KEYS[key] ?? key;
  }

  function sideKindLabel(side) {
    if (side?.kind === "snapshot") return t("diff.side.snapshot");
    if (side?.kind === "current") return t("diff.side.live");
    return t("diff.side.unknown");
  }

  function sideTitle(side) {
    if (typeof side?.title === "string" && side.title.length > 0) return side.title;
    return side?.kind === "current" ? t("diff.side.live") : t("diff.side.unknownTitle");
  }

  function valueText(value) {
    if (value === null || value === undefined || value === "") return t("diff.unknown");
    if (Array.isArray(value)) return value.length === 0 ? t("diff.unknown") : value.join(", ");
    if (typeof value === "number") return formatNumber(value);
    return String(value);
  }

  function formatTime(value) {
    if (typeof value !== "string") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(locale === "en" ? "en-US" : "zh-CN", { dateStyle: "medium", timeStyle: "short" });
  }

  function reveal(rowMap, collapsedIds, nodeId) {
    return nodeId === null ? collapsedIds : expandAncestors(collapsedIds, rowMap.get(nodeId));
  }

  function setFocus(beforeId, afterId, key) {
    focus = { beforeId, afterId, key };
    collapsedBaseline = reveal(baselineRowsById, collapsedBaseline, beforeId);
    collapsedCurrent = reveal(currentRowsById, collapsedCurrent, afterId);
  }

  function focusEntry(entry) {
    const { beforeId, afterId } = entryNodeIds(entry);
    setFocus(beforeId, afterId, entry.key ?? `entry:${beforeId}:${afterId}`);
  }

  function focusAmbiguity(entry) {
    setFocus(entry.beforeIds[0] ?? null, entry.afterIds[0] ?? null, `ambiguous:${entry.beforeIds.join(",")}:${entry.afterIds.join(",")}`);
  }

  function selectBaselineNode(nodeId) {
    setFocus(nodeId, beforeToAfter.get(nodeId) ?? null, `baseline:${nodeId}`);
  }

  function selectCurrentNode(nodeId) {
    setFocus(afterToBefore.get(nodeId) ?? null, nodeId, `current:${nodeId}`);
  }

  function toggleBaselineNode(nodeId) {
    collapsedBaseline = toggleCollapsed(collapsedBaseline, nodeId);
  }

  function toggleCurrentNode(nodeId) {
    collapsedCurrent = toggleCollapsed(collapsedCurrent, nodeId);
  }

  function nodeText(nodeId, side) {
    const node = (side === "baseline" ? baselineNodesById : currentNodesById).get(nodeId);
    return node === undefined ? nodeId : nodeLabel(node);
  }

  function findingFor(analysis, ruleId, nodeId) {
    return (analysis?.findings ?? []).find((finding) => finding.ruleId === ruleId && finding.nodeRef === nodeId) ?? null;
  }

  function findingLabel(entry) {
    const useCurrent = entry.afterNodeId !== null;
    const analysis = useCurrent ? currentAnalysis : baselineAnalysis;
    const nodeId = useCurrent ? entry.afterNodeId : entry.beforeNodeId;
    const finding = findingFor(analysis, entry.ruleId, nodeId);
    return finding === null ? entry.ruleId : presentFinding(finding, locale).title;
  }

  function hotspotLabel(entry) {
    const useCurrent = entry.afterNodeId !== null;
    const analysis = useCurrent ? currentAnalysis : baselineAnalysis;
    const nodeId = useCurrent ? entry.afterNodeId : entry.beforeNodeId;
    const hotspot = (analysis?.hotspots?.items ?? []).find((item) => item.nodeId === nodeId);
    const reason = hotspot?.reasons?.find((item) => item.code === entry.reasonCode);
    if (reason === undefined) return entry.reasonCode;
    const node = (useCurrent ? currentNodesById : baselineNodesById).get(nodeId);
    return presentHotspotReason(reason, locale, node === undefined ? null : {
      relation: node.relation?.name ?? null,
      alias: node.relation?.alias ?? null,
      indexName: node.relation?.indexName ?? null,
      nodeType: node.nodeType,
      kind: node.kind,
      accessType: node.engineSpecific?.mysql?.accessType ?? null,
    }).summary;
  }

  function changedFieldsText(entry) {
    return entry.changedFields.map((field) => fieldLabel(field, t)).join(" · ");
  }
</script>

<section class="panel diff-panel" aria-labelledby="diff-title">
  <header class="diff-head">
    <div>
      <h2 id="diff-title">{t("diff.title")}</h2>
      <p class="diff-mode">{t("diff.mode")}</p>
    </div>
    <div class="diff-head-actions">
      {#if report?.status === "comparable"}
        <button type="button" class="diff-secondary" onclick={onSwap}>{t("diff.swap")}</button>
      {/if}
      <button type="button" class="diff-secondary" onclick={onExit}>{t("diff.exit")}</button>
    </div>
  </header>

  {#if error}
    <div class="diff-alert" role="alert">
      <strong>{t("diff.error.title")}</strong>
      <p>{t("diff.error.corrupt")}</p>
      <p class="diff-code">{error.code ?? t("diff.error.GENERIC")}</p>
    </div>
  {:else if report === null}
    <p class="diff-empty">{t("diff.error.unavailable")}</p>
  {:else}
    {#if report.sides}
      <div class="diff-sides">
        <div class="diff-side">
          <span class="badge info">{t("diff.side.baseline")}</span>
          <h3>{sideTitle(report.sides.baseline)}</h3>
          <p class="diff-side-kind">{sideKindLabel(report.sides.baseline)}</p>
          <dl>
            <dt>{t("diff.side.version")}</dt>
            <dd>{valueText(report.sides.baseline.databaseVersion)}</dd>
            <dt>{t("diff.side.source")}</dt>
            <dd>{report.sides.baseline.source === null ? t("diff.unknown") : [report.sides.baseline.source.databaseName, report.sides.baseline.source.schema].filter(Boolean).join(" / ")}</dd>
            <dt>{t("diff.side.time")}</dt>
            <dd>{formatTime(report.sides.baseline.capturedAt) ?? formatTime(report.sides.baseline.savedAt) ?? t("diff.unknown")}</dd>
          </dl>
          {#if report.sides.baseline.sql}
            <details class="diff-sql">
              <summary>{t("diff.side.sql")}</summary>
              <pre>{report.sides.baseline.sql}</pre>
            </details>
          {/if}
        </div>

        <div class="diff-side diff-side-current">
          <span class="badge info">{t("diff.side.current")}</span>
          <h3>{sideTitle(report.sides.current)}</h3>
          <p class="diff-side-kind">{sideKindLabel(report.sides.current)}</p>
          <dl>
            <dt>{t("diff.side.version")}</dt>
            <dd>{valueText(report.sides.current.databaseVersion)}</dd>
            <dt>{t("diff.side.source")}</dt>
            <dd>{report.sides.current.source === null ? t("diff.unknown") : [report.sides.current.source.databaseName, report.sides.current.source.schema].filter(Boolean).join(" / ")}</dd>
            <dt>{t("diff.side.time")}</dt>
            <dd>{formatTime(report.sides.current.capturedAt) ?? formatTime(report.sides.current.savedAt) ?? t("diff.unknown")}</dd>
          </dl>
          {#if report.sides.current.sql}
            <details class="diff-sql">
              <summary>{t("diff.side.sql")}</summary>
              <pre>{report.sides.current.sql}</pre>
            </details>
          {/if}
        </div>
      </div>
    {/if}

    {#if report.status === "incompatible"}
      <div class="diff-alert" role="alert">
        <strong>{t("diff.incompatible.title")}</strong>
        <p>{t(`diff.reason.${report.reasonCode}`, { database: report.database ?? t("diff.unknown") })}</p>
        <p class="diff-note">{t("diff.unsupported.scope")}</p>
      </div>
    {:else}
      <div class="diff-comparability" class:limited={report.comparability.status === "limited"}>
        <strong>{report.comparability.status === "limited" ? t("diff.comparability.limited") : t("diff.comparability.ok")}</strong>
        {#if report.comparability.reasons.length > 0}
          <ul>
            {#each report.comparability.reasons as reason (reason.code)}
              <li class:info={reason.level === "info"}>
                <span class="diff-reason-code">{reason.code}</span>
                {t(`diff.reason.${reason.code}`, {
                  baseline: valueText(reason.baseline),
                  current: valueText(reason.current),
                })}
              </li>
            {/each}
          </ul>
          <p class="diff-note">{t("diff.comparability.note")}</p>
        {/if}
      </div>

      <div class="diff-cost">
        <h3>{t("diff.cost.title")}</h3>
        {#if report.comparability.cost.status === "available"}
          <p>{t("diff.cost.values", {
            baseline: valueText(report.comparability.cost.baseline),
            current: valueText(report.comparability.cost.current),
          })}</p>
          <p class="diff-note">{t("diff.cost.native")}</p>
        {:else}
          <p>{t("diff.cost.withheld", { reason: t(`diff.reason.${report.comparability.cost.reasonCode}`) })}</p>
        {/if}
      </div>

      <ul class="diff-summary" aria-label={t("diff.summary.label")}>
        <li>{t("diff.summary.matched", { count: report.summary.matched })}</li>
        <li class="changed">{t("diff.summary.changed", { count: report.summary.changed })}</li>
        <li>{t("diff.summary.unchanged", { count: report.summary.unchanged })}</li>
        <li>{t("diff.summary.added", { count: report.summary.added })}</li>
        <li>{t("diff.summary.removed", { count: report.summary.removed })}</li>
        <li>{t("diff.summary.unmatched", { count: report.summary.unmatched })}</li>
        <li>{t("diff.summary.ambiguous", { count: report.summary.ambiguous })}</li>
      </ul>

      <div class="diff-trees">
        <div class="diff-tree">
          <PlanTree
            {locale}
            rows={baselineRows}
            collapsed={collapsedBaseline}
            selectedId={focus?.beforeId ?? null}
            diffMarks={marks.baseline}
            onSelect={selectBaselineNode}
            onToggle={toggleBaselineNode}
          />
          <p class="diff-tree-caption">{t("diff.tree.baseline")}</p>
        </div>
        <div class="diff-tree">
          <PlanTree
            {locale}
            rows={currentRows}
            collapsed={collapsedCurrent}
            selectedId={focus?.afterId ?? null}
            diffMarks={marks.current}
            onSelect={selectCurrentNode}
            onToggle={toggleCurrentNode}
          />
          <p class="diff-tree-caption">{t("diff.tree.current")}</p>
        </div>
      </div>

      <section class="diff-node" aria-labelledby="diff-node-title" aria-live="polite">
        <h3 id="diff-node-title">{t("diff.node.title")}</h3>
        {#if focus === null}
          <p class="diff-hint">{t("diff.node.hint")}</p>
        {:else}
          <table class="diff-node-table">
            <thead>
              <tr>
                <th scope="col">{t("diff.node.field")}</th>
                <th scope="col">{t("diff.side.baseline")}</th>
                <th scope="col">{t("diff.side.current")}</th>
              </tr>
            </thead>
            <tbody>
              {#each pairDetails as detail (detail.key)}
                <tr>
                  <th scope="row">{t(`diff.field.${fieldKey(detail.key)}`)}</th>
                  <td>{valueText(detail.before)}</td>
                  <td>{valueText(detail.after)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if focusedBefore === null || focusedAfter === null}
            <p class="diff-warning">{t("diff.node.missing")}</p>
          {/if}
          {#if focusedBeforeFindings.length > 0 || focusedAfterFindings.length > 0}
            <div class="diff-node-diag">
              <h4>{t("diff.findings.title")}</h4>
              <ul>
                {#each focusedBeforeFindings as finding (finding.id)}
                  <li><span class="diff-side-tag">{t("diff.side.baseline")}</span> {presentFinding(finding, locale).title}</li>
                {/each}
                {#each focusedAfterFindings as finding (finding.id)}
                  <li><span class="diff-side-tag">{t("diff.side.current")}</span> {presentFinding(finding, locale).title}</li>
                {/each}
              </ul>
            </div>
          {/if}
          {#if focusedBeforeHotspots.length > 0 || focusedAfterHotspots.length > 0}
            <div class="diff-node-diag">
              <h4>{t("diff.hotspots.title")}</h4>
              <ul>
                {#each focusedBeforeHotspots as hotspot (hotspot.id)}
                  <li><span class="diff-side-tag">{t("diff.side.baseline")}</span> {hotspot.reasons.map((reason) => reason.code).join(", ")}</li>
                {/each}
                {#each focusedAfterHotspots as hotspot (hotspot.id)}
                  <li><span class="diff-side-tag">{t("diff.side.current")}</span> {hotspot.reasons.map((reason) => reason.code).join(", ")}</li>
                {/each}
              </ul>
            </div>
          {/if}
        {/if}
      </section>

      <section class="diff-changes" aria-labelledby="diff-changes-title">
        <h3 id="diff-changes-title">{t("diff.changes.title")}</h3>
        <p class="diff-hint">{t("diff.changes.hint")}</p>
        {#if totalChanges === 0}
          <p class="diff-empty">{t("diff.changes.none")}</p>
        {/if}
        {#each DIFF_GROUP_ORDER as category (category)}
          {#if report.groups[category].length > 0}
            <div class="diff-group">
              <h4>{t(`diff.group.${category}`)} <span class="diff-count">{report.groups[category].length}</span></h4>
              <ul>
                {#each report.groups[category] as entry (entry.key)}
                  <li>
                    <button
                      type="button"
                      class="diff-entry"
                      class:selected={focus?.key === entry.key}
                      onclick={() => focusEntry(entry)}
                    >
                      <span class="diff-entry-node">{nodeText(entry.beforeId, "baseline")}</span>
                      <span aria-hidden="true">→</span>
                      <span class="diff-entry-node">{nodeText(entry.afterId, "current")}</span>
                      <span class="diff-entry-fields">{describeEntryFields(entry, t).join(" · ")}</span>
                      {#if category === "rows"}
                        <span class="diff-entry-delta">
                          {t("diff.rows.delta", {
                            before: valueText(entry.fields[0]?.before),
                            after: valueText(entry.fields[0]?.after),
                            delta: entry.rowsDelta === null ? t("diff.unknown") : (entry.rowsDelta > 0 ? "+" : "") + formatNumber(entry.rowsDelta),
                          })}
                        </span>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        {/each}
      </section>

      {#if report.nodes.added.length > 0 || report.nodes.removed.length > 0 || report.nodes.unmatched.baseline.length > 0 || report.nodes.unmatched.current.length > 0 || report.nodes.ambiguous.length > 0}
        <section class="diff-unmatched" aria-labelledby="diff-unmatched-title">
          <h3 id="diff-unmatched-title">{t("diff.unmatched.title")}</h3>
          {#if report.nodes.added.length > 0}
            <h4>{t("diff.added.title")}</h4>
            <ul>
              {#each report.nodes.added as entry (entry.id)}
                <li>
                  <button type="button" class="diff-entry" onclick={() => focusEntry(entry)}>
                    <span class="diff-entry-node">+ {nodeText(entry.id, "current")}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if report.nodes.removed.length > 0}
            <h4>{t("diff.removed.title")}</h4>
            <ul>
              {#each report.nodes.removed as entry (entry.id)}
                <li>
                  <button type="button" class="diff-entry" onclick={() => focusEntry(entry)}>
                    <span class="diff-entry-node">− {nodeText(entry.id, "baseline")}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if report.nodes.unmatched.baseline.length > 0 || report.nodes.unmatched.current.length > 0}
            <h4>{t("diff.unmatched.nodes")}</h4>
            <p class="diff-note">{t("diff.unmatched.note")}</p>
            <ul>
              {#each report.nodes.unmatched.baseline as entry (entry.id)}
                <li>
                  <button type="button" class="diff-entry" onclick={() => focusEntry(entry)}>
                    <span class="diff-side-tag">{t("diff.side.baseline")}</span>
                    <span class="diff-entry-node">{nodeText(entry.id, "baseline")}</span>
                    <span class="diff-entry-fields">{t(`diff.reason.${entry.reasonCode}`)}</span>
                  </button>
                </li>
              {/each}
              {#each report.nodes.unmatched.current as entry (entry.id)}
                <li>
                  <button type="button" class="diff-entry" onclick={() => focusEntry(entry)}>
                    <span class="diff-side-tag">{t("diff.side.current")}</span>
                    <span class="diff-entry-node">{nodeText(entry.id, "current")}</span>
                    <span class="diff-entry-fields">{t(`diff.reason.${entry.reasonCode}`)}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if report.nodes.ambiguous.length > 0}
            <h4>{t("diff.ambiguous.title")}</h4>
            <p class="diff-note">{t("diff.ambiguous.note")}</p>
            <ul>
              {#each report.nodes.ambiguous as entry, index (`ambiguous-${index}`)}
                <li>
                  <button type="button" class="diff-entry" onclick={() => focusAmbiguity(entry)}>
                    <span class="diff-side-tag">{t("diff.side.baseline")}</span>
                    <span class="diff-entry-node">{entry.before.map((node) => node.nodeType).join(", ") || t("diff.unknown")}</span>
                    <span aria-hidden="true">↔</span>
                    <span class="diff-side-tag">{t("diff.side.current")}</span>
                    <span class="diff-entry-node">{entry.after.map((node) => node.nodeType).join(", ") || t("diff.unknown")}</span>
                    <span class="diff-entry-fields">{t(`diff.reason.${entry.reasonCode}`)}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}

      <section class="diff-diagnostics" aria-labelledby="diff-diagnostics-title">
        <h3 id="diff-diagnostics-title">{t("diff.diagnostics.title")}</h3>
        <p class="diff-note">{t("diff.diagnostics.note")}</p>
        {#if report.diagnostics.status !== "available"}
          <p class="diff-empty">{t("diff.diagnostics.unavailable")}</p>
        {:else}
          {@const findings = report.diagnostics.findings}
          {@const hotspots = report.diagnostics.hotspots}
          <div class="diff-diagnostic-block">
            <h4>{t("diff.findings.title")}</h4>
            <dl>
              <dt>{t("diff.findings.added")}</dt>
              <dd>{findings.added.length}</dd>
              <dt>{t("diff.findings.resolved")}</dt>
              <dd>{findings.resolved.length}</dd>
              <dt>{t("diff.findings.evidenceChanged")}</dt>
              <dd>{findings.evidenceChanged.length}</dd>
              <dt>{t("diff.findings.unchanged")}</dt>
              <dd>{findings.unchanged}</dd>
              <dt>{t("diff.findings.unlinked")}</dt>
              <dd>{findings.unlinked.baseline.length + findings.unlinked.current.length}</dd>
            </dl>
            {#if findings.added.length > 0}
              <h5>{t("diff.findings.added")}</h5>
              <ul>
                {#each findings.added as entry (`f-added-${entry.ruleId}-${entry.afterNodeId}`)}
                  <li><button type="button" class="diff-text-link" onclick={() => focusEntry(entry)}>{findingLabel(entry)}</button></li>
                {/each}
              </ul>
            {/if}
            {#if findings.resolved.length > 0}
              <h5>{t("diff.findings.resolved")}</h5>
              <ul>
                {#each findings.resolved as entry (`f-resolved-${entry.ruleId}-${entry.beforeNodeId}`)}
                  <li><button type="button" class="diff-text-link" onclick={() => focusEntry(entry)}>{findingLabel(entry)}</button></li>
                {/each}
              </ul>
            {/if}
            {#if findings.evidenceChanged.length > 0}
              <h5>{t("diff.findings.evidenceChanged")}</h5>
              <ul>
                {#each findings.evidenceChanged as entry (`f-changed-${entry.ruleId}-${entry.beforeNodeId}`)}
                  <li>
                    <button type="button" class="diff-text-link" onclick={() => focusEntry(entry)}>{findingLabel(entry)}</button>
                    <span class="diff-entry-fields">{changedFieldsText(entry)}</span>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if findings.unlinked.baseline.length + findings.unlinked.current.length > 0}
              <h5>{t("diff.findings.unlinked")}</h5>
              <ul>
                {#each findings.unlinked.baseline as entry (`f-unlinked-a-${entry.ruleId}-${entry.beforeNodeId}`)}
                  <li><span class="diff-side-tag">{t("diff.side.baseline")}</span> {findingLabel(entry)} · {t("diff.unmatched.note")}</li>
                {/each}
                {#each findings.unlinked.current as entry (`f-unlinked-b-${entry.ruleId}-${entry.afterNodeId}`)}
                  <li><span class="diff-side-tag">{t("diff.side.current")}</span> {findingLabel(entry)} · {t("diff.unmatched.note")}</li>
                {/each}
              </ul>
            {/if}
          </div>

          <div class="diff-diagnostic-block">
            <h4>{t("diff.hotspots.title")}</h4>
            <dl>
              <dt>{t("diff.hotspots.added")}</dt>
              <dd>{hotspots.added.length}</dd>
              <dt>{t("diff.hotspots.resolved")}</dt>
              <dd>{hotspots.resolved.length}</dd>
              <dt>{t("diff.hotspots.evidenceChanged")}</dt>
              <dd>{hotspots.evidenceChanged.length}</dd>
              <dt>{t("diff.hotspots.unchanged")}</dt>
              <dd>{hotspots.unchanged}</dd>
              <dt>{t("diff.hotspots.unlinked")}</dt>
              <dd>{hotspots.unlinked.baseline.length + hotspots.unlinked.current.length}</dd>
            </dl>
            {#if hotspots.added.length > 0}
              <h5>{t("diff.hotspots.added")}</h5>
              <ul>
                {#each hotspots.added as entry (`h-added-${entry.reasonCode}-${entry.afterNodeId}`)}
                  <li><button type="button" class="diff-text-link" onclick={() => focusEntry(entry)}>{hotspotLabel(entry)}</button></li>
                {/each}
              </ul>
            {/if}
            {#if hotspots.resolved.length > 0}
              <h5>{t("diff.hotspots.resolved")}</h5>
              <ul>
                {#each hotspots.resolved as entry (`h-resolved-${entry.reasonCode}-${entry.beforeNodeId}`)}
                  <li><button type="button" class="diff-text-link" onclick={() => focusEntry(entry)}>{hotspotLabel(entry)}</button></li>
                {/each}
              </ul>
            {/if}
            {#if hotspots.evidenceChanged.length > 0}
              <h5>{t("diff.hotspots.evidenceChanged")}</h5>
              <ul>
                {#each hotspots.evidenceChanged as entry (`h-changed-${entry.reasonCode}-${entry.beforeNodeId}`)}
                  <li>
                    <button type="button" class="diff-text-link" onclick={() => focusEntry(entry)}>{hotspotLabel(entry)}</button>
                    <span class="diff-entry-fields">{changedFieldsText(entry)}</span>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if hotspots.unlinked.baseline.length + hotspots.unlinked.current.length > 0}
              <h5>{t("diff.hotspots.unlinked")}</h5>
              <ul>
                {#each hotspots.unlinked.baseline as entry (`h-unlinked-a-${entry.reasonCode}-${entry.beforeNodeId}`)}
                  <li><span class="diff-side-tag">{t("diff.side.baseline")}</span> {hotspotLabel(entry)} · {t("diff.unmatched.note")}</li>
                {/each}
                {#each hotspots.unlinked.current as entry (`h-unlinked-b-${entry.reasonCode}-${entry.afterNodeId}`)}
                  <li><span class="diff-side-tag">{t("diff.side.current")}</span> {hotspotLabel(entry)} · {t("diff.unmatched.note")}</li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</section>

<style>
  .diff-panel {
    display: grid;
    gap: 14px;
    margin-top: 12px;
  }

  .diff-head {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: flex-start;
    justify-content: space-between;
  }

  .diff-head h2 {
    margin: 0;
    font-size: 17px;
  }

  .diff-mode,
  .diff-note,
  .diff-hint {
    margin: 4px 0 0;
    color: var(--pd-muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .diff-head-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .diff-secondary {
    min-height: 30px;
    padding: 4px 10px;
    border: 1px solid var(--pd-border);
    border-radius: 5px;
    background: var(--pd-surface);
    color: var(--pd-fg);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .diff-secondary:hover {
    background: var(--pd-surface-muted);
  }

  .diff-sides {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  }

  .diff-side {
    min-width: 0;
    padding: 10px 12px;
    border: 1px solid var(--pd-border);
    border-left: 3px solid var(--pd-info-border, var(--pd-border));
    border-radius: 6px;
    background: var(--pd-surface);
  }

  .diff-side h3 {
    margin: 6px 0 2px;
    font-size: 14px;
    overflow-wrap: anywhere;
  }

  .diff-side-kind {
    margin: 0;
    color: var(--pd-muted);
    font-size: 12px;
  }

  .diff-side dl {
    display: grid;
    margin: 8px 0 0;
    gap: 2px 8px;
    grid-template-columns: auto 1fr;
    font-size: 12px;
  }

  .diff-side dt {
    color: var(--pd-muted);
  }

  .diff-side dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .diff-sql {
    margin-top: 8px;
    font-size: 12px;
  }

  .diff-sql pre {
    max-height: 140px;
    margin: 6px 0 0;
    padding: 8px;
    overflow: auto;
    border-radius: 4px;
    background: var(--pd-surface-muted);
    font-size: 11px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .diff-alert {
    padding: 10px 12px;
    border: 1px solid var(--pd-danger-border, #e6b3b3);
    border-radius: 6px;
    background: var(--pd-danger-bg, #fdecec);
    color: var(--pd-danger-fg, #a12626);
    font-size: 13px;
  }

  .diff-alert p {
    margin: 5px 0 0;
  }

  .diff-code {
    font-family: monospace;
    font-size: 11px;
  }

  .diff-empty {
    margin: 0;
    padding: 10px 12px;
    border: 1px dashed var(--pd-border);
    border-radius: 6px;
    color: var(--pd-muted);
    font-size: 12px;
  }

  .diff-comparability {
    padding: 10px 12px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
    background: var(--pd-surface-muted);
    font-size: 12px;
  }

  .diff-comparability.limited {
    border-color: var(--pd-warning-border, #e5c97a);
    background: var(--pd-warning-bg, #fffaf0);
  }

  .diff-comparability ul {
    margin: 6px 0 0;
    padding-left: 18px;
  }

  .diff-comparability li.info {
    color: var(--pd-muted);
  }

  .diff-reason-code {
    margin-right: 4px;
    font-family: monospace;
    font-size: 10px;
    opacity: 0.6;
  }

  .diff-cost h3,
  .diff-changes h3,
  .diff-unmatched h3,
  .diff-diagnostics h3,
  .diff-node h3 {
    margin: 0 0 4px;
    font-size: 14px;
  }

  .diff-cost p {
    margin: 4px 0 0;
    font-size: 12px;
  }

  .diff-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .diff-summary li {
    padding: 3px 8px;
    border: 1px solid var(--pd-border);
    border-radius: 999px;
    background: var(--pd-surface);
    font-size: 11px;
  }

  .diff-summary li.changed {
    border-color: var(--pd-accent);
    color: var(--pd-accent);
  }

  .diff-trees {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  }

  .diff-tree {
    min-width: 0;
  }

  .diff-tree-caption {
    margin: 4px 0 0;
    color: var(--pd-muted);
    font-size: 11px;
  }

  .diff-node {
    padding: 10px 12px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
  }

  .diff-node-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .diff-node-table th,
  .diff-node-table td {
    padding: 4px 6px;
    border-bottom: 1px solid var(--pd-border);
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
  }

  .diff-node-table thead th {
    color: var(--pd-muted);
    font-weight: 600;
  }

  .diff-node-table tbody th {
    width: 22%;
    color: var(--pd-muted);
    font-weight: 500;
  }

  .diff-warning {
    margin: 8px 0 0;
    color: var(--pd-warning-fg, #8a5a00);
    font-size: 12px;
  }

  .diff-node-diag h4 {
    margin: 10px 0 4px;
    font-size: 12px;
  }

  .diff-node-diag ul {
    margin: 0;
    padding-left: 18px;
    font-size: 12px;
  }

  .diff-changes {
    display: grid;
    gap: 8px;
  }

  .diff-group h4 {
    margin: 4px 0;
    font-size: 13px;
  }

  .diff-count {
    color: var(--pd-muted);
    font-size: 11px;
    font-weight: 400;
  }

  .diff-group ul,
  .diff-unmatched ul,
  .diff-diagnostics ul {
    display: grid;
    margin: 0;
    padding: 0;
    gap: 3px;
    list-style: none;
  }

  .diff-entry {
    display: flex;
    flex-wrap: wrap;
    width: 100%;
    gap: 4px 8px;
    align-items: baseline;
    padding: 5px 8px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .diff-entry:hover,
  .diff-entry.selected {
    border-color: var(--pd-accent);
    background: var(--pd-accent-soft);
  }

  .diff-entry-node {
    overflow-wrap: anywhere;
  }

  .diff-entry-fields {
    color: var(--pd-muted);
    font-size: 11px;
  }

  .diff-entry-delta {
    color: var(--pd-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .diff-side-tag {
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--pd-surface-muted);
    color: var(--pd-muted);
    font-size: 10px;
    white-space: nowrap;
  }

  .diff-text-link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--pd-accent);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .diff-text-link:hover {
    text-decoration: underline;
  }

  .diff-unmatched {
    display: grid;
    gap: 4px;
    padding-top: 6px;
    border-top: 1px solid var(--pd-border);
  }

  .diff-unmatched h4 {
    margin: 4px 0 0;
    font-size: 12px;
  }

  .diff-diagnostics {
    display: grid;
    gap: 8px;
    padding-top: 6px;
    border-top: 1px solid var(--pd-border);
  }

  .diff-diagnostic-block {
    padding: 8px 10px;
    border: 1px solid var(--pd-border);
    border-radius: 6px;
  }

  .diff-diagnostic-block h4 {
    margin: 0 0 6px;
    font-size: 13px;
  }

  .diff-diagnostic-block h5 {
    margin: 8px 0 2px;
    font-size: 11px;
    color: var(--pd-muted);
  }

  .diff-diagnostic-block dl {
    display: grid;
    margin: 0;
    gap: 2px 8px;
    grid-template-columns: auto 1fr;
    font-size: 12px;
  }

  .diff-diagnostic-block dt {
    color: var(--pd-muted);
  }

  .diff-diagnostic-block dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  .diff-diagnostic-block li {
    font-size: 12px;
  }

  @media (max-width: 720px) {
    .diff-head-actions {
      width: 100%;
    }

    .diff-secondary {
      flex: 1 1 120px;
    }
  }
</style>
