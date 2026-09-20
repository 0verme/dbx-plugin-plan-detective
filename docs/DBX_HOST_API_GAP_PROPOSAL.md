# DBX Plugin Host API Gap Proposal

> 关联：[Phase 0 Host Capability Audit](HOST_CAPABILITY_AUDIT.md) · Issue [#1](https://github.com/0verme/dbx-plugin-plan-detective/issues/1)
>
> **状态（2026-09-20 复核）**
>
> - 本文件描述的上游 Host API 需求已正式提交为 **[t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)**（2026-09-20，OPEN，已由 `0verme` `/claim`），是**当前唯一 canonical upstream contract**。
> - 本文件是**下游侧能力缺口说明与设计记录**，不再是"待提交 Issue 草稿"；提交正文见 [`docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md`](upstream/PLUGIN_HOST_PLAN_API_ISSUE.md)，范围以 #9675 为准。
> - **当前一期范围 = Estimated Plan only**：`EXPLAIN ...`、权限 `host.plans:read`、方法 `host.getPlanCapabilities` / `host.explainPlan`、`mode=estimated`。
> - Actual Plan / `EXPLAIN ANALYZE` / `host.plans:execute` / `host.getQueryContext()` / generic SQL execution 属于 [Future / historical design](#future--historical-design不属于当前一期-contract)，**不属于当前一期 contract**，未来需要独立 upstream proposal。
> - 本文件与 #9675 当前 scope 冲突时，一律以 #9675 为准。
> - 相关但不重复的上游 Issue：[#9396](https://github.com/t8y2/dbx/issues/9396)（更宽的插件 SQL 执行诉求）、[#5161](https://github.com/t8y2/dbx/issues/5161) / [#5160](https://github.com/t8y2/dbx/pull/5160)（DBX 内置 Plan Canvas）。本文件不修改 `t8y2/dbx`。
>
> 附录 B 的 result-view 缺陷已由上游修复（[#9597](https://github.com/t8y2/dbx/issues/9597) → [PR #9599](https://github.com/t8y2/dbx/pull/9599)，已合入 `main`，尚未进入 release）。

## Problem

DBX Core 已经具备连接管理、SQL 执行、EXPLAIN（Estimated / Actual）、timeout 与 cancel 能力，但这些能力**没有通过公开的 Plugin Host API 暴露给第三方插件**。因此一个"只做执行计划智能、不重复实现数据库基础设施"的插件（Plan Detective）仍无法取得当前一期真正需要的东西：

```text
Estimated Raw Plan（原始计划文本或结构）    ← #9675 请求的唯一一期能力
```

一期**不再缺失、也不再作为前置条件**的周边能力：

```text
current SQL / connectionId / database   ← result-view 路径已提供（#9599 修复，等待 release）
timeout / cancel 语义                    ← 由宿主在执行层内部完成，插件只消费结果与可区分错误
```

Actual Plan（`EXPLAIN ANALYZE`）与任意 SQL execution **不属于一期范围**，见 Future / historical design。

审计证据见 [HOST_CAPABILITY_AUDIT.md](HOST_CAPABILITY_AUDIT.md)：14 项能力中插件侧可达项为 0；真实 DBX `v0.6.16` 宿主中 28 个候选方法名全部返回 `Unsupported plugin host method`。

## Current DBX capability

| 能力 | DBX 内部实现 |
| --- | --- |
| 连接 / Credential / Driver | `ConnectionConfig` + `dbx-drivers`（每数据库驱动池） |
| 查询执行 | Tauri `execute_query(connection_id, database, sql, schema, catalog, execution_id, timeout_secs, …)`（`src-tauri/src/commands/query.rs:35-51`） |
| EXPLAIN SQL 生成 | `build_explain_sql`（`crates/dbx-sql/src/query_execution_sql.rs:48-104`）：PG `EXPLAIN (FORMAT JSON)`、MySQL `EXPLAIN FORMAT=JSON/TRADITIONAL`、SQL Server `SHOWPLAN_XML`、Oracle `EXPLAIN PLAN FOR`、Dameng/Doris `EXPLAIN` |
| Actual Plan | PG `EXPLAIN (ANALYZE, FORMAT JSON)` + `BEGIN READ ONLY`/`ROLLBACK`；SQL Server `STATISTICS XML`；MySQL 无 |
| 安全校验 | `is_safe_explain_sql_for_database`（仅 SELECT/WITH/TABLE/VALUES、拒绝危险关键字，`:141-149`） |
| timeout | `timeout_secs` + `DbOperationBudget`（query / checkout / recycle / cleanup） |
| cancel | Tauri `cancel_query(execution_id)` + `dbx_core::query_cancel` 任务注册表 |
| 连接元信息 | `DatabaseConnectionInfo.product_version`、`db_type`、`default_schema` |

以上全部仅对 DBX 前端（Tauri command / 内部 Vue 状态）可用。

## Current public Plugin Host API

`window.dbxPlugin`（沙箱 iframe，`apps/desktop/src/lib/plugins/pluginHostBridge.ts:206-275`）：

```text
ready / context / locale / theme
onContext / onInit / onEvent / onBinary
request(method, params)            → 宿主方法注册表（下表）
invoke / notify / sendBinary       → 插件自己的 sidecar RPC
readAsset / readAssetUrl
openWorkbench / openFilesystem     → 需要 host.workbench / host.filesystem
saveFile / copy
```

宿主方法注册表**完整列表**（运行时逐一验证）：

```text
host.getContext          → 返回 workbench 上下文（connectionId / database / schema / values 等字段由宿主决定）
ui.readAsset
host.copy
host.saveFile
host.openWorkbench       → 需要 host.workbench
host.openFilesystem      → 需要 host.filesystem
backend.invoke / backend.notify / backend.sendBinary
```

manifest 权限（`plugins/manifest.schema.json` / `crates/dbx-plugin-runtime/src/plugins/manifest.rs:22`）：

```text
host.events, host.binary, host.workbench, host.filesystem, host.network:<https origin>
```

sidecar 可回调宿主的方法只有 `host/requestUserInput`（Host API 1.1，`runtime.rs:26`）；`plugin/initialize` 下发的 `host.features` 目前也只有这一项（`manifest.rs:16`）。

贡献类型（`plugins/manifest.schema.json`）：`connection-provider`、`workbench`、`filesystem-provider`、`context-menu`、`result-view`。其中只有 `result-view` 会把 `connectionId / database / sql / result` 交给插件工作台；该路径在 `v0.6.16` 与审计时的 `main` 上无法打开（见附录 B），在 #9599 合入后的 `main` 上已修复。

注意：`connection-provider` 是**插件向 DBX 提供驱动**的方向（插件自己实现连接），不是"插件消费 DBX 已管理的连接"。用它来访问用户的 PostgreSQL / MySQL 会迫使插件自带驱动、凭据与连接池，与 DBX 的职责边界重复。

## Capability gap（当前一期）

| 需求 | 插件侧状态 | 结论 |
| --- | --- | --- |
| Estimated Raw Plan 获取 | ❌ 未公开 | **#9675 请求的唯一一期能力**；DBX 内部可用（PG/MySQL 等），宿主方法注册表无入口 |
| 计划相关上下文（connectionId / database / sql） | ⚠️ `result-view` 路径提供 | 已由 #9597 / #9599 修复并合入上游 `main`（尚未进入 release）。**不是** #9675 前置条件；#9675 不请求 `host.getQueryContext()` |
| database type / version | ✅ 宿主可提供 | 由 `host.getPlanCapabilities` 随计划能力一起返回，插件不需要自行探测 |
| timeout / cancel | ✅ 宿主内部完成 | `timeoutMs` 由宿主 clamp；插件只消费结果与可区分错误，一期不需要独立 cancel API |
| Actual Plan / `EXPLAIN ANALYZE` | ⛔ 一期不请求 | 会真正执行用户语句，风险显著更高；属于 Future，需要独立 upstream proposal |
| 任意 SQL execution | ⛔ 一期不请求 | 属于 [#9396](https://github.com/t8y2/dbx/issues/9396) 的讨论范围，不属于本计划 API |

## Phase 1 minimal API proposal（canonical: #9675）

> 目标：只暴露 **Estimated Plan 获取**这一条窄路径，不把插件变成通用 SQL 执行通道。所有 EXPLAIN 生成、安全校验、执行、超时与取消仍由 DBX Core 完成。

### 1. 新权限

```text
host.plans:read          # 读取计划能力/上下文 + 请求 Estimated Plan（不会执行用户语句）
```

- 必须在 manifest 中显式声明，并在 Plugin Center 安装页展示给用户与审核者，使 Marketplace 审核可以基于 manifest 静态判断插件能做什么。
- `host.plans:read` **不**包含：Actual Plan / `EXPLAIN ANALYZE`、写语句、DDL、任意 SQL 执行。

### 2. 新宿主方法

```text
host.getPlanCapabilities({ connectionId })
host.explainPlan({ connectionId, database, schema?, sql, mode: "estimated", timeoutMs? })
```

#### `host.getPlanCapabilities({ connectionId })`

返回该连接的计划能力与宿主限制：

```json
{
  "connectionId": "…",
  "dbType": "postgres",
  "dbVersion": "15.19",
  "supports": { "estimatedPlan": true },
  "limits": { "maxTimeoutMs": 60000, "maxPlanBytes": 4194304 }
}
```

- 用于让插件在 UI 上正确降级，并复用现有 `host.features` / `hostApiVersion` 机制探测旧宿主。
- 一期只声明 `estimatedPlan`；`explainAnalyze` 等字段属于 Future（见 historical design）。

#### `host.explainPlan(...)`

请求示例：

```json
{
  "connectionId": "…",
  "database": "app",
  "schema": "public",
  "sql": "SELECT status, count(*) FROM orders GROUP BY status",
  "mode": "estimated",
  "timeoutMs": 15000
}
```

- `mode` 一期只允许 `"estimated"`。
- DBX Core 负责把 `sql` 交给现有 `build_explain_sql`，沿用现有安全校验；插件不能自定义 EXPLAIN 文本。
- `timeoutMs` 由宿主 clamp 到连接配置与全局上限，插件不能突破。
- 返回**原始**计划与元信息，由插件自行解析与归一化：

```json
{
  "executionId": "plan-7b1e…",
  "mode": "estimated",
  "dbType": "postgres",
  "dbVersion": "15.19",
  "format": "json",
  "rawPlan": [ { "Plan": { "Node Type": "Aggregate", "Plans": [ { "Node Type": "Seq Scan", "Relation Name": "orders" } ] } } ],
  "truncated": false,
  "warnings": []
}
```

失败示例：

```json
{
  "error": "PLAN_UNSAFE: statement is not a read-only SELECT/WITH/TABLE/VALUES query"
}
```

方法名与 payload 形状以 #9675 的 API suggestion 为准，不是 #9675 强制项；真正必须成立的契约是：

```text
插件发送原始 SQL + connection context
        ↓
DBX Core 生成 EXPLAIN（build_explain_sql）
        ↓
DBX Core 执行安全校验并运行 Estimated Plan
        ↓
插件只收到原始计划
```

### 3. Security boundary

- 插件 iframe 仍然是 `sandbox="allow-scripts"` + 严格 CSP：没有 Tauri 对象、没有父级 DOM、没有网络（除非声明 `host.network`）。新方法只是新增宿主侧的只读执行入口，不放松沙箱。
- 请求只接受 `connectionId / database / schema / sql / mode / timeoutMs`；插件**不能**自带 EXPLAIN SQL，也没有通用 SQL 执行入口。
- 复用现有安全校验：`is_safe_explain_sql_for_database`（仅 SELECT/WITH/TABLE/VALUES、拒绝危险关键字、拒绝多语句）。
- 一期只有 `EXPLAIN`，用户语句不会真正执行——这是与 [#9396](https://github.com/t8y2/dbx/issues/9396) 的关键区别。
- 结果大小上限、返回字段白名单：不返回凭据、不返回连接密码、不返回完整结果集，只返回计划与元信息；`maxPlanBytes` 控制 payload。
- timeout 错误必须可区分（例如 `PLAN_TIMEOUT`）。
- 审计：每次 plan 请求记录 connectionId、mode、sql 指纹、耗时、结果大小（不记录凭据）。

### 4. Permission model（一期）

| 权限 | 允许 | 不允许 |
| --- | --- | --- |
| `host.plans:read` | `host.getPlanCapabilities`、`host.explainPlan` 且 `mode=estimated` | `mode=actual`、写语句、DDL、多语句、任意 SQL 执行 |
| 未声明权限 | — | 所有 plan 方法返回 `Plugin has not declared permission '…'`（与现有权限错误一致） |

### 5. Timeout / cancel semantics（一期）

- `timeoutMs` 由插件提出、宿主裁定：`min(请求值, 连接 query_timeout, 全局上限)`；超时错误必须可区分。
- 一期不新增专门的 cancel API：超时与取消由宿主在执行层内部完成，插件只消费最终结果与可区分错误。
- 宿主负责在 sidecar 停用 / tab 关闭 / 连接断开时清理未完成的 plan 执行（沿用 `RunningTaskMetadata`）。

## Future / historical design（不属于当前一期 contract）

> 以下内容**不是** #9675 当前 scope，**不是**当前插件实现依赖。保留这些记录只为保存范围被收窄前的设计信息；任何一项要推进，都需要**独立的 upstream proposal**，并以该 proposal 的授权模型为准。

### Actual Plan / `EXPLAIN ANALYZE` / `host.plans:execute`（historical）

- 早期设计曾把 Estimated 与 Actual 并列提案：新增 `host.plans:execute` 权限（manifest 显式声明、默认不授予、Plugin Center 可见，生产连接需额外显式确认）、`mode=actual`。
- Actual 模式会真正执行用户语句：仅 `SELECT / WITH / TABLE / VALUES`；PostgreSQL 沿用 `BEGIN READ ONLY` + `ROLLBACK`，失败时保证回滚；SQL Server 走 `STATISTICS XML`；MySQL 当前没有 analyze 路径，应返回 `explainAnalyze: false` 而不是发明路径。
- 风险显著高于 Estimated Plan，因此 #9675 刻意不包含它。未来若推进，必须重新评估授权模型、只读事务、timeout / cancel 与生产连接确认策略。

### `host.getQueryContext()`（historical，已由 result-view 取代）

- 早期设计把它列为读取当前查询上下文的入口。
- #9597 / #9599（已合入 `main`）修复 result-view 打开路径后，`result-view` 已向插件投递 `sql` / `connectionId` / `database` / bounded result snapshot，因此它**不是**计划获取的前置需求，也**不是** #9675 的 blocker。
- 只有出现 `result-view` 之外、确实需要宿主托管查询上下文的新 surface 时，才值得作为独立 proposal 讨论。

### `host.cancelPlanExecution({ executionId })`（historical）

- 早期设计曾为一期准备独立的 cancel 方法；收窄后一期不需要：超时与取消由宿主执行层内部完成。
- 若未来 Actual Plan 或长计划需要用户主动取消，再随该 proposal 设计以 `executionId` 为单位的幂等 cancel 方法。

### 早期方法命名（historical）

- 本文件早期版本使用 `host.getConnectionCapabilities` / `host.explainPlans` / `host.cancelPlanExecution` 与 `mode=actual`。
- 当前一期以 #9675 收窄后的 `host.getPlanCapabilities` / `host.explainPlan` / `mode=estimated` 为准，旧名称仅作历史参考。

### `host.plan.progress` 事件（早期可选项，未提案）

```text
host.plan.progress   # { executionId, phase: "planning" | "executing" | "cancelling" }
```

- 早期文档建议 v1 先不做；当前一期不包含任何新增事件。

### 明确不提案的方向

- generic SQL execution / 自动执行用户 SQL —— 属于 #9396 的讨论范围，不属于本计划 API。
- SQL Rewrite、CREATE INDEX、DDL、自动调优 —— 需要各自独立的上游 proposal 与产品决策。

## Why this belongs in DBX Core instead of plugin

1. **凭据与驱动只在 Core**：插件无法在不引入 Driver / 连接池 / Credential 管理的前提下访问数据库；这是项目与 DBX 双方的安全边界。
2. **安全校验已经存在**：`build_explain_sql` 的语句类型白名单、危险关键字拒绝、只读事务与回滚逻辑都在 Core；插件侧重写会形成两套不一致的安全语义。
3. **timeout / cancel 必须与执行层同源**：只有实际执行查询的一侧才能真实取消；插件侧"超时"只能放弃等待，语句仍在数据库上继续跑。
4. **一致性**：Estimated（一期）与未来 Actual 的方言差异（PG JSON、MySQL JSON/TRADITIONAL、SQL Server STATISTICS XML、Oracle/Dameng 文本）由 Core 统一处理，插件只消费原始计划。
5. **可审核性**：新权限可以静态出现在 manifest 与 Marketplace 审核页，用户能判断插件会请求计划读取。
6. **职责划分**：DBX 提供数据库能力，插件提供计划智能；把执行层放进插件会破坏这个边界，并让"Plan Detective"退化为另一个数据库客户端。

---

## 附录 A：Historical — 早期上游 Issue 草稿（superseded by #9675，not current contract）

> **⚠️ 历史材料，不是当前提案。**
>
> - 状态：**historical / superseded by [t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675) / not current contract**。
> - 该草稿在 #9675 提交前使用更宽的范围（Estimated + Actual、`host.plans:execute`、`host.getQueryContext()`、`host.explainPlans`）。
> - **当前唯一 canonical contract 是 #9675，范围已收窄为 Estimated Plan only。** 请勿依据以下内容实现或判断当前一期范围。
> - 英文、收窄后的提交正文见 [`docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md`](upstream/PLUGIN_HOST_PLAN_API_ISSUE.md)。

<details>
<summary>展开早期中文草稿原文（historical）</summary>

> 建议标题：`[Feature] Plugin Host API: expose read-only execution plan access (host.plans:read / host.plans:execute)`
>
> 说明：以下是 #9675 提交前的草稿，**已由 #9675 取代**，保留仅为历史记录。

```markdown
### 背景

第三方插件目前在沙箱 iframe 中只能调用 `host.getContext` 等少量宿主方法，
无法读取当前查询上下文，也无法请求 DBX Core 执行 EXPLAIN。

审计记录（可在插件侧复现）：
- 宿主方法注册表（apps/desktop/src/lib/plugins/pluginHostBridge.ts）只有
  host.getContext / ui.readAsset / host.copy / host.saveFile / host.openWorkbench /
  host.openFilesystem / backend.*。
- 真实 DBX v0.6.16 宿主中逐项探测 28 个候选方法名（host.explain、host.executeQuery、
  host.getExecutionPlan、query/cancel、host.getDatabaseVersion …）全部返回
  "Unsupported plugin host method"。
- manifest 权限只有 host.events / host.binary / host.workbench / host.filesystem /
  host.network；sidecar 只有 host/requestUserInput。

DBX Core 内部已有完整能力：build_explain_sql（crates/dbx-sql）、execute_query /
cancel_query（src-tauri/src/commands/query.rs）、PG 的只读事务 EXPLAIN ANALYZE、
timeout 预算与取消注册表。

### 诉求

以"只读计划获取"为最小范围，公开一条插件可用的窄路径：

1. 新权限：host.plans:read（上下文 + Estimated）、host.plans:execute（Actual，默认关闭）
2. 新方法：
   - host.getQueryContext()
   - host.getConnectionCapabilities(connectionId?)
   - host.explainPlans({ connectionId, database, schema, sql, mode, timeoutMs? })
   - host.cancelPlanExecution({ executionId })
3. 语义要求：
   - Estimated 与 Actual 必须显式区分；Actual 会真正执行语句，需继承只读事务与语句类型白名单。
   - MySQL 当前没有 analyze 路径，能力探测需要如实返回 explainAnalyze: false。
   - timeoutMs 由宿主 clamp；cancel 以 executionId 为单位且幂等。
   - 插件不得自带 EXPLAIN SQL，不得绕过 build_explain_sql 的安全校验。

### 期望

插件可以做"执行计划解析 / 指标 / 规则诊断 / Plan Diff"，而连接、凭据、驱动、
执行、超时、取消仍全部留在 DBX Core。

### 附加上下文

本条与 result-view 的独立问题无关（见另一条 Issue：result-view 贡献的工作台查找失败）。
```

</details>

## 附录 B：附带发现的上游缺陷（result-view）

> 状态（2026-09-20）：**已修复**。已提交为 [t8y2/dbx#9597](https://github.com/t8y2/dbx/issues/9597)，并由 [PR #9599](https://github.com/t8y2/dbx/pull/9599) 修复、合入上游 `main`（`4f3be8cc`）；未进入 `v0.6.16` / `v0.6.17`，需等待后续 release。以下为原始发现记录。
>
> 建议标题：`[Bug] result-view contribution cannot open: workbench lookup only matches type "workbench"`

- 现象：插件声明 `result-view` 贡献后，在查询结果工具栏点击该按钮，DBX 显示
  `Plugin workbench '<pluginId>/<resultViewId>' is unavailable`。
- 源码：`apps/desktop/src/App.vue:4159-4166` 用 result-view 的 `contributionId` 渲染
  `PluginWorkbenchTab`，而 `PluginWorkbenchTab.vue` 通过
  `FrontendPluginRegistry.findWorkbench()`（`apps/desktop/src/lib/plugins/frontendPlugin.ts:44-46`）
  查找，该方法只匹配 `type === "workbench"`。
- 无法用"同时声明同名 workbench 贡献"绕过：manifest 校验会拒绝
  `Duplicate plugin contribution id`（真实宿主实测）。
- 影响：`plugins/README.md:382-395` 描述的 result-view 能力（向插件工作台传递
  `sql / connectionId / database / result`）在 `v0.6.16` 与审计时的 `main` 上不可用。
- 建议：`findWorkbench()` 或 result-view 打开流程接受 `result-view` 贡献，
  或让 result-view 显式声明其目标 workbench id。
- 该缺陷虽然影响 Plan Detective 的 Phase 0 运行时验证，但**不是**宿主能力缺口的
  替代方案：即使修复，result-view 也只提供结果集上下文，不提供执行计划。
