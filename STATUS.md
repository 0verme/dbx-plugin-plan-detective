# 状态

| 项 | 值 |
| --- | --- |
| 最后更新 | 2026-09-20 |
| 当前阶段 | **Phase 1 · Host Plan API MVP 闭环（已实现，Issue [#11](https://github.com/0verme/dbx-plugin-plan-detective/issues/11)）+ Phase 1.1 · MySQL Estimated Plan 结构化（已实现，Issue [#15](https://github.com/0verme/dbx-plugin-plan-detective/issues/15)）+ Phase 2 · Hotspot Analysis（已实现，Issue [#19](https://github.com/0verme/dbx-plugin-plan-detective/issues/19)）**；上游 [t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675) / 实现 PR [t8y2/dbx#9692](https://github.com/t8y2/dbx/pull/9692) 已合并进 `t8y2/dbx/main`（merge `f909f85`） |
| 插件版本 | 0.4.0（`engines.host_api: ^1.2`，权限 `host.plans:read`） |
| 阶段结论 | Host 接入不再 blocked：真实 Estimated Plan 闭环已打通（PostgreSQL / MySQL structured；SQL Server / Oracle / OceanBase Oracle / Doris / Dameng / QuestDB raw-only）。Actual Plan / Plan Diff / AI / SQL Rewrite 仍是 Future |
| 当前不做 | 不建立数据库连接、不读取 credential、不执行用户 SQL、不请求 Actual Plan、不接 AI |

## 0. 当前状态

### 0.1 Host Plan API 核验（2026-09-20，直接读取 `t8y2/dbx/main`）

- 上游 PR [t8y2/dbx#9692](https://github.com/t8y2/dbx/pull/9692) 已 **MERGED**（merge commit `f909f85075e12beb78dffe5942f7d039bede25de`，2026-09-20T09:15:53Z）。
- 正式契约（与仓库实现逐项对齐）：
  - `window.dbxPlugin.getPlanCapabilities(connectionId)` → `{ dbType, dbVersion?, supports: { estimatedPlan }, limits: { maxTimeoutMs, maxPlanBytes } }`
  - `window.dbxPlugin.explainPlan({ connectionId, database?, schema?, sql, mode, timeoutMs? })` → `{ dbType, dbVersion?, format: "json"|"xml"|"text", rawPlan, truncated, warnings }`
  - 权限 `host.plans:read`；`engines.host_api` 下限 `^1.2`（`SUPPORTED_PLUGIN_HOST_API_VERSION = "1.2.0"`）
  - `mode` 必须显式为 `"estimated"`；其他值被宿主拒绝（`plugin_plan.rs` / `pluginHostBridge.ts`）
  - 连接必须已打开：`getPlanCapabilities` 与 `explainPlan` 对 saved-but-disconnected 连接都返回 `Connection is not open`；宿主不会为插件建立连接
  - 插件不能传 EXPLAIN 语句、不能执行 SQL、不能请求 Actual Plan；EXPLAIN 由宿主构造并受只读安全门约束
  - 插件拿不到 credential / connection string / driver internals
  - 返回计划原样保留；`truncated` / `warnings`（`plan_not_json` / `plan_truncated` / `plan_rows_truncated`）由宿主给出
- 宿主支持 estimated plan 的方言（`supports_explain_plan`）：PostgreSQL、MySQL、SQL Server、Oracle、OceanBase Oracle、Doris、Dameng、QuestDB；format 分别为 json / json / xml / text / json / text / text / text。
- 查询结果页入口（`result-view`）会向插件上下文传入 `connectionId` / `database` / `sql` / result 快照；standalone workbench 不传连接上下文。

### 0.2 本轮交付（Issue #11）

```text
DBX connection → getPlanCapabilities → explainPlan(mode: "estimated")
→ RawPlanInput → parser registry → NormalizedPlan → Metrics → Rules → Findings → UI
```

- `src/host/**`：Host adapter（结构校验、稳定错误码、UI 侧 timeout guard），唯一接触 `window.dbxPlugin` 的模块。
- `src/core/adapter/dbx-plan-response.js`：8 个 dbType → Plan Core family；json / text / xml；截断 fail-closed。
- `src/core/parsers/**`：parser registry；PostgreSQL structured，其余 7 个方言 raw-only（`PARSER_NOT_IMPLEMENTED`）。
- `src/lib/analysis-session.js`：Host → Parser → IR → Rules 编排，状态为 `idle / loading / structured / raw-only / truncated / unsupported / error`。
- `src/lib/host-view-model.js` + 组件：ConnectionContext / SqlInput / AnalysisNotice / RawPlanViewer；复用 PlanSummary / PlanTree / NodeInspector / FindingsList。
- `manifest.json`：`engines.host_api: ^1.2`、`permissions: ["host.plans:read"]`、版本 0.2.0。
- Fixture / mock 退出生产路径，只服务测试与离线开发。

### 0.2.1 运行时 capability gate hardening（Issue #13，2026-09-20）

- `src/host/dbx-plan-host.js`：`describePlanApi` 新增 `initializing / available / unavailable` 三态，`available` 必须同时满足 `capabilities.planApi === true` 且 `getPlanCapabilities` / `explainPlan` 都是 function；`planApi` false 或缺失时 fail closed（0 次 Host 调用），不再以 method presence 代替 capability。
- init 时序：DBX SDK 在 init message 之前就已注入 `window.dbxPlugin`（`capabilities` getter 仍为 `{}`），此时状态为 `initializing`；`App.svelte` 在 `onMount` 监听 `bridge.ready` / `onInit`，init 后按 `{ initialized: true }` 重估。
- 开发入口收敛：Fixtures（开发）与宿主审计（开发）仅在 `import.meta.env.DEV` 下渲染；生产构建的 bundle 不再包含这两个视图（`HostAudit` 组件与文案整体被 tree-shake）。

### 0.2.2 MySQL Estimated Plan 结构化（Issue #15，2026-09-20）

```text
DBX Host（dbType: "mysql" / format: "json" / EXPLAIN FORMAT=JSON）
→ RawPlanInput → parseMySqlJsonPlan → normalizeMySqlPlan → NormalizedPlan
→ Metrics → 现有 Rules → Plan Tree / Node Inspector / Findings
```

- 契约来源：`t8y2/dbx/main` `crates/dbx-sql/src/query_execution_sql.rs`（MySQL 默认生成 `EXPLAIN FORMAT=JSON`；
  `estimated_plan_format(Mysql) == Json`）、`crates/dbx-core/src/query/plugin_plan.rs`（Host 固定
  `ExplainFormat::Json`、从不设置 `analyze`）、`apps/desktop/src/lib/diagram/explainPlan.ts`（DBX 自身的
  MySQL JSON 消费者）。
- 新增：`src/core/mysql/parse-json-plan.js`、`src/core/normalize/normalize-mysql.js`、
  `src/core/parsers/mysql.js`；registry 变为 `postgresql + json` / `mysql + json` structured；
  `STRUCTURED_DATABASES = ["postgresql", "mysql"]`。
- 支持结构：`query_block`、`table`（全部常见 `access_type`）、`nested_loop`（折叠为左深二叉链）、
  `ordering_operation`、`grouping_operation`、`duplicates_removal`、`union_result` / `unary_result` /
  `intersect_result` / `except_result`、`materialized_from_subquery`、`*_subqueries`。
- IR 映射：`rows_examined_per_scan` → `estimatedRows`（表）；`rows_produced_per_join` → join 节点
  `estimatedRows` + `engineSpecific.mysql`；`attached_condition` → `filter`；`key` → `relation.indexName`。
- **MySQL cost 不映射到 `startupCost` / `totalCost`**（`cost_info` 全部保留在 `engineSpecific.mysql`），
  避免 PostgreSQL 绝对代价阈值误触发；`large-sequential-scan` 按行数适用且不伪造 `incremental cost of 0`，
  `nested-loop-large-inner` 适用，`expensive-sort` 在 MySQL 上不触发。
- Fixture：`fixtures/mysql/` 11 个 `estimated` synthetic（本机无 MySQL 实例；形状对照 MySQL Server 8.0
  `mysql-test/r/explain_json_all.result` 与 DBX 自身 consumer，provenance 见
  [fixtures/mysql/README.md](fixtures/mysql/README.md)）；MySQL 无 `actual/`。
- 测试：`tests/mysql/**`（parser / normalize / fixture+golden / end-to-end / UI view-model）+ registry /
  fixture-convention / host-analysis / rules 适配；`npm test` 502/502，`npm run build` 通过。

### 0.2.3 Hotspot Analysis（Issue #19，2026-09-20）

```text
NormalizedPlan + Metrics → computeHotspots → HotspotAnalysis { cost, items }
→ Hotspots 面板（Plan Summary → Hotspots → Findings → Plan Tree → Raw Plan）
```

- 定位：Hotspot = “这棵计划里优先看哪里”（注意力列表），Finding = “命中了哪条已知模式”；两者可命中同一节点但互不派生。
- 契约：`Hotspot { id, nodeId, nodeType, kind, relation, level, reasons[{code, level, statement, source, evidence}], evidence, estimateOnly }`；
  确定性排序 `level → reason 数量降序 → plan pre-order`；raw-only 方言 `hotspots = null`。
- 无综合评分、无跨数据库比较：PostgreSQL 用 PostgreSQL cost units，MySQL 用 MySQL cost units。
- PostgreSQL 代价归因边界（`src/core/hotspots/self-cost.js`）：计划缺总代价 / 节点缺代价 / 含
  `InitPlan` / `SubPlan` / 未知 Parent Relationship → `cost.status = "withheld"`；`Limit` 截断产生负自代价时
  仅停用该节点及其子树的占比信号（祖先仍可归因）。不修改既有 `incrementalCostOf`（Findings 行为不变）。
- MySQL 只使用自身语义：`rows_examined_per_scan` / `filtered` / `using_filesort` / `using_temporary_table` /
  `using_join_buffer`，以及同一 query block 内 ≥ 2 个有代价访问的 `(read_cost + eval_cost) / query_cost`
  （MySQL cost units，不做子节点相减）。
- 新增真实采集 fixture `estimated/subplan-initplan`（18 个 locally-generated + 2 个 synthetic）：
  InitPlan 计划代价信号 withheld，两个 200 000 行 Seq Scan 仍为行数 hotspot。
- golden 增加 `hotspots` stage（五 stage）；新增 `expect.hotspotNodeRefs` 可选断言。
- 测试：`tests/core/hotspots.test.js`、`tests/postgres/hotspot-fixtures.test.js`、
  `tests/mysql/hotspot-fixtures.test.js` + UI view-model；`npm test` 586/586。

### 0.3 Phase 0 审计结论（历史，2026-09-18）

完整矩阵、逐项证据、真实 DBX 运行实测记录：[docs/HOST_CAPABILITY_AUDIT.md](docs/HOST_CAPABILITY_AUDIT.md)。上游能力缺口与一期 API 提案：[docs/DBX_HOST_API_GAP_PROPOSAL.md](docs/DBX_HOST_API_GAP_PROPOSAL.md)。

当时的结论是 **BLOCKED — DBX internal capability exists, Plugin Host API does not expose it**；该缺口已由 #9675 / #9692 关闭。下表为 2026-09-18 审计快照（历史事实），其中「当前 SQL / result-view」一项已由上游 #9599 修复：

| 能力 | 当时插件侧可达 | 状态 | 说明 |
| --- | --- | --- | --- |
| connectionId / database | ❌ | `INTERNAL_ONLY` | `host.getContext` 实测返回 `{}`；只有插件自有连接与 result-view 路径会带连接信息 |
| schema | ❌ | `INTERNAL_ONLY` | bridge 类型有 `schema?` 字段，但仓库内无任何生产者 |
| 当前 SQL | ❌ | `INTERNAL_ONLY` | result-view 设计上会传 `sql`，当时该路径无法打开 |
| database type / version | ❌ | `INTERNAL_ONLY` | DBX 内部通过驱动探测或 SQL 获取 |
| 请求 DBX 执行 EXPLAIN | ❌ | `INTERNAL_ONLY` | 宿主方法注册表中无此方法 |
| Raw Plan / Estimated Plan | ❌ | `INTERNAL_ONLY` | DBX 内部可用（PG/MySQL 等） |
| Actual Plan | ❌ | `INTERNAL_ONLY`（PG/SQL Server）/ `NOT_AVAILABLE`（MySQL） | 不属于当前一期 |
| timeout / cancel | ❌ | `INTERNAL_ONLY` | 插件侧只有 sidecar RPC 超时（≤ 120s），与查询超时无关 |

## 1. 完成度速览

| 能力 | 状态 |
| --- | --- |
| 官方 Svelte + Vite 项目骨架 | ✅ 已初始化 |
| UI 构建（`npm run build`） | ✅ 通过（本轮复跑） |
| 打包（`dbx-plugin package`） | ✅ 通过（历史验证；本轮未复跑打包） |
| `dbx-plugin dev` 本地开发主机 | ⚠️ 可用，但 Windows 需绕过上游 bug（见第 4 节） |
| `manifest.json` 合法性 | ✅ 通过（`host_api ^1.2` / `host.plans:read`，对上游 schema） |
| Host Capability Audit（Phase 0） | ✅ 已完成（历史结论 BLOCKED，见 §0.3） |
| Audit Harness（开发/审计页） | ✅ 保留为 UI 内“宿主审计（开发）”视图，并加入真实 Plan API 方法探测 |
| **Host Plan API 接入（生产路径）** | ✅ 已实现（`src/host/**`；capabilities 门控 + `mode: "estimated"`） |
| **Estimated Plan 获取 → 解析闭环** | ✅ 已实现（PostgreSQL / MySQL structured；其余方言 raw-only） |
| **Host 分析 UI** | ✅ Connection Context / SQL Input / Plan Summary / Hotspots / Findings / Plan Tree / Node Inspector / Raw Plan |
| Offline Plan Core（fixture-first） | ✅ 已实现（`src/core/**`） |
| Fixture-driven 开发 UI | ✅ 保留为开发模式（不进入生产路径） |
| DBX Estimated Plan Response Adapter | ✅ 已实现并接入（Issue #9 / PR #10；本轮扩展到 8 方言 + 3 format） |
| native backend（Rust / Go） | ❌ 不存在（符合 Thin Plugin 原则） |
| 数据库驱动依赖 | ❌ 不存在（符合禁止清单） |
| AI / LLM 依赖 | ❌ 不存在 |
| Execution Plan Parsing | ✅ PostgreSQL / MySQL structured；其余 6 方言 raw-only（不伪造 parser） |
| Plan Normalization | ✅ 已实现（PostgreSQL / MySQL；公共字段 + `engineSpecific`） |
| Metrics Engine | ✅ 已实现（确定性基础指标，不含综合评分） |
| Hotspot Analysis | ✅ 已实现（确定性、engine-aware 注意力列表；PostgreSQL 代价归因边界 + MySQL rows / cost_info 信号；无综合评分） |
| Rule-based Diagnosis | ✅ 已实现（3 条确定性规则：large-sequential-scan / expensive-sort / nested-loop-large-inner） |
| Findings + Evidence | ✅ 已实现（`info` / `warning` / `high`） |
| Raw Plan viewer | ✅ 已实现（默认折叠，仅展示层截断，payload 不改写） |
| Plan Diff | ⛔ 未实现 |

> ⛔ 表示需要独立 Issue，**不是**待办遗留。
> Offline Core 的契约、阈值与 fixture 约定见 [docs/PLAN_INPUT_AND_FIXTURES.md](docs/PLAN_INPUT_AND_FIXTURES.md)；
> 启动条件、一期 / Future 边界见 [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) §2.1 与 §3。

### 1.1 Host 数据链路与边界（2026-09-20）

```text
DBX context（result-view: connectionId / database / sql）
   ↓
planApi gate：capabilities.planApi === true 且两方法存在；false / 缺失 → fail closed（0 调用）
   ↓
getPlanCapabilities(connectionId)          # supports.estimatedPlan === true 才继续
   ↓
explainPlan({ connectionId, sql, mode: "estimated" })   # mode 由 adapter 固定
   ↓
src/host/dbx-plan-host.js（结构校验 + 稳定错误码 + timeout guard）
   ↓
src/core/adapter/dbx-plan-response.js → RawPlanInput
   ↓
src/core/parsers/** → Normalize → Metrics → Rules / Hotspots → Findings
   ↓
src/lib/analysis-session.js → UI
```

- **边界确认**：不建立数据库连接；不读取 credential / connection string；不执行用户 SQL；
  不传 EXPLAIN 语句；不请求 Actual / ANALYZE；不引入数据库 Driver。
- 错误状态：`PLAN_API_UNAVAILABLE` / `PERMISSION_NOT_DECLARED` / `CONNECTION_NOT_OPEN` /
  `CONNECTION_NOT_FOUND` / `UNSUPPORTED_DIALECT` / `EMPTY_SQL` / `SQL_TOO_LARGE` / `UNSAFE_SQL` /
  `PLAN_TOO_LARGE` / `EMPTY_PLAN` / `TIMEOUT` / `INVALID_REQUEST` / `INVALID_RESPONSE` /
  `UNSUPPORTED_DB_TYPE` / `UNSUPPORTED_PLAN_FORMAT` / `PLAN_TRUNCATED` / `HOST_ERROR`，
  每项有独立 UI 文案（`src/lib/host-view-model.js`），不使用通用 `Analysis failed`。
- 连接未打开时展示宿主返回的 `Connection is not open`，不尝试自动连接。
- fixture / mock 只用于测试、离线 UI 开发与 golden sample；Host 模式不依赖任何 production mock。

### 1.2 数据库支持矩阵（如实）

| 数据库 | 宿主 format | 本插件 |
| --- | --- | --- |
| PostgreSQL | json | structured（`EXPLAIN (FORMAT JSON)`） |
| MySQL | json | structured（`EXPLAIN FORMAT=JSON`；Estimated only） |
| SQL Server | xml | raw only |
| Oracle | text | raw only |
| OceanBase Oracle | json | raw only |
| Doris | text | raw only |
| Dameng | text | raw only |
| QuestDB | text | raw only |

## 2. 初始化的实测验证记录（历史）

环境：Windows，Node.js v24.15.0，npm 11.12.1，`@dbx-app/plugin-cli@0.1.9`。

| # | 验证项 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 安装依赖 | `npm install` | ✅ `added 37 packages`，`found 0 vulnerabilities` |
| 2 | UI 构建 | `npm run build` | ✅ `vite v7.3.6`，109 modules transformed，`built in 1.52s`，输出 `DBX_UI_BUILD_SUCCESS` |
| 3 | 打包 | `dbx-plugin package <project-abs-path>` | ✅ `dist/io.github.0verme.plan-detective-0.1.0-universal.dbxp`（14,351 bytes）+ `.artifact.json`（190 bytes），`unsigned review candidate` |
| 4 | 本地开发主机 | `dbx-plugin dev --path <project> --port 5193` | ⚠️ 移除 `[dev] ui_build`/`ui_watch` 后：`Plugin dev host: http://127.0.0.1:5193`，`GET / → HTTP 200`（172,406 bytes）。保留官方配置时在 Windows 失败（见 4.4） |
| 5 | manifest 合法性 | `ajv-cli validate --spec=draft2020 -s manifest.schema.json -d manifest.json` | ✅ `manifest.json valid`（schema 取自上游 `main` 分支） |
| 6 | 无 native backend | 查找 `Cargo.toml` / `go.mod` / `*.rs` / `*.go` | ✅ 无匹配 |
| 7 | 无数据库驱动 | 审计 `package.json` 与 `node_modules` 顶层 | ✅ 仅 `svelte`、`vite`、`@sveltejs/vite-plugin-svelte` 及其传递依赖 |

`ui/` 是**需要入库的构建产物**：上游 release workflow 不执行 `npm install` / `npm run build`，直接运行 `dbx-plugin package .`。实测在缺少 `ui/` 时打包报错：

```text
error: manifest UI entry 'ui/index.html' does not exist at ...\ui\index.html
```

因此不要将 `ui/` 加入 `.gitignore`。已在 `.pi-lens.json` 中把 `ui/**`、`dist/**` 排除出静态扫描，避免对压缩产物误报。该规则已同步到 [AGENTS.md](AGENTS.md) 的 Git 规则与 [README.md](README.md) 的开发说明。

## 3. 历史 Host API 审计（2026-09-18，已由 #9692 关闭）

取证时间 2026-09-18，来源 `t8y2/dbx` 的 `main` 分支公开文档与源码，并在真实 DBX `v0.6.16` 宿主中现场验证（详见 [docs/HOST_CAPABILITY_AUDIT.md](docs/HOST_CAPABILITY_AUDIT.md)）：

- 当时前端沙箱公开桥接方法为 `ready` / `context` / `locale` / `theme` / `request` / `invoke` / `notify` / `onInit` / `onContext` / `onEvent` / `onBinary` / `sendBinary` / `readAsset` / `readAssetUrl` / `openWorkbench` / `openFilesystem` / `saveFile` / `copy` / `stream`。
- 当时宿主方法注册表只有 `host.getContext`、`ui.readAsset`、`host.copy`、`host.saveFile`、`host.openWorkbench`、`host.openFilesystem`、`host.reopenConnection`、`backend.invoke` / `notify` / `sendBinary`；28 个候选计划方法名全部返回 `Unsupported plugin host method`。
- 结论：当时公开 Host API 没有 SQL 执行 / EXPLAIN / 执行计划获取入口；缺口提交为 [t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)，由 [t8y2/dbx#9692](https://github.com/t8y2/dbx/pull/9692) 实现并合并。
- 当前 `main` 上新增：`host.getPlanCapabilities`、`host.explainPlan`、权限 `host.plans:read`、Host API 1.2。

## 4. 已知上游问题（已取证，未修复）

以下问题属于 `@dbx-app/plugin-cli` / 官方模板 / 上游仓库现状，**未擅自修改**，等待决策。

### 4.1 `create` 不接受 `.` 相对路径（Windows 实测）

```text
$ dbx-plugin create . --template svelte ...
error: Project directory needs a UTF-8 name
```

- 实测：传绝对路径 `dbx-plugin create E:\...\<project> ...` 成功；传 `.` 必失败。
- 影响：官方文档给出的 `dbx-plugin create my-plugin` 类用法在 Windows 上不可用。
- 本次初始化绕过方式：使用绝对路径。

### 4.2 `manifest.json` 的 `$schema` 指向不存在的 ref

```text
https://raw.githubusercontent.com/t8y2/dbx/plugin-sdk-v1/plugins/manifest.schema.json
```

- 实测该 URL 返回 **404**；`plugin-sdk-v1` 在 `t8y2/dbx` 中既不是分支也不是 tag。
- `https://raw.githubusercontent.com/t8y2/dbx/main/plugins/manifest.schema.json` 返回 200。
- 影响：编辑器/校验器无法解析 manifest schema。未擅自改为 `main`。

### 4.3 发布 workflow 引用了不存在的 ref（v0.3.0 发布准备已修正）

`.github/workflows/plugin-release.yml`（官方模板 0.1.9 原样生成）：

```yaml
uses: t8y2/dbx/.github/workflows/plugin-release-reusable.yml@plugin-sdk-v1
```

- 实测 `plugin-sdk-v1` 在 `t8y2/dbx` 中既不是分支也不是 tag（见 4.2），发 release 时该 workflow 会因 ref 无法解析而直接失败。
- v0.3.0 发布准备按上游当前模板（`plugins/sdk/cli/templates/frontend/github/plugin-release.yml`，`CLI_VERSION = 0.1.9`）改为 `@plugin-cli-v0.1.9`，并把 `plugin-cli-version` 对齐为 `0.1.9`（原模板硬编码的是 `0.1.6`）。
- 该 tag 真实存在；其 reusable workflow 与 `main` / `v0.6.17` 上的版本只差 toolchain 安装守卫与 npm cache 步骤，`publish` job（校验 `.artifact.json`、拒绝 `signature.json`、上传 `release-candidates.json`）一致。

### 4.4 `dbx-plugin dev` 在 Windows 上无法执行 UI build 命令

配置 `[dev] ui_build = ["npm", "run", "build"]` 时：

```text
CMD.EXE was started with the above path as the current directory.
UNC paths are not supported.  Defaulting to Windows directory.
Error: EISDIR: illegal operation on a directory, lstat 'E:'
Build failed (exit 1)
```

- 根因：dev runtime 把 canonicalize 得到的 verbatim 路径 `\\?\E:\...` 作为子进程 cwd 传给 `cmd.exe`，而 cmd 不支持 UNC 路径。
- 实测绕过：移除 `[dev]` 的 `ui_build` / `ui_watch` 后，dev host 正常启动并服务已构建的 `ui/`。
- 现状：仓库保留官方模板默认配置（在 Linux / macOS 上正常），Windows 下需手动临时移除该段，或改用 WSL。

### 4.5 template README 的相对链接在独立仓库中失效

官方模板 README 使用 `../../../../GETTING_STARTED.zh-CN.md` 指向 DBX 主仓内文件，在独立插件仓库中为坏链接。本仓库 README 已改写为上游公开地址。

### 4.6 模板硬编码的 CLI 版本（v0.3.0 发布准备已对齐）

模板生成的 workflow 固定 `plugin-cli-version: 0.1.6`，初始化时实际使用 `0.1.9`。v0.3.0 发布准备已把 ref 与 `plugin-cli-version` 统一为 `0.1.9`（npm `latest`），与上游当前模板 `{{CLI_VERSION}}` 的写法一致。

## 5. 待办

1. **真实 DBX 宿主端到端手测**（需要 release 包含 #9692）：在已打开连接的查询结果页打开 Plan Detective → 输入 SQL → Analyze Plan → 核对 Plan Tree / Findings / Raw Plan。
2. **发布路径**：#9692 已合并但尚未进入 release；在包含 Host API 1.2 的 DBX release 可用前，插件在旧版 DBX 上会因 `engines.host_api ^1.2` 被宿主拒绝加载（这是预期行为）。
3. 后续增量（独立 Issue）：SQL Server ShowPlanXML parser、文本计划 parser、MySQL `FORMAT=TRADITIONAL` / `TREE` 与兼容方言、Actual Plan（需独立 upstream proposal）、Plan Diff、Estimate Error 等更多 metrics、更多 rules、UI 扩展。
4. 就第 4 节其余上游问题决定处理方式：4.1（Windows `create` 相对路径）、4.2（`$schema` 指向不存在 ref）、4.4（Windows `dbx-plugin dev`）、4.5（模板 README 链接）仍未修，等待是否向上游反馈；4.3 / 4.6 已在 v0.3.0 发布准备中本地修正。

## 6. 相关文档

- [README.md](README.md) —— 项目定位、Host 契约、数据链路与开发方式
- [AGENTS.md](AGENTS.md) —— 仓库约束与红线
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构边界与职责划分
- [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) —— 决策记录、阶段划分、Fixture 策略
- [docs/PLAN_INPUT_AND_FIXTURES.md](docs/PLAN_INPUT_AND_FIXTURES.md) —— RawPlanInput / parser registry / NormalizedPlan / Metrics / Rules / Findings / Hotspots 契约
- [docs/HOST_CAPABILITY_AUDIT.md](docs/HOST_CAPABILITY_AUDIT.md) —— Phase 0 审计矩阵（历史）
- [docs/DBX_HOST_API_GAP_PROPOSAL.md](docs/DBX_HOST_API_GAP_PROPOSAL.md) —— 上游能力缺口与提案（历史）
- [docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md](docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md) —— downstream design note
