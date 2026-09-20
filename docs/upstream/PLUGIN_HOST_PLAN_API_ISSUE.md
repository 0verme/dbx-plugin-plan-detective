<!--
上游 Feature Issue 正文草稿（尚未提交）。

- 目标仓库：https://github.com/t8y2/dbx
- 建议标题：`[Feature] Plugin Host API: expose read-only execution plan access`
- 复核时间：2026-09-20，`t8y2/dbx` `main @ d7e1b47aa46bedf5b05427a5a96dc3afa6d6fe83`
- 重复性检查：`getQueryContext` / `explainPlans` / `host.plans` / `raw plan` / `explain + plugin` / GitHub Discussions 均未发现重复 Issue；相关但不重复的 Issue 见正文 Related 一节。
- 提交方式：中文长正文不要用 `--body "..."`；直接用 UTF-8 文件提交（顶部 HTML 注释在 Issue 中不可见）：

  gh issue create --repo t8y2/dbx \
    --title '[Feature] Plugin Host API: expose read-only execution plan access' \
    --body-file docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md

  提交前请再次确认上游没有新增重复 Issue。
-->

## Summary

DBX Core already owns everything needed to acquire an execution plan: the connection, the credentials, the driver, `build_explain_sql`, the read-only transaction handling for `EXPLAIN ANALYZE`, timeouts, and cancellation. None of it is reachable from a plugin. The public plugin Host API exposes `host.getContext`, `host.openWorkbench`, file/asset helpers, downloads, and the plugin's own backend RPC — but no method and no permission related to execution plans.

A plugin that only wants to *analyze* plans (parsing, normalization, metrics, rule-based diagnosis, visualization, diff) therefore cannot obtain the raw plan without shipping its own database driver and credentials. That is exactly the duplication the plugin boundary is meant to prevent.

This requests one narrow, read-only path: DBX Core acquires the plan, the plugin consumes the raw plan output.

## Current state (`main @ d7e1b47`, 2026-09-20)

