<!--
Downstream implementation / design note for the upstream Plugin Host API contract.

- Canonical upstream issue: https://github.com/t8y2/dbx/issues/9675 （2026-09-20 正式提交，当前唯一 upstream contract）
- 本文是 downstream implementation / design note，用于指导下游插件实现与兼容性判断，不是 upstream 需求来源。
- 若本文与 #9675 当前 scope 冲突，以 #9675 为准。
- 上游复核基线：`t8y2/dbx` `main @ a924285136568c693ad45c455fa0286ee39dca12`（2026-09-20，与 #9675 提交时一致）；早期审计基线为 `main @ d7e1b47`。
- 本文最初是上游 Feature Issue 正文草稿；#9675 提交后只保留为下游设计记录。
-->

# Plugin Host API — Estimated Plan（downstream design note）

> **Status / 文档定位**
>
> - **Canonical upstream issue: [t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)** —— 已正式提交，是当前唯一权威的 upstream contract。
> - 本文是 **downstream implementation / design note**：描述下游插件如何理解与使用该 contract，不是 upstream 需求的来源。
> - **若本文与 #9675 当前 scope 冲突，以 #9675 为准。**
> - 第一阶段只覆盖 **Estimated Plan**（`EXPLAIN ...`）；Actual Plan / `EXPLAIN ANALYZE` / `host.plans:execute` / generic SQL execution 不属于第一阶段，见本文 Future Considerations 一节。

## Summary

DBX Core already owns everything needed to acquire an **estimated** execution plan: the connection, the credentials, the driver, `build_explain_sql`, safety validation, timeouts, and cancellation. None of it is reachable from a plugin. The public plugin Host API exposes `host.getContext`, `host.openWorkbench`, file/asset helpers, downloads, and the plugin's own backend RPC — but no method and no permission related to execution plans.

A plugin that only wants to *analyze* plans (parsing, normalization, metrics, rule-based diagnosis, visualization, diff) therefore cannot obtain the raw plan without shipping its own database driver and credentials. That is exactly the duplication the plugin boundary is meant to prevent.

The scope requested by #9675 is deliberately narrow: **Estimated Plan only** — DBX Core generates and runs `EXPLAIN ...`, the plugin consumes the raw plan output. Actual Plan (`EXPLAIN ANALYZE`), `host.plans:execute`, and any generic SQL execution are explicitly out of scope for this phase (see Future Considerations).

## Current state (`t8y2/dbx` `main @ a924285`, 2026-09-20 — #9675 submission baseline)

