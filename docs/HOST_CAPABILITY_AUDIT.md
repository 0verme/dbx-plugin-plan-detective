# DBX Host Capability Audit（Phase 0）

| 项 | 值 |
| --- | --- |
| 阶段 | Phase 0 · Host Capability Audit |
| 关联 Issue | [#1 Phase 0: Audit DBX Host capabilities for execution plan access](https://github.com/0verme/dbx-plugin-plan-detective/issues/1) |
| 审计对象（上游） | `t8y2/dbx` `main` @ `f0342ad3d9e3b5c7392552835f6de62d0ae9ab8c`（2026-09-18） |
| 审计对象（运行时） | DBX `v0.6.16` browser-static（`DBX_0.6.16_x64-browser-static.tar.gz`，sha256 `730940e5…77f2`） |
| 审计对象（插件） | `io.github.0verme.plan-detective` 0.1.0，`universal`，`dbx-plugin` CLI 0.1.9 |
| 结论 | **BLOCKED — Host API capability gap**（见 [DBX_HOST_API_GAP_PROPOSAL.md](DBX_HOST_API_GAP_PROPOSAL.md)） |

> 本轮只做能力审计、证据收集与最小 Audit Harness。**未实现任何 Plan Detective 业务能力**：没有 Plan Parser、Normalized Plan、Metrics、Rule Engine、SQL Rewrite、AI、数据库 Driver、sidecar、连接池或 Credential 管理。

## 1. 状态定义

| 状态 | 含义 |
| --- | --- |
| `SUPPORTED` | 第三方插件可通过**公开、正式、受支持的 Plugin Host API** 取得该能力 |
| `INTERNAL_ONLY` | DBX Core / 前端内部确实存在该能力，但 **Plugin Host 没有公开调用入口** |
| `NOT_AVAILABLE` | 该能力在 DBX 内部与 Plugin Host 都不存在 |
| `UNKNOWN` | 证据不足，不能下结论 |

核心区分：

```text
DBX internal capability  ≠  Plugin Host public capability
```

## 2. 审计方法

1. **源码 / 文档审计**：对 `t8y2/dbx` 完整调用链取证，而不是只读 README。
   - 前端沙箱桥：`apps/desktop/src/lib/plugins/pluginHostBridge.ts`
   - 插件运行时 / Host API 版本 / manifest 权限：`crates/dbx-plugin-runtime/src/plugins/{manifest,runtime,host}.rs`
   - manifest schema：`plugins/manifest.schema.json`
   - DBX 内部 Explain / 查询 / Cancel / Timeout：`crates/dbx-sql`、`crates/dbx-core/src/query`、`crates/dbx-drivers`、`src-tauri/src/commands`
   - 公开文档：`plugins/README.md`、`docs/content/docs/plugin-development.mdx`、`plugins/sdk/dev-host/README.md`
2. **真实 DBX 宿主实测**：运行官方 DBX `v0.6.16` browser-static 宿主，安装本插件作为 unsigned 开发包，在沙箱 iframe 内读取 `window.dbxPlugin`、`dbxPlugin.context`、`dbxPlugin.request("host.getContext")`，并逐项探测候选 Host 方法名。
   - `dbx-plugin dev` 独立开发主机**不算**真实宿主（其 README 明确说明不模拟 native connection actions 与 query-result contributions），本轮仅用于本地 UI 调试，未用于结论。
3. **最小 Audit Harness**：`src/App.svelte` 是明确标注为 `DEVELOPMENT / AUDIT ONLY` 的诊断页，只打印桥接面、init 消息、上下文与探测结果，不做任何计划分析，也不自行连接数据库。

## 3. Host Capability Matrix

「Public Plugin API」列描述公开插件 API 的**可达性**；「DBX Internal」列描述 DBX Core / 前端内部是否存在；「Runtime Verified」列表示是否在真实 DBX `v0.6.16` 宿主中实测。

| Capability | Public Plugin API | DBX Internal | Runtime Verified | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| connectionId | No（workbench 上下文为空；唯一设计路径 result-view 当前不可用） | Yes | Yes（否定） | `INTERNAL_ONLY` | §4.1 |
| 当前 database | No（同上） | Yes | Yes（否定） | `INTERNAL_ONLY` | §4.2 |
| 当前 schema | No（无任何 host 生产者） | Yes | Yes（否定） | `INTERNAL_ONLY` | §4.3 |
| 当前 SQL | No（result-view 上下文设计上包含 `sql`，当前版本不可达） | Yes | Yes（否定） | `INTERNAL_ONLY` | §4.4 |
| database type | No（仅插件自有连接 / context-menu backend 请求） | Yes | Yes（否定） | `INTERNAL_ONLY` | §4.5 |
| database version | No | Yes | Yes（否定） | `INTERNAL_ONLY` | §4.6 |
| 插件请求 DBX Core 执行 EXPLAIN | No | Yes | Yes（否定） | `INTERNAL_ONLY` | §4.7 |
| Raw Execution Plan | No | Yes | Yes（否定） | `INTERNAL_ONLY` | §4.8 |
| Estimated Plan | No | Yes | Yes（否定，内部可用） | `INTERNAL_ONLY` | §4.9 |
| Actual Plan | No | Yes（PostgreSQL / SQL Server；MySQL 无） | Yes（否定，内部可用） | `INTERNAL_ONLY`（PG）/ `NOT_AVAILABLE`（MySQL） | §4.10 |
| timeout（复用 DBX Core） | No（`invoke` 的 `timeoutMs` 只作用于插件 sidecar RPC） | Yes | Yes（否定） | `INTERNAL_ONLY` | §4.11 |
| cancel（复用 DBX Core） | No | Yes | Yes（否定） | `INTERNAL_ONLY` | §4.12 |
| PostgreSQL 当前可用能力 | 计划获取不可达 | Yes（Estimated + Actual） | Yes（内部解释计划实测可见） | `INTERNAL_ONLY` | §4.13 |
| MySQL 当前可用能力 | 计划获取不可达 | Estimated 有；Actual 无 analyze 路径 | 否（本机无 MySQL，仅源码取证） | `INTERNAL_ONLY`（Estimated）/ `NOT_AVAILABLE`（Actual） | §4.14 |

**结论：14 项中，插件侧可达项为 0。** 全部关键能力均落在 DBX 内部，Plugin Host 未公开。

## 4. 逐项证据

### 4.1 connectionId

- **Status**：`INTERNAL_ONLY`
- **Public Plugin API**：
  - 公开桥接方法注册表（`PluginHostBridge.dispatch`，`pluginHostBridge.ts:206-275`）只包含：
    `host.getContext`、`backend.invoke`、`backend.notify`、`backend.sendBinary`、`ui.readAsset`、`host.openWorkbench`、`host.reopenConnection`、`host.openFilesystem`、`host.saveFile`、`host.copy`。
  - 其中唯一可能携带连接信息的是 `host.getContext`，其返回值就是 workbench 的 `context` 快照（`pluginHostBridge.ts:207`）。
- **上下文生产者**（即调用 `openPluginWorkbench` 的位置）只有三类：
  1. Plugin Center 打开 workbench（`PluginContributionsPanel.vue:477-491`）：`context` 只包含 `connectionId / providerId / connectionType`，且 `selectedConnection` **仅来自该插件的自有连接**（`providerConnections` 过滤 `db_type === "plugin" && plugin_id === 当前插件`，同文件 `:118-128`）。本插件没有 `connection-provider` 贡献，因此上下文为 `undefined`。
  2. result-view 打开 workbench（`ContentArea.vue:1059-1076`）。
  3. 插件自有连接打开 workbench（`queryStore.ts:3583-3600`）。
- **Runtime**（DBX `v0.6.16`，本插件 installed，从 Plugin Center → Installed → Open 打开 workbench）：

  ```text
  dbxPlugin.context            → {}
  request("host.getContext")   → {}
  init message                 → {"type":"init","pluginId":"io.github.0verme.plan-detective",
                                  "contributionId":"…workbench","locale":"en","permissions":[],"context":{}}
  window.dbxPlugin keys        → context, copy, decodeBase64, encodeBase64, invoke, locale, notify,
                                 onBinary, onContext, onEvent, onInit, openFilesystem, openWorkbench,
                                 readAsset, readAssetUrl, ready, request, saveFile, sendBinary, stream, theme
  ```

- **结论**：对 DBX 原生连接的 `connectionId`，当前发布版本没有任何插件可达路径。DBX 内部知道连接（`execute_query(connection_id, …)`，`src-tauri/src/commands/query.rs:35-51`），但对插件不可见。

### 4.2 当前 database

- **Status**：`INTERNAL_ONLY`
- DBX 内部：查询标签页持有 `tab.database`，并作为 `execute_query` 参数下发（`src-tauri/src/commands/query.rs:38`）。
- 插件侧：result-view 路径设计上会传 `database`（`ContentArea.vue:1067-1073`），但该路径当前不可用（见 §4.4 / §6）。
- Runtime：`host.getContext` → `{}`，无 `database` 字段。

### 4.3 当前 schema

- **Status**：`INTERNAL_ONLY`
- DBX 内部：`execute_query` 接收 `schema: Option<String>`（`query.rs:40`），前端标签页持有 `tab.schema`。
- 插件侧：`PluginWorkbenchContext` 类型里声明了可选 `schema?: string`（`pluginHostBridge.ts:19-25`），但**整个仓库中没有任何生产者写入 `schema`**（对 `apps/desktop/src` 全量检索 `schema` 与 `PluginWorkbenchContext` 的交集：只有类型声明；`updateContext` 仅由 workbench 上下文变更触发）。
- Runtime：`host.getContext` → `{}`。

### 4.4 当前 SQL

- **Status**：`INTERNAL_ONLY`（result-view 设计路径存在，但当前版本不可达）
- **设计路径（源码）**：`ContentArea.vue:1059-1076`

  ```ts
  queryStore.openPluginWorkbench(pluginId, contributionId, {
    connectionId: props.activeTab.connectionId || "",
    database: props.activeTab.database || "",
    context: {
      connectionId: props.activeTab.connectionId || "",
      database: props.activeTab.database || "",
      sql: props.activeTab.sql,
      result: { columns: result.columns, rows: cappedRows, truncated: … },   // rows ≤ 500
    },
  });
  ```

- **该路径在真实宿主中不可用**（§6.1）：点击 result-view 按钮后 DBX 报

  ```text
  Plugin workbench 'io.github.0verme.plan-detective/io.github.0verme.plan-detective.audit-result-view' is unavailable
  ```

  原因：result-view 标签页仍按 workbench 贡献查找（`App.vue:4159-4166` → `PluginWorkbenchTab.vue` → `FrontendPluginRegistry.findWorkbench()`，`frontendPlugin.ts:44-46` 只匹配 `type === "workbench"`）。同一 id 再声明一个 workbench 贡献会被 manifest 校验拒绝（`Duplicate plugin contribution id`）。
- **公开文档**：`plugins/README.md:382-395` 描述 result-view 会把 `{ columns, rows (<= 500), truncated }` 与 `sql`、`connectionId`、`database` 作为 `context.result` 传入 workbench。
- Runtime：`host.getContext` → `{}`（普通 workbench）；result-view 路径无法进入（见上）。

### 4.5 database type

- **Status**：`INTERNAL_ONLY`
- DBX 内部：`ConnectionConfig.db_type`（`crates/dbx-types/src/models/connection.rs:97+`），并驱动 Explain/方言分支。
- 插件侧：
  - 自有连接（`connection-provider`）路径会传 `connectionType`（`queryStore.ts:3589`）——那是插件自己定义的连接类型，不是 DBX 原生连接；本插件没有该贡献。
  - `context-menu`（`menu: "connection"`）点击后由 DBX 向**插件 backend** 派发 `contextMenu/<id>`，参数含 `{ id, dbType, name, database }`（`plugins/README.md:396-409`）。它需要 Rust/Go sidecar，且只在用户点击菜单时触发，不是查询上下文。
- Runtime：`host.getContext` → `{}`。

### 4.6 database version

- **Status**：`INTERNAL_ONLY`
- DBX 内部存在获取路径，但都是"执行 SQL / 驱动探测"：
  - PostgreSQL：`SELECT current_setting('max_connections') …, current_setting('server_version') AS version`（`apps/desktop/src/lib/database/postgresServerStatus.ts:94`）；`SHOW server_version_num`（`crates/dbx-drivers/src/db/postgres.rs:11197`）。
  - MySQL：`SELECT VERSION()`、`SELECT @@version_comment` …（`crates/dbx-drivers/src/db/mysql.rs:317-330`，写入 `DatabaseConnectionInfo.product_version`）。
  - MongoDB 有专用命令 `mongo_server_version`（`src-tauri/src/commands/mongo_cmd.rs:252`）——那是 Tauri 命令，不对插件开放。
- 插件侧：无任何暴露。Runtime：`host.getContext` → `{}`；`host.getDatabaseVersion` / `host.getServerVersion` 探测结果为 `Unsupported plugin host method`。

### 4.7 插件请求 DBX Core 执行 EXPLAIN

- **Status**：`INTERNAL_ONLY`
- **DBX 内部实现**：
  - `build_explain_sql`（`crates/dbx-sql/src/query_execution_sql.rs:48-104`）为不同数据库生成 EXPLAIN SQL；
  - 通过 Tauri 命令 `build_explain_sql` 暴露给前端（`src-tauri/src/lib.rs:1990`）；
  - 前端以 `api.executeQuery(connectionId, database, explainSql, schema, executionId, { timeoutSecs })` 执行（`queryStore.ts` explain 流程）；
  - DM / Oracle 走 `get_explain_info`（`src-tauri/src/commands/query.rs:936`，`lib.rs:1991`）。
- **Plugin Host**：`PluginHostBridge.dispatch` 中没有 SQL 执行或 EXPLAIN 方法（完整方法表见 §4.1）；候选方法名逐一探测全部返回 `Unsupported plugin host method`：

  ```text
  host.executeQuery, host.executeSql, host.query, query/execute, sql/execute,
  host.explain, sql/explain, explain,
  host.getExecutionPlan, host.getQueryPlan, host.getPlan, host.getRawPlan,
  host.getQueryContext, host.getCurrentSql, host.getConnection(s),
  host.getDatabases, host.getSchema, host.getDatabaseVersion, host.getServerVersion,
  connection/list, connection/get, schema/list, database/list,
  host.cancelQuery, query/cancel, host.timeout
  → 28/28 UNSUPPORTED
  ```

- 插件 iframe 也无法绕过：沙箱 `sandbox="allow-scripts"`、CSP `default-src 'none'; connect-src 'none'`（未声明 `host.network` 时）、无 Tauri 对象、无父级 DOM 访问（`pluginHostBridge.ts:pluginSandboxDocument`，`plugins/README.md:329-341`）。

### 4.8 Raw Execution Plan

- **Status**：`INTERNAL_ONLY`
- DBX 内部：Estimated/Actual 计划以 `EXPLAIN … FORMAT JSON`（PG/MySQL）或文本（DM/Oracle）形式作为**普通查询结果**返回，并在 `ExplainPlanViewer` 中解析渲染（`apps/desktop/src/lib/diagram/explainPlan.ts`，`parseExplainResult` 等）。
- 插件侧：无。Runtime 探测：`host.getRawPlan` → `Unsupported plugin host method`。

### 4.9 Estimated Plan

- **Status**：`INTERNAL_ONLY`
- DBX 内部生成规则（`crates/dbx-sql/src/query_execution_sql.rs:73-97`）：

  ```text
  PostgreSQL → EXPLAIN (FORMAT JSON) <sql>
  MySQL      → EXPLAIN FORMAT=JSON <sql>  /  EXPLAIN FORMAT=TRADITIONAL <sql>
  Dameng/QuestDB/Doris → EXPLAIN <sql>
  Oracle     → EXPLAIN PLAN FOR <sql>
  SQL Server → SET SHOWPLAN_XML ON; GO <sql> GO SET SHOWPLAN_XML OFF;
  ```

  并有 `is_safe_explain_sql_for_database` 安全校验（`:141-149`，拒绝非 SELECT/WITH/TABLE/VALUES 与危险关键字）。
- **Runtime（内部能力已确认）**：在真实 DBX `v0.6.16` 中对审计库执行 `EXPLAIN`（编辑器 `Mod+E`），界面出现 `Explain Plan` 面板（`POSTGRES · 2 nodes`、`Canvas / Tree / Summary / JSON`），计划内容包含 `Aggregate`、`Seq Scan` 节点。
- 插件侧：无。Runtime 探测：`host.explain` / `sql/explain` / `host.getExecutionPlan` → `Unsupported plugin host method`。

### 4.10 Actual Plan

- **Status**：`INTERNAL_ONLY`（PostgreSQL）/ `NOT_AVAILABLE`（MySQL）
- DBX 内部：
  - PostgreSQL：`analyze` 为真时生成 `EXPLAIN (ANALYZE, FORMAT JSON) <sql>`，并对写语句做额外拒绝（`query_execution_sql.rs:64-77`）；驱动侧有只读事务包装 `BEGIN READ ONLY` 与 `ROLLBACK`（`crates/dbx-drivers/src/db/postgres.rs:7694-7778`，注释 `PostgreSQL explain_analyze.rollback`）。
  - SQL Server：`STATISTICS XML`（会执行语句）。
  - **MySQL 没有 analyze 分支**：`build_explain_sql` 只生成 `EXPLAIN FORMAT=JSON/TRADITIONAL`，即 DBX 当前不提供 MySQL 的真实执行计划路径。
- **安全语义**：Actual 会真正执行语句；DBX 已有限制（PG：仅 SELECT/WITH/TABLE/VALUES + 只读事务 + 回滚；DM autotrace 有额外危险语句检查，`queryStore.ts` explain 流程）。
- 插件侧：无（`analyze` 参数既不可传也没有入口）。

### 4.11 timeout

- **Status**：`INTERNAL_ONLY`
- DBX 内部：`execute_query` 接收 `timeout_secs: Option<u64>`（`query.rs:49`），执行预算 `DbOperationBudget`（query/checkout/recycle/cleanup）用于驱动层超时；连接级还有 `query_timeout_secs` 配置。
- 插件侧：
  - 前端桥接的 `request(method, params, options)` 中的 `timeoutMs` 只作用于 `backend.invoke`（插件自己的 sidecar RPC），被截断到 `1..120000` ms（`pluginHostBridge.ts:635-638`），与数据库查询超时无关。
  - sidecar 协议侧 `PLUGIN_REQUEST_TIMEOUT = 30s` 是 host→插件调用超时（`crates/dbx-plugin-runtime/src/plugins/runtime.rs:22`）。
- Runtime 探测：`host.timeout` → `Unsupported plugin host method`。

### 4.12 cancel

- **Status**：`INTERNAL_ONLY`
- DBX 内部：Tauri 命令 `cancel_query(execution_id)`（`src-tauri/src/commands/query.rs:288`，`lib.rs:1974`），由 `dbx_core::query_cancel` 的任务注册表驱动；执行查询时通过 `execution_id` 关联取消令牌（`query.rs:52-60`）。
- 插件侧：无。Runtime 探测：`host.cancelQuery` / `query/cancel` → `Unsupported plugin host method`。
- 连带结论：插件既不能发起查询，也就没有可取消的对象。

### 4.13 PostgreSQL 当前可用能力

| 能力 | DBX 内部 | 插件可达 | 证据 |
| --- | --- | --- | --- |
| Connection / Credential / Driver | Yes | 仅插件自有连接 | `ConnectionConfig`、驱动池 |
| Query Context（connectionId/database/schema） | Yes | No | §4.1–4.3 |
| Estimated Plan（`EXPLAIN (FORMAT JSON)`） | Yes | No | §4.9 |
| Actual Plan（`EXPLAIN (ANALYZE, FORMAT JSON)` + 只读事务） | Yes | No | §4.10 |
| timeout / cancel | Yes | No | §4.11–4.12 |
| Database version | Yes（`server_version`） | No | §4.6 |

Runtime：真实 DBX `v0.6.16` 对审计库的 `EXPLAIN` 面板可用（内部能力成立），但插件侧不可达。

### 4.14 MySQL 当前可用能力

| 能力 | DBX 内部 | 插件可达 | 证据 |
| --- | --- | --- | --- |
| Estimated Plan（`EXPLAIN FORMAT=JSON` / `TRADITIONAL`） | Yes | No | `query_execution_sql.rs:89-96` |
| Actual Plan | **No**（无 analyze 分支） | No | `query_execution_sql.rs:64-97` |
| Database version | Yes（`SELECT VERSION()`） | No | `crates/dbx-drivers/src/db/mysql.rs:317-330` |
| timeout / cancel | Yes | No | §4.11–4.12 |

MySQL 的 `EXPLAIN FORMAT=JSON` 兼容性回退（`EXPLAIN FORMAT=TRADITIONAL`）在前端 explain 流程中已有处理，属于 DBX 内部行为。
本机审计环境只有 PostgreSQL 15.19，**未对 MySQL 做运行时验证**，MySQL 结论全部来自源码，标记为源码级证据。

## 5. Estimated / Actual 路径分述

### Estimated Plan 路径

```text
插件（公开 API）: 不存在入口
        ↓（不可达）
DBX Host: build_explain_sql(EXPLAIN (FORMAT JSON)) → execute_query → 结果行 → ExplainPlanViewer
```

- 插件侧可行性：**不可行**（Host method registry 无 EXPLAIN/查询方法；沙箱无网络与 Tauri）。
- DBX 内部可行性：**可行**（源码 + 真实宿主实测）。

### Actual Plan 路径

```text
插件（公开 API）: 不存在入口
        ↓（不可达）
DBX Host: build_explain_sql(analyze=true) → EXPLAIN (ANALYZE, …) → 只读事务 + ROLLBACK → 结果行
```

- 插件侧可行性：**不可行**。
- DBX 内部可行性：PostgreSQL / SQL Server 可行；MySQL 不可行（无 analyze 路径）。
- 额外语义（插件侧完全无法控制）：是否真正执行语句、statement type 限制（仅 SELECT/WITH/TABLE/VALUES）、只读事务与回滚、timeout、cancel。

**结论**：不能因为"DBX 内部 Estimated 可用"就推断"插件 Estimated 可用"，更不能把 Estimated 与 Actual 混为一谈——两者在插件侧当前都不可达。

## 6. 运行时实测记录（真实 DBX 宿主）

环境：Debian 12 容器，Node.js 22.23.2，DBX `v0.6.16` browser-static（`http://127.0.0.1:4224`，`DBX_DISABLE_PASSWORD=1`），PostgreSQL 15.19（本地审计库，含 20,000 行 `orders` 表；凭据不入库、不写入文档）。

原始运行时证据（已脱敏、去掉主题令牌体）：[`docs/evidence/phase0-host-capability-audit-runtime.json`](evidence/phase0-host-capability-audit-runtime.json)。其中包含宿主标识、插件包 sha256、init 消息、桥接面、上下文与 36 项方法探测结果。

### 6.1 安装与打开

| 步骤 | 命令 / 操作 | 结果 |
| --- | --- | --- |
| 打包 | `dbx-plugin package .`（CLI 0.1.9） | `io.github.0verme.plan-detective-0.1.0-universal.dbxp`（unsigned review candidate） |
| 安装 | `POST /api/plugins/install?allow_unsigned=true` | `compatibility.compatible = true`，`target: linux-x64`，`packageSha256 = a4bf7c00920dfdbfa2d84139c7d92d858db298803ad1adc783fbe505f92d54eb` |
| 可复现性 | 在本仓库 worktree 重新执行 `npm run build` + `dbx-plugin package .` | 产物 sha256 与已安装包**完全一致**（`a4bf7c00…`），且重新安装通过真实 manifest 校验 |
| 产物一致性 | 比对宿主侧 `/api/plugins/<id>/ui*` 与仓库 `ui/` | `ui/index.html`、`ui/assets/index-qgttd-mp.js`、`ui/assets/index-CxyQQWSk.css` 哈希逐一相同；`/api/plugins` 返回的 manifest 与仓库 `manifest.json` 一致（忽略宿主回传时去除的 `$schema`） |
| 打开 workbench | Plugin Center → Installed → Open | 成功，`window.dbxPlugin` 就绪 |
| 打开 result-view | 查询结果工具栏 → `Plan Detective Audit (dev)` | 失败：`Plugin workbench '…audit-result-view' is unavailable`（见 §6.2） |

### 6.2 result-view 缺陷（上游）

```text
Plugin workbench 'io.github.0verme.plan-detective/io.github.0verme.plan-detective.audit-result-view' is unavailable
```

- 触发方式：执行 SQL 成功后点击结果工具栏中的插件 result-view 按钮（判据 `props.hasResult`，按钮确实渲染）。
- 源码对应：`App.vue:4159-4166` 把 `tab.pluginWorkbench.contributionId`（= result-view id）传给 `PluginWorkbenchTab`，后者用 `findWorkbench()` 查找，而 `findWorkbench()` 只匹配 `type === "workbench"`（`frontendPlugin.ts:44-46`）。
- 结论：`result-view` 贡献类型在 DBX `v0.6.16` 与当前 `main` 源码中**无法打开**；而它是目前唯一会把 `sql / connectionId / database / result` 交给插件的工作台路径。
- 影响：Phase 0 无法在真实宿主中取得"当前 SQL 进入插件上下文"的正向运行时证据（设计路径由源码证据支持）。
- 建议：作为独立的上游缺陷反馈（见 Gap Proposal 附录 B），与 Host API 能力缺口分开处理。

### 6.3 方法探测（36 项）

| 类别 | 方法 | 运行时结果 |
| --- | --- | --- |
| 已注册（参数/权限校验通过即证明注册） | `host.getContext` | `RESOLVED → {}` |
| | `ui.readAsset`(非法路径) | `REJECTED: Plugin asset path is invalid` |
| | `host.copy`(缺参数) | `REJECTED: host.copy requires text` |
| | `host.saveFile`(缺参数) | `REJECTED: host.saveFile requires transferred binary data or dataBase64` |
| | `host.openWorkbench` | `REJECTED: Plugin has not declared permission 'host.workbench'` |
| | `host.openFilesystem` | `REJECTED: Plugin has not declared permission 'host.filesystem'` |
| | `backend.invoke` / `backend.notify` | `REJECTED: Plugin '…' does not provide a backend entrypoint` |
| 未注册（能力候选） | 28 个 SQL / 计划 / 连接 / 上下文 / cancel / timeout 方法名 | `UNSUPPORTED: Unsupported plugin host method '<method>'` |
| 版本差异 | `host.reopenConnection` | `UNSUPPORTED`（当前 `main` 有该 bridge 方法，`v0.6.16` 发布构建没有） |

### 6.4 init 消息（前端插件）

```json
{
  "source": "dbx-host",
  "version": 1,
  "type": "init",
  "pluginId": "io.github.0verme.plan-detective",
  "contributionId": "io.github.0verme.plan-detective.workbench",
  "locale": "en",
  "permissions": [],
  "context": {},
  "theme": { "appearance": "light", "tokens": { "...": "DBX 设计令牌" } }
}
```

- 前端插件的 init 消息**不包含** `hostApiVersion` 与 `host.features`；这两个字段只出现在 sidecar 的 `plugin/initialize` 中（`crates/dbx-plugin-runtime/src/plugins/runtime.rs:355-375`）。
- 这解释了官方 `svelte` 模板只展示 `host.getContext` 的按钮，而没有 Host API 版本探测入口。

### 6.5 DBX 内部 Explain 实测

- 同一查询（`SELECT status, count(*) … FROM orders GROUP BY status HAVING count(*) > 1;`）在编辑器内按 `Mod+E` 后，界面显示解释计划面板：`POSTGRES · 2 nodes` + `Aggregate` / `Seq Scan` 节点（计划文本中可见 `Aggregate`、`Seq Scan`）。
- 意义：DBX 内部执行计划能力**真实存在并可用**；插件不可达是 **Host API 缺口**，不是数据库能力缺失。

## 7. UNKNOWN / 未验证项

| 项 | 原因 |
| --- | --- |
| MySQL 运行时能力 | 审计环境没有 MySQL 实例；结论仅来自源码。 |
| DBX 桌面版（Tauri）与 browser-static 的差异 | 本轮只在 browser-static 上实测；前端桥接与插件运行时来自同一 `apps/desktop` + `dbx-plugin-runtime`，未验证桌面专属路径（如原生保存对话框）。 |
| `dbx-plugin dev` 宿主与真实宿主的差异 | dev host 明确不模拟 native connection actions 与 query-result contributions（`plugins/sdk/dev-host/README.md:71`），因此不作为结论来源。 |
| 上游后续版本是否会公开查询/计划能力 | 只能确认 `main @ f0342ad3` 与 `v0.6.16` 现状；未来版本需重新审计。 |
| 插件自有连接（`connection-provider`）路径下可获得的上下文细节 | 需要 Rust/Go sidecar 与自有驱动，本项目明确禁止；未验证。 |

## 8. 复现步骤（审计者）

```bash
# 1. 上游源码审计
git clone --depth 1 https://github.com/t8y2/dbx.git
# 关键文件：apps/desktop/src/lib/plugins/pluginHostBridge.ts
#           crates/dbx-plugin-runtime/src/plugins/{manifest,runtime}.rs
#           crates/dbx-sql/src/query_execution_sql.rs

# 2. 构建本插件（含 Audit Harness）
cd <worktree>
npm install && npm run build
dbx-plugin package .

# 3. 启动真实 DBX 宿主（browser-static）
#    https://github.com/t8y2/dbx/releases/download/v0.6.16/DBX_0.6.16_x64-browser-static.tar.gz
cd dbx-linux-x64-browser-static && DBX_DISABLE_PASSWORD=1 DBX_PORT=4224 ./dbx

# 4. 安装插件（unsigned 开发包）
curl -X POST -F "file=@dist/io.github.0verme.plan-detective-0.1.0-universal.dbxp" \
  "http://127.0.0.1:4224/api/plugins/install?allow_unsigned=true"

# 5. 在 UI 中打开 Plugin Center → Installed → Open，
#    在插件页点击 "Run capability audit"，读取 [data-audit-report] 结果。
```

## 9. 结论

1. DBX Core 内部**具备**执行计划相关能力：查询执行、EXPLAIN（Estimated）、PostgreSQL Actual Plan（只读事务 + 回滚）、超时、取消。
2. 公开的 Plugin Host API **没有**任何查询执行、EXPLAIN、计划读取、连接上下文读取入口；插件沙箱也无法绕过。
3. 唯一设计上会向插件工作台投递 `connectionId / database / sql / result` 的路径（`result-view`）在 `v0.6.16` 中无法打开。
4. 因此 Phase 0 的结论是 **BLOCKED — Host API capability gap**；后续动作见 [DBX_HOST_API_GAP_PROPOSAL.md](DBX_HOST_API_GAP_PROPOSAL.md)。
5. 按项目纪律：**不实现插件侧数据库执行层、不引入 Driver、不绕过沙箱**；等上游公开能力后再进入 Phase 1。