- Frontend host method registry: `host.getContext`, `host.reopenConnection`, `ui.readAsset`, `host.copy`, `host.saveFile`, `host.downloadFile`, `host.cancelDownload`, `host.openWorkbench` (requires `host.workbench`), `host.openFilesystem` (requires `host.filesystem`), `backend.invoke | notify | sendBinary`.
- Declared manifest permissions: `host.events`, `host.binary`, `host.workbench`, `host.filesystem`, `host.network:<origin>`. None of them relate to query context or plans.
- `result-view` on `main` (after #9599) now delivers `sql`, `connectionId`, `database`, and a bounded `result` snapshot to the plugin UI. That covers query context for that one surface; this request does not ask to change it.
- There is no method, permission, or event for EXPLAIN or raw plan acquisition. Runtime probing of 28 candidate method names (`host.explain`, `host.getExecutionPlan`, `host.getRawPlan`, `host.getQueryContext`, `query/cancel`, `host.timeout`, …) against DBX v0.6.16 returned `Unsupported plugin host method` for all of them.
- DBX Core internally has all of it: per-dialect `build_explain_sql`, PostgreSQL read-only `EXPLAIN (ANALYZE, …)` with `BEGIN READ ONLY` + `ROLLBACK`, `execute_query` / `cancel_query` with the timeout budget, and the built-in Plan Canvas (#5160) with internal plan normalization for six engines. The raw plan is simply not exposed to plugins.

## Requested minimal surface

New manifest permissions:

| Permission | Allows | Risk |
| --- | --- | --- |
| `host.plans:read` | Query context for plans + Estimated plan (`mode=estimated`) | Low: never executes the statement |
| `host.plans:execute` | Adds Actual plan (`mode=actual`) | **Higher**: the statement is really executed |

`host.plans:execute` should be opt-in per plugin and shown in Plugin Center; on production connections it should require an additional explicit confirmation.

New host methods:

- **`host.getQueryContext()`** — returns host-owned context for the active query tab: `connectionId`, `database`, `schema?`, `dbType`, `dbVersion?`, `sql`, plus `readOnly` / `isProduction` markers when the host has them. Takes no connection parameter: the host decides the source, so a plugin cannot ask about a connection it was not given.
- **`host.getConnectionCapabilities(connectionId?)`** — `{ dbType, dbVersion?, supports: { explain, explainAnalyze }, limits: { maxTimeoutMs, maxPlanBytes } }`, so plugins can degrade correctly (MySQL currently has no analyze path).
- **`host.explainPlans({ connectionId, database, schema?, sql, mode, timeoutMs? })`** — `mode: "estimated" | "actual"`. DBX Core generates the EXPLAIN statement through the existing `build_explain_sql` and returns the raw plan (`format: json | text | xml`, `truncated`, `executed`, `warnings`, `executionId`).
- **`host.cancelPlanExecution({ executionId })`** — idempotent cancel through the existing task registry.

Explicitly **not** requested: any generic SQL execution API. The plugin only passes the original SQL and a mode; the host decides the EXPLAIN statement.

## Security boundary

- Core remains the only side touching credentials, drivers, statement generation, transactions, and cancellation. The plugin never holds `connectionId` credentials and never sends EXPLAIN SQL.
- Reuse the existing safety validation (`is_safe_explain_sql_for_database`: `SELECT / WITH / TABLE / VALUES` only, dangerous keywords rejected, no multi-statement).
- `actual` keeps the existing PostgreSQL read-only transaction semantics; MySQL reports `explainAnalyze: false` instead of inventing a path.
- `timeoutMs` is clamped by the host to the connection / global limit; timeout errors are distinguishable (e.g. `PLAN_TIMEOUT`).
- Response payload is limited to plan output and metadata: no credentials, no full result rows; `maxPlanBytes` caps the payload.
- Permissions are statically visible in the manifest, so store review can tell whether a plugin may execute SQL.

## Ownership split

| DBX Core owns | Plugin owns |
| --- | --- |
| connection, credentials, driver | plan parsing |
| EXPLAIN generation and safety validation | normalization |
| execution (estimated vs actual), transactions | metrics |
| timeout, cancel | diagnosis, visualization, diff |
| result size / permission enforcement | — |

## Why this belongs in Core

- Credentials and drivers only exist in Core; a plugin-side execution layer would duplicate them and weaken the boundary.
- Safety validation, timeout, and cancel are only real where the query actually runs.
- Dialect differences (PG JSON, MySQL JSON/TRADITIONAL, SQL Server `STATISTICS XML`, Oracle / Dameng text) already have one implementation in Core.
- The plugin stays a plan consumer instead of becoming another database client.

## Related

- #9396 (open) asks for a broader capability — plugins executing their own SQL on a host connection. This request is deliberately narrower: read-only plan acquisition, no arbitrary SQL execution. It stays useful even if #9396 evolves differently.
- #5161 / #5160 (merged) added the built-in Plan Canvas and internal plan normalization. This request does not ask for another built-in view; it asks for raw plan access so external plugins can build analyses DBX does not ship.
- #9597 / #9599 (merged) fixed the `result-view` open path; on `main` a result-view already receives `sql` / `connectionId` / `database` / a bounded result snapshot. That covers query context for one surface, not plan acquisition.

## Evidence

Source audit plus runtime probing of DBX v0.6.16 (28 candidate methods, all `Unsupported plugin host method`) is documented here:
<https://github.com/0verme/dbx-plugin-plan-detective/blob/main/docs/HOST_CAPABILITY_AUDIT.md>

## 中文摘要（简短）

DBX Core 已具备 EXPLAIN / Actual Plan / 超时 / 取消能力，但插件完全不可达。本 Issue 只请求一条最小只读路径：`host.getQueryContext`、`host.getConnectionCapabilities`、`host.explainPlans`、`host.cancelPlanExecution`，以及 `host.plans:read`（Estimated，低风险）与 `host.plans:execute`（Actual，显式开关、更高风险）两个权限。不请求任意 SQL 执行 API；EXPLAIN 语句始终由 DBX 生成，连接、凭据、驱动、安全校验、事务、超时、取消全部留在 DBX Core。