- Frontend host method registry: `host.getContext`, `host.reopenConnection`, `ui.readAsset`, `host.copy`, `host.saveFile`, `host.downloadFile`, `host.cancelDownload`, `host.openWorkbench` (requires `host.workbench`), `host.openFilesystem` (requires `host.filesystem`), `backend.invoke | notify | sendBinary`.
- Declared manifest permissions: `host.events`, `host.binary`, `host.workbench`, `host.filesystem`, `host.network:<origin>`. None of them relate to query context or plans.
- `result-view` on `main` (after #9599) now delivers `sql`, `connectionId`, `database`, and a bounded `result` snapshot to the plugin UI. That covers query context for that one surface; this request does not ask to change it and does not depend on `host.getQueryContext()`.
- There is no method, permission, or event for EXPLAIN or raw plan acquisition. Runtime probing of 28 candidate method names (`host.explain`, `host.getExecutionPlan`, `host.getRawPlan`, `host.getQueryContext`, `query/cancel`, `host.timeout`, …) against DBX v0.6.16 returned `Unsupported plugin host method` for all of them.
- DBX Core internally has all of it: per-dialect `build_explain_sql`, PostgreSQL read-only `EXPLAIN (ANALYZE, …)` with `BEGIN READ ONLY` + `ROLLBACK`, `execute_query` / `cancel_query` with the timeout budget, and the built-in Plan Canvas (#5160) with internal plan normalization for six engines. The raw plan is simply not exposed to plugins. Internal actual-plan handling is listed here only as evidence of Core capabilities; it is **not** part of the requested contract (see Future Considerations).

## Requested minimal surface (matches #9675 phase 1)

### Permission

| Permission | Allows | Risk |
| --- | --- | --- |
| `host.plans:read` | Plan-related context + Estimated plan (`EXPLAIN ...`, `mode=estimated`) | Low: never executes the user's statement |

`host.plans:read` allows only reading plan-related context and requesting an Estimated Plan. It does **not** allow generic SQL execution, Actual Plan / `EXPLAIN ANALYZE`, writes, or DDL. The permission must be declared in the manifest and shown in Plugin Center, so store review can tell statically what a plugin may do.

### Host methods

- **`host.getPlanCapabilities({ connectionId })`** — returns `{ dbType, dbVersion?, supports: { estimatedPlan: true }, limits: { maxTimeoutMs, maxPlanBytes } }`, so plugins can degrade correctly on hosts or dialects that cannot produce a plan. Capability announcement should reuse the existing `host.features` / `hostApiVersion` mechanism so plugins can detect older hosts.
- **`host.explainPlan({ connectionId, database, schema?, sql, mode: "estimated", timeoutMs? })`** — `mode` is restricted to `"estimated"` in phase 1. DBX Core generates the EXPLAIN statement through the existing `build_explain_sql`, applies the existing safety validation, runs it, and returns the raw plan: `{ dbType, dbVersion, format: "json" | "text" | "xml", rawPlan, truncated, warnings }`.

The exact method names and payload shape follow #9675's API suggestion and are not mandated by the issue. The contract that matters:

```text
plugin sends original SQL + connection context
        ↓
DBX Core generates EXPLAIN (build_explain_sql)
        ↓
DBX Core performs safety validation and execution
        ↓
plugin receives only the raw plan
```

Explicitly **not** requested in phase 1: any generic SQL execution API, `mode=actual`, `host.plans:execute`, a `host.getQueryContext()` dependency, SQL rewrite, index creation, DDL, or auto-tuning. Design notes for those are kept in Future Considerations.

### Why `host.getQueryContext()` is not required

#9597 / #9599 (merged) fixed the `result-view` open path. On current `main`, a `result-view` plugin already receives `sql`, `connectionId`, `database`, and a bounded result snapshot through the contribution context. Query context for the plan surfaces this plugin uses is therefore already available downstream, and this note does **not** treat `host.getQueryContext()` as a phase-1 blocker.

The upstream capability that is still genuinely missing is:

```text
Estimated Raw Plan acquisition
```

If a future surface needs host-owned query context beyond `result-view`, that is a separate proposal (see Future Considerations), not a prerequisite for Estimated Plan acquisition.

## Security boundary

- Core remains the only side touching credentials, drivers, statement generation, execution, transactions, and cancellation. The plugin never holds `connectionId` credentials and never sends EXPLAIN SQL.
- Requests only accept `connectionId / database / schema / sql / mode / timeoutMs`; a plugin cannot provide custom EXPLAIN text.
- Reuse the existing safety validation (`is_safe_explain_sql_for_database`: `SELECT / WITH / TABLE / VALUES` only, dangerous keywords rejected, no multi-statement).
- Phase 1 is `EXPLAIN` only, so the user's statement is never actually executed; this is the key difference from #9396.
- `timeoutMs` is clamped by the host to the connection / global limit; timeout errors are distinguishable (e.g. `PLAN_TIMEOUT`).
- Response payload is limited to plan output and metadata: no credentials, no full result rows; `maxPlanBytes` caps the payload.
- Permissions are statically visible in the manifest, so store review can tell what a plugin may do; `host.plans:read` cannot execute SQL.

## Ownership split

| DBX Core owns | Plugin owns |
| --- | --- |
| connection, credentials, driver | plan parsing |
| EXPLAIN generation and safety validation | normalization |
| estimated EXPLAIN execution and transactions | metrics |
| timeout, cancel | rule diagnosis, visualization, plan diff |
| result size / permission enforcement | — |

## Why this belongs in Core

- Credentials and drivers only exist in Core; a plugin-side execution layer would duplicate them and weaken the boundary.
- Safety validation, timeout, and cancel are only real where the EXPLAIN actually runs — inside Core.
- Dialect differences (PG JSON, MySQL JSON/TRADITIONAL, SQL Server `STATISTICS XML`, Oracle / Dameng text) already have one implementation in Core.
- The plugin stays a plan consumer instead of becoming another database client.

## Related

- **#9396 (open)** asks for a broader capability — plugins executing their own SQL on a host connection. **#9675 is deliberately narrower**: Estimated Plan acquisition only, no arbitrary SQL execution, and it does **not** depend on #9396. Even if #9396 eventually adopts a different authorization model, the Estimated Plan API can stand independently.
- #5161 / #5160 (merged) added the built-in Plan Canvas and internal plan normalization. This request does not ask for another built-in view; it asks for raw plan access so external plugins can build analyses DBX does not ship.
- #9597 / #9599 (merged) fixed the `result-view` open path; on `main` a result-view already receives `sql` / `connectionId` / `database` / a bounded result snapshot. That covers query context for one surface, not plan acquisition — which is why `host.getQueryContext()` is not a phase-1 dependency.

## Future Considerations / 后续阶段

以下内容**不属于 DBX #9675 第一阶段 contract，是否推进取决于未来独立 upstream proposal，不作为当前插件实现依赖。** 保留在此仅为保存被收窄前的设计记录，避免信息丢失。

> 命名说明：本文件早期草稿使用 `host.getConnectionCapabilities` / `host.explainPlans` / `host.cancelPlanExecution` 与 `mode=actual`；第一阶段以 #9675 收窄后的 `host.getPlanCapabilities` / `host.explainPlan` / `mode=estimated` 为准，旧名称仅作历史参考。

### Actual Plan / `EXPLAIN ANALYZE` / `host.plans:execute`

- 第一阶段只做 Estimated Plan（`EXPLAIN ...`），不请求 Actual Plan / `EXPLAIN ANALYZE`。
- 若未来单独提案，可沿用早期设计：新增 `host.plans:execute` 权限（manifest 显式声明、默认不授予、Plugin Center 可见，生产连接需额外显式确认）、`mode=actual`、PostgreSQL 只读事务（`BEGIN READ ONLY` + `ROLLBACK`）；MySQL 当前没有 analyze 路径，应返回 `explainAnalyze: false` 而不是发明路径。
- Actual 会真正执行用户语句，风险显著高于 Estimated Plan，必须作为独立 proposal 重新评估授权模型与安全边界。

### `host.getQueryContext()`

- 本文件早期版本曾把它列为第一阶段方法。经 #9597 / #9599 验证，`result-view` 已经向插件投递 `sql` / `connectionId` / `database` / bounded result snapshot，因此它不再是计划获取的前置需求。
- 只有出现 `result-view` 之外、确实需要宿主托管查询上下文的新 surface 时，才值得作为独立 proposal 讨论。

### 显式 cancel 方法（早期 `host.cancelPlanExecution`）

- 第一阶段不需要专门的 cancel Host API：`timeoutMs` 由宿主 clamp，超时与取消由宿主在执行层内部完成，插件只消费最终结果与可区分错误。
- 若未来 Actual Plan 或长计划需要用户主动取消，再随该 proposal 设计以 `executionId` 为单位的幂等 cancel 方法。

### 明确不提案的方向

- generic SQL execution / 自动执行用户 SQL —— 属于 #9396 的讨论范围，不属于本计划 API。
- SQL Rewrite、CREATE INDEX、DDL、自动调优 —— 需要各自独立的上游 proposal 与产品决策。

## Evidence

- Canonical upstream issue (contract): <https://github.com/t8y2/dbx/issues/9675>
- 提交前重复性检查结论：`getQueryContext` / `explainPlans` / `host.plans` / `raw plan` / `explain + plugin` / GitHub Discussions 均未发现重复 Issue；相关但不重复的 Issue 见 Related 一节。
- Source audit plus runtime probing of DBX v0.6.16 (28 candidate methods, all `Unsupported plugin host method`): <https://github.com/0verme/dbx-plugin-plan-detective/blob/main/docs/HOST_CAPABILITY_AUDIT.md>

## 中文摘要（简短）

第一阶段只做 **Estimated Plan**：`EXPLAIN ...`。建议权限只有 `host.plans:read`；建议能力只有 `host.getPlanCapabilities` 与 `host.explainPlan`，且 `mode` 只允许 `estimated`。DBX Core 继续负责 connection、credential、driver、EXPLAIN SQL 生成、安全校验、timeout / cancel 与 Raw Plan 获取；插件只负责 parsing、normalization、metrics、rule diagnosis、visualization、plan diff。

不请求 Actual Plan / `EXPLAIN ANALYZE` / `host.plans:execute`，也不请求任意 SQL 执行。`host.getQueryContext()` 不是第一阶段前置需求：`result-view`（#9597 / #9599）已提供 `sql` / `connectionId` / `database` / bounded result snapshot，当前真正缺失的上游能力是 **Estimated Raw Plan acquisition**。

与 #9396 的边界：本提案刻意更窄，不依赖 #9396，也不请求开放任意 SQL execution API；即使 #9396 采用不同授权模型，Estimated Plan API 仍可独立成立。

> 本文如与 [t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675) 冲突，以 #9675 为准。
