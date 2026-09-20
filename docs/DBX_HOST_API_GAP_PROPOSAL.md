# DBX Plugin Host API Gap Proposal

> 关联：[Phase 0 Host Capability Audit](HOST_CAPABILITY_AUDIT.md) · Issue [#1](https://github.com/0verme/dbx-plugin-plan-detective/issues/1)
> 状态（2026-09-20 复核）：**Host API 提案尚未向上游提交**；可直接提交的 Feature Issue 正文见 [`docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md`](upstream/PLUGIN_HOST_PLAN_API_ISSUE.md)。重复性检查未发现重复 Issue；相关但不重复：[#9396](https://github.com/t8y2/dbx/issues/9396)（更宽的插件 SQL 执行诉求）、[#5161](https://github.com/t8y2/dbx/issues/5161) / [#5160](https://github.com/t8y2/dbx/pull/5160)（DBX 内置 Plan Canvas）。附录 B 的 result-view 缺陷已由上游修复（[#9597](https://github.com/t8y2/dbx/issues/9597) → [PR #9599](https://github.com/t8y2/dbx/pull/9599)，已合入 `main`，尚未进入 release）。
> 本文件不修改 `t8y2/dbx`，仅作为反馈材料与上游 Issue 草稿的依据。

## Problem

DBX Core 已经具备连接管理、SQL 执行、EXPLAIN（Estimated / Actual）、timeout 与 cancel 能力，但这些能力**没有通过公开的 Plugin Host API 暴露给第三方插件**。因此一个"只做执行计划智能、不重复实现数据库基础设施"的插件（Plan Detective）无法取得：

```text
current SQL
connection / database / schema
database type / version
Estimated Plan（原始计划文本或结构）
Actual Plan（原始计划文本或结构）
timeout / cancel 语义
```

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

贡献类型（`plugins/manifest.schema.json`）：`connection-provider`、`workbench`、`filesystem-provider`、`context-menu`、`result-view`。其中只有 `result-view` 会把 `connectionId / database / sql / result` 交给插件工作台，而该路径在 `v0.6.16` 与当前 `main` 中无法打开（见附录 B）。

注意：`connection-provider` 是**插件向 DBX 提供驱动**的方向（插件自己实现连接），不是"插件消费 DBX 已管理的连接"。用它来访问用户的 PostgreSQL / MySQL 会迫使插件自带驱动、凭据与连接池，与 DBX 的职责边界重复。

## Missing capability

1. 读取当前查询上下文（connectionId、database、schema、SQL）。
2. 读取连接元信息（database type、database version、read-only / production 标记）。
3. 请求 DBX Core 对指定连接执行 EXPLAIN（Estimated）。
4. 请求 DBX Core 执行 EXPLAIN ANALYZE（Actual），并继承 DBX 的安全限制。
5. 取得**原始**执行计划（JSON / 文本），以便插件自行解析与归一化。
6. 复用 DBX 的查询 timeout 与 cancel。

## Minimal API proposal

> 目标：**只暴露"只读计划获取"这一条窄路径**，不把插件变成通用 SQL 执行通道。所有 SQL 生成、安全校验、事务包装、超时、取消仍由 DBX Core 完成。

### 1. 新权限

```text
host.plans:read          # 读取当前查询上下文 + Estimated Plan
host.plans:execute       # 额外允许 Actual Plan（会真正执行语句）
```

- 两个权限都必须在 manifest 中显式声明，并在 Plugin Center 安装页展示给用户与审核者。
- `host.plans:execute` 默认不授予；用户必须在插件设置中显式开启，且建议对"生产连接"单独二次确认。

### 2. 新宿主方法

```text
host.getQueryContext()                    # 读取当前编辑器/结果 tab 的上下文
host.getConnectionCapabilities(connectionId?)
host.explainPlans({ connectionId, database, schema, sql, mode, timeoutMs? })
host.cancelPlanExecution({ executionId })
```

#### `host.getQueryContext()`

返回当前活动查询标签页的上下文（由宿主决定，不从插件参数接收）：

```json
{
  "connectionId": "…",
  "database": "app",
  "schema": "public",
  "dbType": "postgres",
  "dbVersion": "15.19",
  "sql": "SELECT …",
  "readOnly": false,
  "isProduction": false,
  "supports": { "explain": true, "explainAnalyze": true }
}
```

#### `host.getConnectionCapabilities(connectionId?)`

```json
{
  "connectionId": "…",
  "dbType": "mysql",
  "dbVersion": "8.0.36",
  "supports": { "explain": true, "explainAnalyze": false },
  "limits": { "maxTimeoutMs": 60000, "maxPlanBytes": 4194304 }
}
```

用于让插件在 UI 上正确降级（例如 MySQL 不提供 Actual Plan）。

#### `host.explainPlans(...)`

```json
{
  "connectionId": "…",
  "database": "app",
  "schema": "public",
  "sql": "SELECT …",
  "mode": "estimated",
  "timeoutMs": 15000
}
```

- `mode`：`"estimated"` | `"actual"`。
- DBX 负责把 `sql` 交给 `build_explain_sql`，沿用现有安全校验；插件不能自定义 EXPLAIN 文本。
- `timeoutMs` 由宿主 clamp 到连接配置与全局上限，插件不能突破。

#### `host.cancelPlanExecution({ executionId })`

返回 `{ "cancelled": true }`；对已结束的执行幂等。

### 3. 结果事件（可选，建议 v1 先不做）

```text
host.plan.progress   # { executionId, phase: "planning" | "executing" | "cancelling" }
```

## Security boundary

- 插件 iframe 仍然是 `sandbox="allow-scripts"` + 严格 CSP：没有 Tauri 对象、没有父级 DOM、没有网络（除非声明 `host.network`）。新方法只是新增宿主侧的执行入口，不放松沙箱。
- 插件**不能**自带 SQL 执行路径：请求里只允许传 `connectionId / database / schema / sql / mode / timeoutMs`，EXPLAIN 语句由 DBX Core 生成。
- 复用现有安全校验：`is_safe_explain_sql_for_database`（仅 SELECT/WITH/TABLE/VALUES、拒绝危险关键字、拒绝多语句）。
- Actual 模式额外约束：仅 `SELECT / WITH / TABLE / VALUES`；PostgreSQL 沿用 `BEGIN READ ONLY` + `ROLLBACK`；失败时保证回滚（沿用现有 `postgres_read_only_transaction_*` 逻辑）。
- 结果大小上限、返回字段白名单（不返回凭据、不返回连接密码、不返回完整结果集，只返回计划）。
- 生产连接标记 `is_production` 时默认拒绝 `actual`，除非用户在该连接上显式允许。
- 审计：每次 plan 请求记录 connectionId、mode、sql 指纹、耗时、结果大小（不记录凭据）。

## Permission model

| 权限 | 允许 | 不允许 |
| --- | --- | --- |
| `host.plans:read` | `host.getQueryContext`、`host.getConnectionCapabilities`、`mode=estimated` | `mode=actual`、任意 SQL 执行 |
| `host.plans:execute` | 追加 `mode=actual`（受连接级与用户级开关限制） | 写语句、DDL、多语句、事务控制 |
| 未声明权限 | — | 所有 plan 方法返回 `Plugin has not declared permission '…'`（与现有权限错误一致） |

建议把权限写入 `plugins/manifest.schema.json` 的 `permissions` 枚举，使 Marketplace 审核可以基于 manifest 静态判断插件是否会执行 SQL。

## Estimated vs Actual semantics

- 两个模式必须在 API 上**显式区分**，不能用同一个方法"自动升级"。
- `estimated`：不执行语句；返回原生 `EXPLAIN` 输出。
- `actual`：会真正执行语句；返回带运行时统计的计划；由 DBX 决定是否允许、是否包只读事务、是否需要用户确认。
- 能力可用性由 `host.getConnectionCapabilities` 声明：
  - PostgreSQL：`explain = true`，`explainAnalyze = true`
  - SQL Server：`explain = true`，`explainAnalyze = true`（STATISTICS XML）
  - MySQL：`explain = true`，`explainAnalyze = false`（DBX 当前无此路径）
  - Oracle / Dameng / Doris / QuestDB：`explain = true`，`explainAnalyze = false`（文本计划）

## Timeout / Cancel semantics

- `timeoutMs` 由插件提出、宿主裁定：`min(请求值, 连接 query_timeout, 全局上限)`；超时错误必须可区分（例如 `PLAN_TIMEOUT`）。
- Cancel 以 `executionId` 为单位，与现有 `cancel_query` 任务注册表一致；取消结果对已结束任务幂等。
- 宿主负责在 sidecar 停用 / tab 关闭 / 连接断开时清理未完成的 plan 执行（沿用 `RunningTaskMetadata`）。
- Actual 模式下 timeout / cancel 必须保证"语句确实停止"的语义（PG 沿用只读事务 + 服务端取消）。

## Example request

```json
// iframe → host
{
  "source": "dbx-plugin",
  "version": 1,
  "type": "request",
  "id": "41",
  "method": "host.explainPlans",
  "params": {
    "connectionId": "8f0c…",
    "database": "app",
    "schema": "public",
    "sql": "SELECT status, count(*) FROM orders GROUP BY status",
    "mode": "estimated",
    "timeoutMs": 15000
  }
}
```

## Example response

```json
{
  "source": "dbx-host",
  "version": 1,
  "type": "response",
  "id": "41",
  "result": {
    "executionId": "plan-7b1e…",
    "mode": "estimated",
    "dbType": "postgres",
    "dbVersion": "15.19",
    "format": "json",
    "plan": [ { "Plan": { "Node Type": "Aggregate", "Plans": [ { "Node Type": "Seq Scan", "Relation Name": "orders" } ] } } ],
    "truncated": false,
    "executed": false,
    "warnings": []
  }
}
```

失败示例：

```json
{
  "source": "dbx-host",
  "version": 1,
  "type": "response",
  "id": "42",
  "error": "PLAN_UNSAFE: statement is not a read-only SELECT/WITH/TABLE/VALUES query"
}
```

## Why this belongs in DBX Core instead of plugin

1. **凭据与驱动只在 Core**：插件无法在不引入 Driver / 连接池 / Credential 管理的前提下访问数据库；这是项目与 DBX 双方的安全边界。
2. **安全校验已经存在**：`build_explain_sql` 的语句类型白名单、危险关键字拒绝、只读事务与回滚逻辑都在 Core；插件侧重写会形成两套不一致的安全语义。
3. **timeout / cancel 必须与执行层同源**：只有实际执行查询的一侧才能真实取消；插件侧"超时"只能放弃等待，语句仍在数据库上继续跑。
4. **一致性**：Estimated / Actual 的方言差异（PG JSON、MySQL JSON/TRADITIONAL、SQL Server STATISTICS XML、Oracle/Dameng 文本）由 Core 统一处理，插件只消费原始计划。
5. **可审核性**：新权限可以静态出现在 manifest 与 Marketplace 审核页，用户能判断插件是否会执行 SQL。
6. **职责划分**：DBX 提供数据库能力，插件提供计划智能；把执行层放进插件会破坏这个边界，并让"Plan Detective"退化为另一个数据库客户端。

---

## 附录 A：上游 Issue 草稿（可提交到 `t8y2/dbx/issues`）

> 更新（2026-09-20）：下方中文草稿已整理为英文优先、范围收窄、可直接提交的版本：[`docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md`](upstream/PLUGIN_HOST_PLAN_API_ISSUE.md)。提交时以该文件为准。
> 重复性检查结论：无重复 Issue；#9396 是更宽的“插件执行任意 SQL”诉求，与本提案的只读计划获取不重复，提交时应在正文中交叉引用。
>
> 建议标题：`[Feature] Plugin Host API: expose read-only execution plan access (host.plans:read / host.plans:execute)`
>
> 说明：以下是草稿，**尚未提交**。提交前请确认不与既有 Issue 重复。

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
  `sql / connectionId / database / result`）在 `v0.6.16` 与当前 `main` 上不可用。
- 建议：`findWorkbench()` 或 result-view 打开流程接受 `result-view` 贡献，
  或让 result-view 显式声明其目标 workbench id。
- 该缺陷虽然影响 Plan Detective 的 Phase 0 运行时验证，但**不是**宿主能力缺口的
  替代方案：即使修复，result-view 也只提供结果集上下文，不提供执行计划。
