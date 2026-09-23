# 状态

| 项 | 值 |
| --- | --- |
| 最后更新 | 2026-09-23 |
| 当前阶段 | **Phase 1–3.6 已合并；v0.6.6 Release Preparation 正在进行，release PR 待创建** |
| 插件版本 | 当前已发布 `0.6.5`；正在准备 `0.6.6`（`engines.dbx: >=0.6.18`，`engines.host_api: ^1.2`，权限 `host.plans:read` 不变） |
| 阶段结论 | Phase 3.6 决策为 `B — SMALL_IR_GAP`；Feature PR [#59](https://github.com/0verme/dbx-plugin-plan-detective/pull/59) 已合并，merge commit / 当前 `origin/main` 为 `5bb31154de3bfbdf90836b0a0b9d99ba272ca9f9`。功能验证：`npm test` 1243/1243、`npm run build` 通过；5 个 Doris goldens 已随功能合入。本轮 release 重跑 `npm run test:update-goldens`：83 个已提交 goldens unchanged。真实 Doris `NOT AVAILABLE`；Windows DBX Host Smoke `NOT RUN` |
| 当前不做 | 本轮仅准备 v0.6.6 release；不继续 Doris feature 开发，不建立数据库连接、不读取 credential、不执行用户 SQL、不请求 Actual / ANALYZE / PROFILE Plan、不接 AI、不构造完整 Doris DAG、不修改 DBX upstream / Doris server；PR 创建后停止，不 merge、不打 tag、不建 GitHub Release、不更新 DBX Store |

## 当前任务快照（v0.6.6 Release Preparation）

- Project: `dbx-plugin-plan-detective`
- Bootstrap Root: 原始初始化根目录未在本轮追溯（复用已初始化 Windows workspace）
- Workspace Root: `E:/vbcoding/dbx-plugin-plan-detective_base`
- Current Main: `E:/vbcoding/dbx-plugin-plan-detective`；branch `main`，HEAD `5414a984a91e777ebf831ba80dd14b6c14d97100`，`origin/main` `5bb31154de3bfbdf90836b0a0b9d99ba272ca9f9`；ahead 0 / behind 62，working tree `CLEAN`。Canonical local main 仅执行安全读取与 `git fetch origin`，未 checkout / pull / merge / rebase / reset / stash / clean。
- Active Tasks:
  - Issue / Task: Plan Detective v0.6.6 Release Preparation；Branch: `chore/prepare-v0.6.6-release`；Worktree: `E:/vbcoding/dbx-plugin-plan-detective_base/worktrees/release-v0.6.6`；State: `IN_PROGRESS`；Conflict Risk: `MEDIUM`；PR: 待创建；Notes: baseline `origin/main` / PR #59 merge `5bb31154de3bfbdf90836b0a0b9d99ba272ca9f9`；仅 release manifest / README / STATUS；真实 Doris `NOT AVAILABLE`；Windows DBX Host Smoke `NOT RUN`；package preflight `PACKAGE_PREFLIGHT_NOT_RUN`（`dbx-plugin` CLI 不可用）。
- Integration Baseline: release worktree 从 `origin/main` `5bb31154de3bfbdf90836b0a0b9d99ba272ca9f9` 创建；PR #59 merge commit 可达。
- Hotspot Files: `manifest.json`、`README.md`、`STATUS.md`；本轮不修改 Doris feature source / fixtures / goldens；Conflict Risk `MEDIUM`。
- Blocked: Real Doris `NOT AVAILABLE`；Windows DBX Host Smoke `NOT RUN`；`dbx-plugin package .` 未运行（Windows `dbx-plugin` CLI 不可用），不宣称 package preflight 通过。
- Cleanup Queue: 无；`node_modules/` 为本轮验证生成的 ignored 依赖目录，保留；没有生成 release package candidate。
- Merge Queue: v0.6.6 Release PR 待创建；创建后保持 open，等待 review；本轮不合并。
- Recently Merged: PR #59 Phase 3.6 Doris structured（merge `5bb31154de3bfbdf90836b0a0b9d99ba272ca9f9`）；PR #57 v0.6.5 release prep（merge `eca0052`）；PR #56 QuestDB structured（merge `62bef56`）；v0.6.5 已发布。

- Next Actions: 完成 v0.6.6 release commit、push 并创建中文 PR；PR 创建后停止，不 merge、不 tag、不建 GitHub Release、不更新 DBX Store。

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
- 宿主支持 estimated plan 的方言（`supports_explain_plan`）：PostgreSQL、MySQL、SQL Server、Oracle、OceanBase Oracle、Doris、Dameng、QuestDB；format 分别为 json / json / xml / text / json / text / text / text。Plan Detective 当前对 PostgreSQL / MySQL / SQL Server / OceanBase Oracle / Oracle / Dameng / QuestDB / Doris 进入 structured pipeline（Doris 仅 Estimated text）。
- 查询结果页入口（`result-view`）会向插件上下文传入 `connectionId` / `database` / `sql` / result 快照；standalone workbench 不传连接上下文。

### 0.2 本轮交付（Issue #11）

```text
DBX connection → getPlanCapabilities → explainPlan(mode: "estimated")
→ RawPlanInput → parser registry → NormalizedPlan → Metrics → Rules → Findings → UI
```

- `src/host/**`：Host adapter（结构校验、稳定错误码、UI 侧 timeout guard），唯一接触 `window.dbxPlugin` 的模块。
- `src/core/adapter/dbx-plan-response.js`：8 个 dbType → Plan Core family；json / text / xml；截断 fail-closed。
- `src/core/parsers/**`：parser registry；PostgreSQL / MySQL / SQL Server / OceanBase Oracle / Oracle / Dameng / QuestDB / Doris structured；Doris 只注册 Estimated `format: "text"`。
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

### 0.2.4 SQL Server ShowPlanXML 结构化（Phase 3.1，2026-09-21，PR #37 已合并）

```text
DBX Host（dbType: "sqlserver" / format: "xml" / Estimated ShowPlanXML）
→ RawPlanInput → parseSqlServerShowPlanXml → normalizeSqlServerPlan → NormalizedPlan
→ Metrics → 现有 Rules → Hotspots → Plan Tree / Node Inspector / Findings
```

- 新增 `src/core/sqlserver/xml.js`（无依赖、迭代式 XML 读取；按 local name 匹配，默认命名空间与带前缀元素
均能解析；malformed 抛 `MALFORMED_XML` + line/column）与 `src/core/sqlserver/parse-showplan-xml.js`（RelOp 映射）。
- 新增 `src/core/normalize/normalize-sqlserver.js`、`src/core/parsers/sqlserver.js`；registry 变为
  `postgresql + json` / `mysql + json` / `sqlserver + xml`，`STRUCTURED_DATABASES` 三项。
- Tree：每个 `RelOp` 的输入取自其 operator 容器内的 `RelOp` 后代（遇到嵌套 RelOp 停止），覆盖
  `NestedLoops` / `Hash` / `Merge` / `Sort` / `Concat` / `Spool` / `Parallelism` 与 `IndexScan Lookup="1"`；
  未知 operator 保留 label + 完整子树（进入 `unknownNodeTypes`）。
- 代价：`EstimatedTotalSubtreeCost` / `EstimateCPU` / `EstimateIO` 只进 `engineSpecific.sqlServer`，**不**映射到
  `startupCost` / `totalCost`；`costAttribution.status = "not-applicable"`；不生成 self-cost / 占比 hotspot。
- Hotspots：新增行数信号 `sqlserver-large-index-scan`（仅 `Index Scan` / `Clustered Index Scan`，seek 不算）与
  `sqlserver-sort`（`EstimateRows` 达阈值）；`large-sequential-scan` / `nested-loop-amplification` 复用 engine-neutral 行数逻辑。
- Findings：不新增 SQL Server 专用 rule；`large-sequential-scan` 与 `nested-loop-large-inner` 按行数适用，
  `expensive-sort` 因无 PostgreSQL 代价数据保持静默。
- Fixture：新增 `fixtures/sqlserver/` 14 个 synthetic ShowPlanXML（`estimated/`，`.plan.xml` + `.meta.json`）+ 对应 golden；
  本机无 SQL Server 实例，形状对照公开 schema / 文档，provenance 见 `fixtures/sqlserver/README.md`。
- 测试：`tests/sqlserver/**`（xml / parser / normalizer / fixtures+golden / analysis / hotspot / view-model）+ 既有测试适配；
  fixture loader 支持 `xml` 格式与 `.plan.xml`。

### 0.2.5 MySQL `data_read_per_join` data-size 修复（Issue #38，2026-09-22，PR #39 已合并）

- `cost_info.data_read_per_join` 是 data size，不是 cost：MySQL `human_readable_num_bytes()`（`include/m_string.h`）按 **1024 进制**输出整数 + 可选 `K` / `M` / `G` / `T` / `P` / `E` / `Z` / `Y` 后缀（如 `"167K"`），不会输出小数。
- 原有 V1 parser 用通用 `optionalNumeric()` 读取该字段，遇到真实 MySQL 输出会抛 `MALFORMED_NODE`（Issue [#38](https://github.com/0verme/dbx-plugin-plan-detective/issues/38)）。
- 修复：新增独立 `optionalDataSize()`，仅该字段接受 number / numeric string / data-size string 并归一化为 byte 数值；小数、错误后缀与 `+INF` 仍 fail closed。
- 边界：`query_cost` / `read_cost` / `eval_cost` / `prefix_cost` / `sort_cost` / `filtered` 的 numeric contract 未放宽；MySQL JSON Explain V2 无 `cost_info`，无需修改。
- 回归：新增 `fixtures/mysql/estimated/data-read-per-join-unit.synthetic.*` + golden、parser 单测、pipeline 与 view-model 断言；既有 47 个 golden 未变化。

### 0.2.6 OceanBase Oracle JSON Estimated Plan 结构化（Phase 3.2，2026-09-22，PR [#46](https://github.com/0verme/dbx-plugin-plan-detective/pull/46) 已合并）

```text
DBX Host（dbType: "oceanbase-oracle" / format: "json" / EXPLAIN FORMAT=JSON 解码结果）
→ RawPlanInput → parseOceanBaseJsonPlan → normalizeOceanBasePlan → NormalizedPlan
→ Metrics → 现有 Rules → Hotspots → Plan Tree / Node Inspector / Findings
```

- 上游契约核验（直接读取 `t8y2/dbx/main` `2dda96336`）：`crates/dbx-sql/src/query_execution_sql.rs` 的
  `estimated_plan_format(OceanbaseOracle) == Json`、`build_explain_sql` 生成 `EXPLAIN FORMAT=JSON <sql>`；
  `crates/dbx-core/src/query/plugin_plan.rs` 的 `uses_driver_native_plan()` 只覆盖 Dameng / Oracle，
  OceanBase Oracle 走 `native_estimated_plan` → `join_result_text()` 拼接驱动逐行返回的 JSON 文本 →
  `finalize_plan_payload()` 用 `serde_json::from_str` 解码，无法解码时降级为 `format: "text"` + `plan_not_json`。
  JSON 键与 `CHILD_<n>` 子节点编码同时对照 OceanBase Oracle 模式 `EXPLAIN` 官方文档与引擎 JSON plan writer
  （`src/sql/monitor/ob_sql_plan.cpp`）。**仓库此前的文档把 OceanBase Oracle 记为 `text` / raw-only，已在本轮更正。**
- 新增 `src/core/oceanbase/parse-json-plan.js`（`ID` / `OPERATOR`（trim）/ `NAME` / `EST.ROWS` / `EST.TIME(us)` /
  `COST` / `output` / `CHILD_<n>`；按 `CHILD_n` 数字后缀排序建树，支持任意个子节点）、
  `src/core/normalize/normalize-oceanbase.js`、`src/core/parsers/oceanbase-oracle.js`；registry 变为
  `postgresql + json` / `mysql + json` / `sqlserver + xml` / `oceanbase-oracle + json`，`STRUCTURED_DATABASES` 四项。
- fail-soft：未知算子保留节点 + 原始标签 + 完整子树（`unknownNodeTypes`）；未知 / 未验证的扩展键
  （`filter` / `access` / `range_key` / ...）原样保留在 `engineSpecific.extra`，**不**提升为中立谓词；
  缺字段为 `null`；无 `OPERATOR` 的节点用占位标签 `Plan`；非对象 `CHILD_<n>` 保留在 `extra`；
  根对象不是计划节点时抛 `MALFORMED_PLAN`。
- 代价：`EST.TIME(us)` / `COST` 只进 `engineSpecific.oceanBase`，**不**映射到 `startupCost` / `totalCost`；
  `costAttribution.status = "not-applicable"`；本轮**不新增** OceanBase 专属 hotspot / rule。
- Hotspots / Findings：复用既有 engine-neutral 行数信号（`large-sequential-scan` / `nested-loop-amplification`），
  并把信号 `source` 按引擎标为 `EST.ROWS`；`expensive-sort` 因无 PostgreSQL 代价数据保持静默；
  Hotspot 面板按 `engine` 选择 `NOT_POSTGRES_COST_MODEL` 文案（新增 `hotspot.cost.oceanbaseOracleCostModel`）。
- Fixture：新增 `fixtures/oceanbase-oracle/` 12 个（1 个 official = OceanBase V4.3.5 Oracle 模式 `EXPLAIN` 文档 JSON 示例 +
  11 个 synthetic）+ 对应 golden；本机无 OceanBase 实例，provenance 见 `fixtures/oceanbase-oracle/README.md`。
- 测试：`tests/oceanbase/**`（parser / normalizer / fixtures+golden / analysis / view-model）+ 既有测试适配
  （registry、fixture loader / convention、core isolation、metrics、hotspots）；`npm test` 1019/1019，既有 48 个 golden 未变化。
- Gate：`npm test` 1019/1019；`npm run build` 输出 `DBX_UI_BUILD_SUCCESS`；`dbx-plugin package .` 与 `git diff --check` 通过；
  Host Smoke **NOT RUN**（当前环境无 DBX Desktop Host）。本轮不发 Release（不改版本号 / 不打 tag / 不建 GitHub Release / 不更新 DBX Store）。

### 0.2.7 Doris Estimated EXPLAIN text 结构化（Phase 3.6，PR [#59](https://github.com/0verme/dbx-plugin-plan-detective/pull/59)，MERGED）

- 基线：独立 worktree `worktrees/doris-structured-plan`、branch `feat/doris-structured-plan`，起点 `origin/main` `11820fc1c70dc03c6ccdc98406624374a3686b67`；canonical Main Workspace 未修改。
- Gate 顺序：Host Contract → Plan Contract → IR Gap audit → Decision Gate；结论 `B — SMALL_IR_GAP`。完整审计见 `docs/DORIS_HOST_CONTRACT_AUDIT.md`、`docs/DORIS_PLAN_CONTRACT_AUDIT.md`、`docs/DORIS_IR_GAP_AUDIT.md`。
- 支持范围：Host `dbType: doris` / `format: text` / Estimated `EXPLAIN <sql>`；只实现 Estimated。Fragment / Sink metadata 与 branch-rail local operator trees 被保留；Fragment child order 按文档规则恢复；跨 Fragment Sink→Exchange edge 只进 metadata，不伪造 operator child edge。
- IR：保留 public single-root `NormalizedPlan`；新增可选 generic `engineSpecific.structural: true` 与 operator-only traversal / depth；Metrics / Rules / Hotspots 忽略 wrapper 自身、继续访问 children；Plan Tree / Inspector 使用通用字段展示 wrapper / properties。
- 语义边界：仅可靠 `cardinality` → `estimatedRows`；scan 用中性 `scan`；不映射 Doris cost / `avgRowSize` 到 PostgreSQL cost / shared width；不建 runtime Pipeline DAG、不改 DBX upstream。
- Fixtures：1 official Apache Doris documentation transcription + 4 synthetic，全部 `estimated/`，无假造 capture metadata；Phase 3.6 新增 5 个 Doris goldens。本轮 release 重跑 `npm run test:update-goldens` 报告 0 files written、83 个已提交 goldens unchanged。
- Gate：`npm test` **1243/1243**；`npm run build` **通过**（`DBX_UI_BUILD_SUCCESS`）。本地 `npm ci` 的 esbuild bundled binary 在工作区呈 mode `000` 导致安装脚本 `EACCES`；忽略脚本安装后只修复 ignored `node_modules` binary 的执行位并验证版本，production build 成功。`git diff --check` **通过**。
- Real Doris：**NOT AVAILABLE**；Windows DBX Host Smoke：**NOT RUN**。PR #59 已合并，merge commit `5bb31154de3bfbdf90836b0a0b9d99ba272ca9f9`（当前 `origin/main`）；本轮 release prep 单独处理，不改 Doris feature source。

### 0.10 v0.6.3 Release（2026-09-22）

- 本轮为 patch release：版本 `0.6.2 → 0.6.3`；发布准备 PR [#50](https://github.com/0verme/dbx-plugin-plan-detective/pull/50) 已合并，release commit `18f84c4`。
- 内容：Phase 3.3「Oracle DBMS_XPLAN Estimated Plan 文本结构化」（PR [#49](https://github.com/0verme/dbx-plugin-plan-detective/pull/49)，merge `675451e`）：
  - 支持 DBX 当前 `DBMS_XPLAN.DISPLAY(..., 'TYPICAL +PREDICATE')` Estimated `format: "text"`；按 Operation 缩进恢复树，保留 Oracle 原生字段、predicate marker / text 与未知 operation 子树；
  - Oracle `Cost` / `Bytes` / `%CPU` / `Time` 保留在 `engineSpecific.oracle`，不映射 PostgreSQL `startupCost` / `totalCost`；`costAttribution.status = "not-applicable"`；
  - 新增 5 个 synthetic text fixture + golden，覆盖缺失字段、CRLF、可变列宽、predicate、未知 operation 与共享 Metrics / Hotspots / UI 链路。
- Release commit：`18f84c4cb3115330a5d70a68f3ce76866329bf5f`；annotated tag `v0.6.3`（tag object `5c49802aa4affc04131d05fd98a2766882a286b3`）已推送。
- GitHub Release：[Plan Detective v0.6.3](https://github.com/0verme/dbx-plugin-plan-detective/releases/tag/v0.6.3)，published 2026-09-22T13:59:40Z，非 draft / 非 prerelease。
- Workflow：[Release DBX plugin · 35737205087](https://github.com/0verme/dbx-plugin-plan-detective/actions/runs/35737205087)，`event=release`、`head_sha = 18f84c4…`、conclusion success。
- CI asset：`io.github.0verme.plan-detective-0.6.3-universal.dbxp`，82152 bytes，SHA-256 `3ae6997e7b73b682745dfdbfa8e8c27dfac797406947bd41b3fb6f2d5cd2d7f4`；`release-candidates.json`，559 bytes，SHA-256 `93c6c767fb9c9a52397477620bbc4f4257ee642c74ce8936e1b846f60bf02648`。
- Package contract：target `universal`；manifest `id = io.github.0verme.plan-detective`、`publisher = 0verme`、`version = 0.6.3`、`engines.dbx = >=0.6.18`、`engines.host_api = ^1.2`、`permissions = ["host.plans:read"]`；包内无 `signature.json`；包内 `ui/` 与仓库 `ui/` 逐字节一致。
- 本地 Gate：`npm test` 1066/1066；`npm run test:update-goldens` 65 个 golden unchanged；`npm run build` 输出 `DBX_UI_BUILD_SUCCESS`；`dbx-plugin package .` 成功；`git diff --check` 通过。
- Host Smoke：**NOT RUN** — 当前环境无 Oracle 实例或 DBX Desktop Host；Windows 安装与 Oracle 计划验证由维护者手工完成。本版本不更新 DBX Store。

### 0.11 v0.6.4 Release（2026-09-22）

- 本轮为 patch release：版本 `0.6.3 → 0.6.4`；发布准备 PR [#53](https://github.com/0verme/dbx-plugin-plan-detective/pull/53) 已合并，release commit `c35f2d2`。
- 内容：Phase 3.4「Dameng Structured Estimated Plan」：Dameng Estimated-only 原生文本 parser / normalizer、共享 Metrics / Hotspots / Rules / UI、1 个 official + 6 个 synthetic fixture 与 golden。
- Release commit：`c35f2d2a4925c9e08bc387f407ec862015a95f16`；annotated tag `v0.6.4`（tag object `fce686e4e26c3f9eec291cb2fc69478773ed9654`）已推送。
- GitHub Release：[Plan Detective v0.6.4](https://github.com/0verme/dbx-plugin-plan-detective/releases/tag/v0.6.4)，published `2026-09-22T16:07:07Z`，非 draft / 非 prerelease。
- Workflow：[Release DBX plugin · 35751956037](https://github.com/0verme/dbx-plugin-plan-detective/actions/runs/35751956037)，`event=release`、`head_sha = c35f2d2…`、conclusion success。
- CI asset：`io.github.0verme.plan-detective-0.6.4-universal.dbxp`，84871 bytes，SHA-256 `847da48f74cc55af42cdd037dc2dd658535427450ed88f7842422f5bb30aafec`；`release-candidates.json`，559 bytes，SHA-256 `dc8aa35a7349805acd6bd8c94b56127cc417de91b0c751e21cf551267c75861d`。
- Package contract：target `universal`；manifest `id = io.github.0verme.plan-detective`、`publisher = 0verme`、`version = 0.6.4`、`engines.dbx = >=0.6.18`、`engines.host_api = ^1.2`、`permissions = ["host.plans:read"]`；包内无 `signature.json`；CI 包含 `ui/` 与 release commit 仓库 `ui/`。
- 本地 Gate：`npm test` 1128/1128；`npm run test:update-goldens` 72 个 golden unchanged；`npm run build` 输出 `DBX_UI_BUILD_SUCCESS`；`dbx-plugin package .` 成功；`git diff --check` 通过。
- Host Smoke：**NOT RUN** — 当前环境无 DBX Desktop Host 或真实 Dameng 实例；Windows 安装与 Dameng 计划验证由维护者手工完成。本版本不更新 DBX Store。

### 0.12 v0.6.5 Release（2026-09-23）

- 本轮为 patch release：版本 `0.6.4 → 0.6.5`；内容为 Phase 3.5 QuestDB Estimated EXPLAIN 结构化解析（PR #56，merge `62bef56`）。发布准备 PR [#57](https://github.com/0verme/dbx-plugin-plan-detective/pull/57) 于 `2026-09-23T04:09:02Z` 合并。
- Release commit：`eca0052246ce42771e1b1e1dce883155a2869704`；annotated tag `v0.6.5`（tag object `1a86c05284c2bdf6a56c06e35bf554d8333cb808`）已推送。
- GitHub Release：[Plan Detective v0.6.5](https://github.com/0verme/dbx-plugin-plan-detective/releases/tag/v0.6.5)，published `2026-09-23T04:11:31Z`，非 draft / 非 prerelease。
- Workflow：[Release DBX plugin · 35817327732](https://github.com/0verme/dbx-plugin-plan-detective/actions/runs/35817327732)，`event=release`、`head_sha = eca0052…`、conclusion success；Build universal 与 Publish plugin release assets jobs 均成功。
- CI asset：`io.github.0verme.plan-detective-0.6.5-universal.dbxp`，87012 bytes，SHA-256 `2140f5684caff6e35ba9cd8f6d252da02b9fdce4450e9e55c1bab408b3dac1f6`；`release-candidates.json`，559 bytes，SHA-256 `0c0df65234180745d936bbdd8e1c322ac9c4a483d88af1bcfdc138866c981813`。下载后 size / SHA 与 metadata 一致。
- Package contract：target `universal`；manifest `id = io.github.0verme.plan-detective`、`publisher = 0verme`、`version = 0.6.5`、`engines.dbx = >=0.6.18`、`engines.host_api = ^1.2`、`permissions = ["host.plans:read"]`；包内无 `signature.json`；内部 checksums、manifest 语义、`ui/` 与 release commit 源文件均验证通过。
- 本地 Gate：`npm test` 1193/1193；`npm run build` 输出 `DBX_UI_BUILD_SUCCESS`；`npx --yes --package=@dbx-app/plugin-cli@0.1.9 dbx-plugin package .` 成功；`git diff --check` 通过。Local unsigned preflight candidate 87012 bytes / SHA-256 `d998c4d47d4d7cdeefaf466a57ae3f3ec8fb72cf5b86026610b11e11e9c9eaeb`；与 CI archive digest 不同，但归档内文件 checksums / UI 内容均一致。
- Host Smoke：**NOT RUN** — 当前环境无 DBX Desktop Host 或真实 QuestDB 实例；fixtures provenance 明确区分文档转录与 synthetic，未声称本地 capture。
- DBX Store 更新 / signing 不属于本次 release；需由 Store maintainer 处理候选 PR。

### 0.13 v0.6.6 Release Preparation（2026-09-23，release PR 待创建）

- 版本：`0.6.5 → 0.6.6`；release baseline 为 `origin/main` / PR #59 merge commit `5bb31154de3bfbdf90836b0a0b9d99ba272ca9f9`。本轮只修改 `manifest.json`、`README.md`、`STATUS.md`；Doris feature source、fixtures、goldens 未改，`ui/**` 构建后无变化。
- Manifest contract 保持：`id = io.github.0verme.plan-detective`、`engines.dbx = >=0.6.18`、`engines.host_api = ^1.2`、`permissions = ["host.plans:read"]`；未新增 permission。`dbx-plugin.toml` 声明 `assets` / `ui` 打包目录。
- Doris release scope：Estimated EXPLAIN text → Distributed Plan → PLAN FRAGMENT → fragment-local operator tree；保留 Fragment / Sink / Exchange metadata、`cardinality → estimatedRows`、neutral scan、join / sort / aggregate normalization 与未知 operator / property。Sink → Exchange 只作为 metadata / evidence，不构造完整 DAG。Decision `B — SMALL_IR_GAP`：generic structural wrapper 可 traversal，不参与 operator metrics / rules / hotspots。Doris cost 不映射 PostgreSQL cost；`costAttribution = not-applicable`。
- Validation（Windows）：`npm test` **1243/1243 PASS**；`npm run test:update-goldens` **0 files written / 83 unchanged**（覆盖 PostgreSQL、MySQL、SQL Server、OceanBase Oracle、Oracle、Dameng、QuestDB 与 5 个已提交 Doris goldens）；`npm run build` **PASS**（`DBX_UI_BUILD_SUCCESS`，`ui/**` 无变化）；`git diff --check` **PASS**。
- Package preflight：**PACKAGE_PREFLIGHT_NOT_RUN** — 当前 Windows 环境没有 `dbx-plugin` CLI；未创建或验证 `.dbxp`，不宣称 PASS。
- Real Doris：**NOT AVAILABLE**；Windows DBX + Doris Host Smoke：**NOT RUN**。
- Release PR：待创建；本轮目标为创建 PR 后停止。Tag、GitHub Release 与 DBX Store 均未创建 / 更新。

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

### 0.9 v0.6.2 Release（2026-09-22）

- 本轮为 patch release：版本 `0.6.1 → 0.6.2`（PR [#47](https://github.com/0verme/dbx-plugin-plan-detective/pull/47) 已合并，merge `89a5d07`）；该 PR 同步了 `manifest.json`、README 安装示例、状态快照与按当前 src 重建的 `ui/**`。
- 内容：Phase 3.2「OceanBase Oracle JSON Estimated Plan 结构化」（PR [#46](https://github.com/0verme/dbx-plugin-plan-detective/pull/46)，merge `9bd5f27`，head `a6f56c8`）：
  - 新增 `src/core/oceanbase/parse-json-plan.js`：`ID` / `OPERATOR`（trim）/ `NAME` / `EST.ROWS` / `EST.TIME(us)` /
    `COST` / `output` 映射与 `CHILD_<n>` 递归建树（按数字后缀升序，支持任意个子节点）；
  - 新增 `src/core/normalize/normalize-oceanbase.js` 与 `src/core/parsers/oceanbase-oracle.js`；registry 变为
    `postgresql + json` / `mysql + json` / `sqlserver + xml` / `oceanbase-oracle + json`，`STRUCTURED_DATABASES` 四项；
  - 上游证据：`estimated_plan_format(OceanbaseOracle) == Json`、宿主生成 `EXPLAIN FORMAT=JSON` 并在
    `plugin_plan.rs` 中把驱动逐行返回的 JSON 文本拼接后解码；`format: "text"`（宿主 `plan_not_json` 降级）仍为 raw-only；
  - `EST.TIME(us)` / `COST` 只进 `engineSpecific.oceanBase`，**不**映射到 `startupCost` / `totalCost`，
    `costAttribution.status = "not-applicable"`；本轮**不新增** OceanBase 专属 rule / hotspot，
    复用 `large-sequential-scan` / `nested-loop-amplification` 行数信号并把 `source` 标为 `EST.ROWS`；
    Hotspot 代价说明按 engine 输出（新增 `hotspot.cost.oceanbaseOracleCostModel`）；
  - 未知算子 / 未知或未验证扩展键 fail-soft 保留，不伪造中立谓词；支持矩阵 `OceanBase Oracle | Raw Plan` → `OceanBase Oracle | Structured`；
  - Fixture：`fixtures/oceanbase-oracle/` 12 个（1 个 official 官方文档 JSON 示例 + 11 个 synthetic）+ 对应 golden；
    本机无 OceanBase 实例，provenance 见 `fixtures/oceanbase-oracle/README.md`。
- Release commit：`89a5d07d482e66da54a5e5a9f1f1ba073bed935d`（PR #47 merge）；annotated tag `v0.6.2`（tag object `96bf226353c412b2712d55ce393fef3a3b6b707f`）已推送。
- GitHub Release：[Plan Detective v0.6.2](https://github.com/0verme/dbx-plugin-plan-detective/releases/tag/v0.6.2)，published 2026-09-22T12:08:08Z，非 draft / 非 prerelease。
- Workflow：[Release DBX plugin · 35725394737](https://github.com/0verme/dbx-plugin-plan-detective/actions/runs/35725394737)，`event=release`、`head_sha = 89a5d07…`、conclusion success。
- CI asset：`io.github.0verme.plan-detective-0.6.2-universal.dbxp`，78709 bytes，SHA-256 `b44a5cad7be8f5683ecac256da020de5c89d23fc3b80b9657520d62971464096`；
  `release-candidates.json`，559 bytes，SHA-256 `fcc40cb0b841559aa99963394c8d259427911b3dc12e20f7499338736037dd07`（`version = 0.6.2`，artifact hash 与实际包一致）。
- Package contract：target `universal`；manifest `id = io.github.0verme.plan-detective`、`publisher = 0verme`、`version = 0.6.2`、
  `engines.dbx = >=0.6.18`、`engines.host_api = ^1.2`、`permissions = ["host.plans:read"]`；包内无 `signature.json`；
  包内 `ui/` 与仓库 `ui/` 逐字节一致；本地 candidate 与 CI 包解包内容一致（仅 ZIP Unix mode 差异）。
- 本地 Gate：`npm test` 1019/1019；`npm run build` 输出 `DBX_UI_BUILD_SUCCESS`；`dbx-plugin package .`、`git diff --check` 通过；
  既有 48 个 golden 未变化。
- Host Smoke：**NOT RUN** — 当前环境无可用 DBX Desktop Host；Windows 安装与 OceanBase Oracle 计划验证由维护者手工完成
  （建议 SQL 见 PR #46 的「人工验收」小节）。
- 非目标（沿用 Phase 3.2 边界）：不新增 Oracle / Dameng / Doris / QuestDB parser，不实现 Actual Plan、Plan Diff、
  AI 接入或数据库 Driver；`engines` 与 `permissions` 未变化。

### 0.8 v0.6.1 Release（2026-09-22）

- 本轮为 patch release：版本 `0.6.0 → 0.6.1`；同步 `manifest.json`、README 安装示例 / 功能列表与状态快照（PR [#44](https://github.com/0verme/dbx-plugin-plan-detective/pull/44)）。
- 内容：Issue [#42](https://github.com/0verme/dbx-plugin-plan-detective/issues/42)「增强执行计划结果可读性，并提供复制 AI 分析提示词」（PR [#43](https://github.com/0verme/dbx-plugin-plan-detective/pull/43)，merge `a17fa0b`）：
  - 新增 Hotspot presenter（`src/lib/hotspot-presentation.js`），按结构化 reason code 输出 `zh-CN` / `en` 自然语言摘要，保留原始 statement / code / source / Evidence，未知 code 优雅回退；
  - 新增纯函数 Prompt builder（`src/lib/ai-analysis-prompt.js`）与 `host.copy` → `navigator.clipboard` 降级复制（`src/lib/clipboard-copy.js`），在成功状态栏提供「复制 AI 分析提示词」；
  - 仅本地字符串打包 + 本地剪贴板 / Host IPC，不调用任何 AI 服务、不新增网络请求、不修改 parser / normalizer / diagnosis 规则。
- Release commit：`3eb8c3733c515fdde505f1f0fd841f522390384d`（PR [#44](https://github.com/0verme/dbx-plugin-plan-detective/pull/44) merge）；annotated tag `v0.6.1` 已推送（tag object `1bcc482fe2889de84dcf27040d08b1e0ecbc3f6f`）。
- GitHub Release：[Plan Detective v0.6.1](https://github.com/0verme/dbx-plugin-plan-detective/releases/tag/v0.6.1)，非 draft / 非 prerelease，published 2026-09-22T07:59:02Z。
- Workflow：[Release DBX plugin · 35702355523](https://github.com/0verme/dbx-plugin-plan-detective/actions/runs/35702355523)，success；`head_sha` 为 release commit。
- CI asset：`io.github.0verme.plan-detective-0.6.1-universal.dbxp`，size `77342` bytes，SHA-256 `6928658b40b7b9aa441a906c3aafa95d7f59d70bebf05a621da16d66baf9d4c4`。
- Metadata：`release-candidates.json`，size `559` bytes，SHA-256 `2659233ea943b4b2050962ccb09c726e2d263a4712e4cc17066d0ea228bc7492`；target `universal`，plugin `0.6.1`，artifact hash 与实际 Release asset 一致。
- 包内容：`manifest.json`（0.6.1 / engines / `host.plans:read`）、`ui/index.html`、`ui/assets/index-D2YokrfX.js`、`ui/assets/index-DtmvlNjI.css`、`assets/plugin.svg`、`checksums.json`；无 `signature.json`；包内 ui 文件与仓库 `ui/` 逐字节一致；本地 `dbx-plugin package .` candidate 与 CI 包解包内容一致（仅 ZIP 内 Unix mode 差异导致 SHA-256 不同）。
- Gate：`npm test` 870/870；`npm run build` 输出 `DBX_UI_BUILD_SUCCESS`；`dbx-plugin package .`、Release artifact validation、`git diff --check` 通过。
- Host Smoke：**NOT RUN** — 当前环境无可用 DBX Desktop Host；Windows 安装与 Issue #42 功能（Hotspot 人话解释 / 复制 Prompt / clipboard fallback）验证由维护者手工完成。
- 非目标（沿用 Issue #42）：不接 OpenAI / Claude / Gemini，不新增 API Key / 模型配置 / 聊天窗口，不做 SQL 改写、自动索引建议与 SQL 脱敏。

### 0.7 v0.6.0 Release（2026-09-22）

- 本轮为 minor release：版本 `0.5.4 → 0.6.0`；manifest 在 PR #37 中已升级为 `0.6.0`（`engines.dbx: >=0.6.18`、`engines.host_api: ^1.2`、`host.plans:read`）。
- 内容：Phase 3.1 SQL Server ShowPlanXML 结构化解析（PR [#37](https://github.com/0verme/dbx-plugin-plan-detective/pull/37)，merge `79dd292`）+ Issue [#38](https://github.com/0verme/dbx-plugin-plan-detective/issues/38) MySQL `data_read_per_join` data-size 修复（PR [#39](https://github.com/0verme/dbx-plugin-plan-detective/pull/39)，merge `b6641c6`）。
- Release commit：`1a1d8c0453bcf305037ab3b10866d24cc529cfd8`（PR [#40](https://github.com/0verme/dbx-plugin-plan-detective/pull/40) merge）；annotated tag `v0.6.0` 已推送。
- GitHub Release：[Plan Detective v0.6.0](https://github.com/0verme/dbx-plugin-plan-detective/releases/tag/v0.6.0)，非 draft / 非 prerelease，published 2026-09-22T05:49:58Z。
- Workflow：[Release DBX plugin · 35692252780](https://github.com/0verme/dbx-plugin-plan-detective/actions/runs/35692252780)，success；`head_sha` 为 release commit。
- CI asset：`io.github.0verme.plan-detective-0.6.0-universal.dbxp`，size `67910` bytes，SHA-256 `41ef03bd6ebf4f144d7e8cad0e515b7fdbd361edb5fdca1f8d9f414eae6b318f`。
- Metadata：`release-candidates.json`，size `559` bytes，SHA-256 `958e886e8f695c791894811aa66e6cabb32d9d0bdbf911ad69c1d7333539b3bb`；target `universal`，plugin `0.6.0`，artifact hash 与实际 Release asset 一致。
- 包内容：`manifest.json`（0.6.0 / engines / `host.plans:read`）、`ui/index.html`、`ui/assets/index-DKAu-p64.js`、`ui/assets/index-BnBTLH1_.css`、`assets/plugin.svg`、`checksums.json`；无 `signature.json`；包内 ui 文件与仓库 `ui/` 逐字节一致。
- Gate：`npm test` 835/835；`npm run build` 输出 `DBX_UI_BUILD_SUCCESS`；`dbx-plugin package .`、Release artifact validation、`git diff --check` 通过。
- Host Smoke：**NOT RUN** — 当前环境无可用 DBX Desktop Host；Windows 安装与真实 MySQL data-size 计划验证由维护者手工完成。
- DBX Store：PR [#112](https://github.com/t8y2/dbx-store/pull/112) 仍为 v0.5.4 candidate；v0.6.0 Store 收录待后续处理。

### 0.6 v0.5.4 DBX 最低版本收紧 / Release（2026-09-21）

- 本轮为 patch release：版本 `0.5.3 → 0.5.4`，仅将最低 DBX 版本从 `>=0.5.68` 收紧为 `>=0.6.18`。
- 保持 `engines.host_api: ^1.2` 与 `host.plans:read`；不修改 parser、metrics、hotspot、findings、UI 行为或 Plan API 调用逻辑。
- 原因：DBX v0.6.18 正式包含只读 Estimated Plan Host API，对应上游 [t8y2/dbx#9692](https://github.com/t8y2/dbx/pull/9692)。
- Release commit：`c2d1a5d02ede4605eb3bebf4df66ea550fe8d59b`；annotated tag `v0.5.4` 已推送。
- GitHub Release：[DBX Plan Detective v0.5.4](https://github.com/0verme/dbx-plugin-plan-detective/releases/tag/v0.5.4)，非 draft / 非 prerelease。
- Workflow：[Release DBX plugin · 35573439237](https://github.com/0verme/dbx-plugin-plan-detective/actions/runs/35573439237)，success；`head_sha` 为 release commit。
- CI asset：`io.github.0verme.plan-detective-0.5.4-universal.dbxp`，size `62462` bytes，SHA-256 `40d1e087311cc4f3105e46194a8ad71b4611fba323a9ffd94277eaefc3dec3df`。
- Metadata：`release-candidates.json`，size `559` bytes，SHA-256 `111d2012f04674a18352c9534d10275e17373c8e0cf5f8f935d5cf5b852b5398`；target `universal`，package metadata / manifest / permission contract 匹配 `0.5.4`。
- Gate：`npm test` 629/629；`npm run build` 输出 `DBX_UI_BUILD_SUCCESS`；`dbx-plugin package .`、`git diff --check` 与 Release artifact validation 通过；`.dbxp` 包内无 `signature.json`。
- Host Smoke：**NOT RUN** — 当前环境无可用 DBX Desktop Host；不构成功能不变的 patch release blocker。
- DBX Store：首次收录 PR [#112](https://github.com/t8y2/dbx-store/pull/112) 已创建；candidate 仅使用上述 v0.5.4 Release 实际下载并校验的数据，等待 maintainer review / `/sign`。

### 0.5 v0.5.3 Icon Release（2026-09-21）

- Release commit：`0506da76132d5126cfb90e4c10fd98f2fc2f42b8`；tag `v0.5.3` 已指向该 commit 并推送。
- GitHub Release：[DBX Plan Detective v0.5.3](https://github.com/0verme/dbx-plugin-plan-detective/releases/tag/v0.5.3)，非 draft / 非 prerelease。
- Workflow：[Release DBX plugin · 35569922070](https://github.com/0verme/dbx-plugin-plan-detective/actions/runs/35569922070)，success；`head_sha` 为 release commit。
- CI asset：`io.github.0verme.plan-detective-0.5.3-universal.dbxp`，size `62460` bytes，SHA-256 `156d02840ab03174af7b1ad1b6d45ab6caafc0c387c9f2065c35675a5217cd04`。
- Metadata：`release-candidates.json`，size `559` bytes，SHA-256 `18ac01aeb03551c080a1483aa8eca3b5581e6ef23a25cf06e89fc151cf7ef9a4`；target `universal`，package metadata / manifest / icon contract 匹配 `0.5.3`。
- Gate：`npm test` 629/629；`npm run build` 输出 `DBX_UI_BUILD_SUCCESS`；`dbx-plugin package .`、`git diff --check` 与 CI artifact validation 通过；`.dbxp` 包含 `assets/plugin.svg`。
- Host Smoke: **NOT RUN** — NAS/Linux 无真实 DBX Desktop Host；Windows 安装与人工验收待发布后执行，不构成发布 blocker。
- DBX Store candidate：本轮未创建。

### 0.4 v0.5.2 Patch Release（2026-09-21）

- Release commit：`72d617b3c1dfe289a80a2e27561853325f15730`；tag `v0.5.2` 已指向该 commit 并推送。
- GitHub Release：[DBX Plan Detective v0.5.2](https://github.com/0verme/dbx-plugin-plan-detective/releases/tag/v0.5.2)，非 draft / 非 prerelease。
- Workflow：[Release DBX plugin · 35561562301](https://github.com/0verme/dbx-plugin-plan-detective/actions/runs/35561562301)，success；`head_sha` 为 release commit。
- CI asset：`io.github.0verme.plan-detective-0.5.2-universal.dbxp`，size `62148` bytes，SHA-256 `d62a6e4d37b2cc207bf7e354bcbf8bd1abe42093661d85b54e8df09da239271c`。
- Metadata：`release-candidates.json`，size `559` bytes，SHA-256 `bb769bd112983cc17241ff21642eb6e4bc1827781377fc1d172d0926aaee7b5c`；target `universal`，package metadata / manifest / host contract 匹配 `0.5.2`。
- Gate：`npm test` 629/629；`npm run build` 输出 `DBX_UI_BUILD_SUCCESS`；`git diff --check` 与 static responsive audit 通过。
- Host Smoke: **NOT RUN** — NAS/Linux 无真实 DBX Desktop Host；Windows 安装、布局与交互人工验收待发布后执行，不构成发布 blocker。

## 1. 完成度速览

| 能力 | 状态 |
| --- | --- |
| 官方 Svelte + Vite 项目骨架 | ✅ 已初始化 |
| UI 构建（`npm run build`） | ✅ 通过（本轮复跑） |
| 打包（`dbx-plugin package`） | ✅ 通过（v0.6.3 unsigned universal candidate；CI artifact 82152 bytes / SHA-256 `3ae6997e…`） |
| `dbx-plugin dev` 本地开发主机 | ⚠️ 可用，但 Windows 需绕过上游 bug（见第 4 节） |
| `manifest.json` 合法性 | ✅ 通过（`dbx >=0.6.18` / `host_api ^1.2` / `host.plans:read`，对上游 schema） |
| Host Capability Audit（Phase 0） | ✅ 已完成（历史结论 BLOCKED，见 §0.3） |
| Audit Harness（开发/审计页） | ✅ 保留为 UI 内“宿主审计（开发）”视图，并加入真实 Plan API 方法探测 |
| **Host Plan API 接入（生产路径）** | ✅ 已实现（`src/host/**`；capabilities 门控 + `mode: "estimated"`） |
| **Estimated Plan 获取 → 解析闭环** | ✅ 已实现（PostgreSQL / MySQL / SQL Server / OceanBase Oracle / Oracle / Dameng / QuestDB / Doris structured；Doris Estimated text only） |
| **Host 分析 UI** | ✅ Connection Context / SQL Input / Plan Summary / Hotspots / Findings / Plan Tree / Node Inspector / Raw Plan |
| Offline Plan Core（fixture-first） | ✅ 已实现（`src/core/**`） |
| Fixture-driven 开发 UI | ✅ 保留为开发模式（不进入生产路径） |
| DBX Estimated Plan Response Adapter | ✅ 已实现并接入（Issue #9 / PR #10；本轮扩展到 8 方言 + 3 format） |
| native backend（Rust / Go） | ❌ 不存在（符合 Thin Plugin 原则） |
| 数据库驱动依赖 | ❌ 不存在（符合禁止清单） |
| AI / LLM 依赖 | ❌ 不存在 |
| Execution Plan Parsing | ✅ PostgreSQL / MySQL / SQL Server / OceanBase Oracle / Oracle / Dameng / QuestDB / Doris structured（Doris Estimated text only） |
| Plan Normalization | ✅ 已实现（PostgreSQL / MySQL / SQL Server / OceanBase Oracle / Oracle / Dameng / QuestDB / Doris；公共字段 + `engineSpecific`） |
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
| SQL Server | xml | structured（Estimated ShowPlanXML；无依赖 XML parser；代价不映射到 PostgreSQL 语义） |
| OceanBase Oracle | json | structured（`EXPLAIN FORMAT=JSON`；`CHILD_<n>` 递归树；`EST.TIME(us)` / `COST` 不映射到 PostgreSQL 语义；`format: "text"` 降级仍 raw only） |
| Oracle | text | structured（Estimated DBMS_XPLAN `TYPICAL +PREDICATE`） |
| Dameng | text | structured（Estimated native text） |
| Doris | text | structured（Estimated EXPLAIN only；Fragment wrappers structural；跨 Fragment Exchange link 保留为 metadata） |
| QuestDB | text | structured（Estimated EXPLAIN text；无 shared rows / PostgreSQL cost 信号） |

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

1. **真实 DBX 宿主端到端手测**（需要 DBX v0.6.18 / Host API 1.2+）：v0.6.3 已发布，等待在 Windows DBX 安装验证 Oracle DBMS_XPLAN 结构化链路（Plan Tree / Node Inspector 的 `Rows` / `Cost` / predicates / Raw Plan）与 estimated-only 边界，并复测 OceanBase Oracle 与 Issue #42 的人工验收。
2. **DBX Store 首次收录**：PR [#112](https://github.com/t8y2/dbx-store/pull/112) 等待 maintainer review、`/sign`、protected signing workflow 和最终 catalog 生成；本仓库不管理 Store signing key。
3. **宿主兼容边界**：v0.6.3 已按 `engines.dbx >=0.6.18`、`engines.host_api ^1.2` / `host.plans:read` contract 发布；更旧 DBX 不满足 Plan Detective 的 Host Plan API 依赖。
4. 后续增量（独立 Issue）：Doris 文本计划 parser、MySQL `FORMAT=TRADITIONAL` / `TREE` 与兼容方言、Actual Plan（需独立 upstream proposal）、Plan Diff、Estimate Error 等更多 metrics、更多 rules、UI 扩展；Dameng 侧真实 Host / 实例 smoke（当前未运行）、更多版本 operator / detail contract；OceanBase Oracle 侧：真实 fixture 采集（替换 synthetic / official 文档样本）、`TABLE(INDEX)` 的 indexName 语义、`EST.TIME(us)` 是否值得独立热点信号。
5. 就第 4 节其余上游问题决定处理方式：4.1（Windows `create` 相对路径）、4.2（`$schema` 指向不存在 ref）、4.4（Windows `dbx-plugin dev`）、4.5（模板 README 链接）仍未修，等待是否向上游反馈；4.3 / 4.6 已在 v0.3.0 发布准备中本地修正。

## 6. 相关文档

- [README.md](README.md) —— 项目定位、Host 契约、数据链路与开发方式
- [AGENTS.md](AGENTS.md) —— 仓库约束与红线
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构边界与职责划分
- [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) —— 决策记录、阶段划分、Fixture 策略
- [docs/PLAN_INPUT_AND_FIXTURES.md](docs/PLAN_INPUT_AND_FIXTURES.md) —— RawPlanInput / parser registry / NormalizedPlan / Metrics / Rules / Findings / Hotspots 契约
- [docs/HOST_CAPABILITY_AUDIT.md](docs/HOST_CAPABILITY_AUDIT.md) —— Phase 0 审计矩阵（历史）
- [docs/DBX_HOST_API_GAP_PROPOSAL.md](docs/DBX_HOST_API_GAP_PROPOSAL.md) —— 上游能力缺口与提案（历史）
- [docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md](docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md) —— downstream design note
