# 状态

| 项 | 值 |
| --- | --- |
| 最后更新 | 2026-09-20 |
| 当前阶段 | **Phase 0B · Offline Plan Core（已实现，PR #6）+ Phase 0C · Fixture-driven MVP UI（已实现，Issue #7）+ Phase 0D · DBX Response Adapter Contract（离线已实现，Issue #9）+ Host 接入 BLOCKED**（`Offline Core implemented · Fixture-driven MVP UI implemented · DBX response adapter contract implemented offline · Real Host integration blocked on upstream t8y2/dbx#9692 merge / release`；[t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675) 一期 Estimated Plan only，实现 PR [t8y2/dbx#9692](https://github.com/t8y2/dbx/pull/9692)） |
| 插件版本 | 0.1.0 |
| 阶段结论 | 当前 blocker = **DBX Estimated Plan Host API 尚未合并 / release**（“能力是否存在”已无未知）；离线 Plan Core（parser / normalization / metrics / rules）、Fixture-driven MVP UI 与 DBX Response Adapter 契约均已实现且不依赖 Host API；真实 Host 接入仍暂停 |

## 0. Phase 0 审计结论（2026-09-18）

完整矩阵、逐项证据、真实 DBX 运行实测记录：[docs/HOST_CAPABILITY_AUDIT.md](docs/HOST_CAPABILITY_AUDIT.md)。上游能力缺口与一期 API 提案：[docs/DBX_HOST_API_GAP_PROPOSAL.md](docs/DBX_HOST_API_GAP_PROPOSAL.md)。

**上游 contract（2026-09-20）**：Estimated Plan Host API 需求已正式提交为 [t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)（OPEN，已由 `0verme` `/claim`），实现 PR 为 [t8y2/dbx#9692](https://github.com/t8y2/dbx/pull/9692)（OPEN，等待 review / merge / release），是当前唯一 canonical upstream contract：一期只请求 Estimated Plan（`EXPLAIN ...`）、权限 `host.plans:read`、方法 `host.getPlanCapabilities` / `host.explainPlan`、`mode=estimated`。Actual Plan / `EXPLAIN ANALYZE` / `host.plans:execute` / `host.getQueryContext()` / generic SQL execution **不属于一期**，已移入 Future / historical design。下游对齐说明见 [docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md](docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md)（PR #4 已合并）。

下表为 2026-09-18 审计快照（历史事实）；其中「当前 SQL / result-view」一项已由上游 #9599 修复，见下方上游状态。

| 能力 | 插件侧可达 | 状态 | 说明 |
| --- | --- | --- | --- |
| connectionId / database | ❌ | `INTERNAL_ONLY` | `host.getContext` 实测返回 `{}`；只有插件自有连接与 result-view 路径会带连接信息 |
| schema | ❌ | `INTERNAL_ONLY` | bridge 类型有 `schema?` 字段，但仓库内无任何生产者 |
| 当前 SQL | ❌ | `INTERNAL_ONLY` | result-view 设计上会传 `sql`，但该路径当前无法打开 |
| database type / version | ❌ | `INTERNAL_ONLY` | DBX 内部通过驱动探测或 SQL 获取 |
| 请求 DBX 执行 EXPLAIN | ❌ | `INTERNAL_ONLY` | 宿主方法注册表中无此方法 |
| Raw Plan / Estimated Plan | ❌ | `INTERNAL_ONLY` | DBX 内部可用（PG/MySQL 等） |
| Actual Plan | ❌ | `INTERNAL_ONLY`（PG/SQL Server）/ `NOT_AVAILABLE`（MySQL） | PG 有只读事务 + 回滚；MySQL 无 analyze 路径 |
| timeout / cancel | ❌ | `INTERNAL_ONLY` | 插件侧只有 sidecar RPC 超时（≤ 120s），与查询超时无关 |

审计环境：DBX `v0.6.16` browser-static（真实宿主实测）+ PostgreSQL 15.19（本地审计库，凭据不入库）+ `t8y2/dbx` `main @ f0342ad3` 源码审计。未验证项（MySQL 运行时、桌面版差异）已在审计文档第 7 节逐项标记。

附带发现：`result-view` 贡献在 `v0.6.16` 与审计时的 `main` 上无法打开工作台（`Plugin workbench '…' is unavailable`），已作为独立上游缺陷写入 Gap Proposal 附录 B。

上游状态（2026-09-20 复核 `t8y2/dbx` `main @ d7e1b47`）：该缺陷已提交为 [t8y2/dbx#9597](https://github.com/t8y2/dbx/issues/9597)，并由 [PR #9599](https://github.com/t8y2/dbx/pull/9599)（merge `4f3be8cc`）修复并合入上游 `main`；修复尚未进入任何正式 release（`v0.6.16` / `v0.6.17` 仍然受影响），需等待下一个 DBX 版本。

## 1. 完成度速览

| 能力 | 状态 |
| --- | --- |
| 官方 Svelte + Vite 项目骨架 | ✅ 已初始化 |
| UI 构建（`npm run build`） | ✅ 通过 |
| 打包（`dbx-plugin package`） | ✅ 通过 |
| `dbx-plugin dev` 本地开发主机 | ⚠️ 可用，但 Windows 需绕过上游 bug（见第 4 节） |
| `manifest.json` 合法性 | ✅ 通过（对上游 `main` 分支真实 schema） |
| Host Capability Audit（Phase 0） | ✅ 已完成（结论 BLOCKED，见第 0 节） |
| Audit Harness（开发/审计页） | ✅ 已保留为 UI 内的“宿主审计（开发）”视图（`src/components/HostAudit.svelte`；无 DBX 宿主时优雅降级） |
| Fixture-driven MVP UI（离线 / demo） | ✅ 已实现（Issue [#7](https://github.com/0verme/dbx-plugin-plan-detective/issues/7)：Fixture Selector / Plan Summary / Findings / Plan Tree / Node Inspector；不接 Host API） |
| Offline Plan Core（fixture-first） | ✅ 已实现（`src/core/**`，不依赖 DBX Host API） |
| native backend（Rust / Go） | ❌ 不存在（符合 Thin Plugin 原则） |
| 数据库驱动依赖 | ❌ 不存在（符合禁止清单） |
| AI / LLM 依赖 | ❌ 不存在 |
| Execution Plan Parsing | ✅ 已实现（离线，PostgreSQL 15.19 fixture） |
| DBX Estimated Plan Response Adapter（离线契约） | ✅ 已实现（Issue [#9](https://github.com/0verme/dbx-plugin-plan-detective/issues/9)：mock response → `RawPlanInput`，纯函数 / fail-closed；不接 Host API） |
| Plan Normalization | ✅ 已实现（公共字段 + `engineSpecific`） |
| Metrics Engine | ✅ 已实现（确定性基础指标，不含综合评分） |
| Hotspot Analysis | ⛔ 未实现（属于后续 Issue） |
| Rule-based Diagnosis | ✅ 已实现（3 条确定性规则：large-sequential-scan / expensive-sort / nested-loop-large-inner） |
| Findings + Evidence | ✅ 已实现（`info` / `warning` / `high`） |
| Plan Diff | ⛔ 未实现 |

> ⛔ 表示需要独立 Issue（Host 接入类还需等 t8y2/dbx#9675），**不是**待办遗留。
> Offline Core 的契约、阈值与 fixture 约定见 [docs/PLAN_INPUT_AND_FIXTURES.md](docs/PLAN_INPUT_AND_FIXTURES.md)；
> 启动条件、一期 / Future 边界见 [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) §2.1 与 §3。

### 1.1 Fixture-driven MVP UI 数据链路与边界（2026-09-20）

```text
fixtures/postgres/** → RawPlanInput → analyzePlan()（现有 Offline Core）→ src/lib/view-model.js → Svelte UI
```

- 代码：`src/App.svelte`、`src/components/**`、`src/lib/**`、`scripts/vite-plugin-fixtures.mjs`。
- Fixture 在构建期以虚拟模块嵌入（只含 `.plan.json` + 展示字段，不含 golden / `setup.sql` / 绝对路径），
  synthetic fixture 保持 synthetic 标识；UI 顶部明确标注 `Offline / Fixture Mode`。
- **边界确认**：未调用 `window.dbxPlugin.explainPlan()` / `host.getPlanCapabilities()`；未修改
  `manifest.json` 的 `engines.host_api`（仍为 `1`）；未新增 `host.plans:read`；未引入数据库 Driver；
  未修改 Core 契约 / 阈值 / golden。
- `window.dbxPlugin` 仅由开发用“宿主审计”视图使用，不再承担分析数据来源。
- 未来 #9692 合并 / release 后只把 Host 返回值交给已实现的 `dbx-adapter`（`rawPlan → RawPlanInput`，见 §1.2），
  现有 Core / view model / 组件不重写。

### 1.2 DBX Response Adapter Contract（2026-09-20，离线）

```text
Mock DBX #9692 Response → adaptDbxEstimatedPlanResponse() → RawPlanInput → 现有 Offline Core
```

- 代码：`src/core/adapter/dbx-plan-response.js`（纯函数，唯一的 DBX 感知层）；错误类型 `DbxPlanAdapterError`。
- 映射：`dbType: "postgres"` → `database: "postgresql"`；响应无 `mode` → `mode: "estimated"`；
  `format` 仅接受 `"json"`；`rawPlan` → `plan` 原引用直传；`dbVersion?` → `databaseVersion?`。
- Fail-closed：不支持的 dbType / format、`plan_not_json`、`truncated` / `plan_truncated` /
  `plan_rows_truncated` 全部返回稳定错误码；未知 warning 忽略、不 crash；错误信息不 dump rawPlan。
- 测试：`tests/core/dbx-plan-response.test.js`（happy path / failure path / 全部 estimated fixture 的
  mock response 与直接 fixture 分析结果等价）。
- **边界确认**：未调用 `window.dbxPlugin.explainPlan()` / `getPlanCapabilities()`；未修改 `manifest.json`
  的 `engines.host_api`；未新增 `host.plans:read`；未引入数据库 Driver；未建立连接 / 未执行 EXPLAIN；
  未修改 Core 契约 / 阈值 / golden。
- 契约细节：`docs/PLAN_INPUT_AND_FIXTURES.md` §2.1；真实 Host wiring 仍等待 #9692 merge / release。

## 2. 本次初始化的实测验证记录

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

## 3. Host API 现状（文档取证 + 真实宿主实测）

取证时间 2026-09-18，来源 `t8y2/dbx` 的 `main` 分支公开文档与源码，并在真实 DBX `v0.6.16` 宿主中现场验证（详见 [docs/HOST_CAPABILITY_AUDIT.md](docs/HOST_CAPABILITY_AUDIT.md)）：

- 前端沙箱公开桥接方法为 `ready` / `context` / `locale` / `theme` / `request` / `invoke` / `notify` / `onInit` / `onContext` / `onEvent` / `onBinary` / `sendBinary` / `readAsset` / `readAssetUrl` / `openWorkbench` / `openFilesystem` / `saveFile` / `copy` / `stream`（运行时 `Object.keys(window.dbxPlugin)` 实测）。
- 宿主方法注册表（`apps/desktop/src/lib/plugins/pluginHostBridge.ts`）只有 `host.getContext`、`ui.readAsset`、`host.copy`、`host.saveFile`、`host.openWorkbench`、`host.openFilesystem`、`host.reopenConnection`（仅 `main`，`v0.6.16` 未实现）、`backend.invoke` / `backend.notify` / `backend.sendBinary`。
- 公开的插件可回调宿主方法仅有 `host/requestUserInput`（Host API 1.1）。
- 公开 manifest 权限名称为 `host.events`、`host.binary`、`host.workbench`、`host.filesystem`、`host.network:<https origin>`。
- 上述公开 API 面中**没有** SQL 执行、EXPLAIN 或执行计划获取相关入口；28 个候选方法名在真实宿主中全部返回 `Unsupported plugin host method`。
- 独立开发主机（`dbx-plugin dev`）明确说明不模拟 native connection actions、query-result contributions 与 DBX component kit，不作为结论来源。

**审计结论（历史事实；2026-09-18）**：公开 Host API 中没有任何 SQL 执行 / EXPLAIN / 执行计划获取入口；"插件能否取得执行计划"已不再有未知，该缺口已正式提交为 [t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675) 并认领。当前 blocker 是**上游实现 / 合并进度**。审计清单见 [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md)。

按项目纪律，不自行实现数据库连接层或执行层；真实 Host 接入等待 #9675 落地。

## 4. 已知上游问题（已取证，未修复）

以下问题属于 `@dbx-app/plugin-cli` / 官方模板 / 上游仓库现状，**本次初始化未擅自修改**，等待决策。

### 4.1 `create` 不接受 `.` 相对路径（Windows 实测）

```text
$ dbx-plugin create . --template svelte ...
error: Project directory needs a UTF-8 name
```

- 实测：传绝对路径 `dbx-plugin create E:\...\<project> ...` 成功；传 `.` 必失败（纯 ASCII 参数与目录名同样失败，已排除编码因素）。
- 影响：官方文档给出的 `dbx-plugin create my-plugin` 类用法在 Windows 上不可用。
- 本次初始化绕过方式：使用绝对路径。

### 4.2 `manifest.json` 的 `$schema` 指向不存在的 ref

```text
https://raw.githubusercontent.com/t8y2/dbx/plugin-sdk-v1/plugins/manifest.schema.json
```

- 实测该 URL 返回 **404**。
- `plugin-sdk-v1` 在 `t8y2/dbx` 中**既不是分支也不是 tag**（API 查询均为 404）。
- `https://raw.githubusercontent.com/t8y2/dbx/main/plugins/manifest.schema.json` 返回 200，内容可正常校验本仓库 manifest。
- 影响：编辑器/校验器无法解析 manifest schema。未擅自改为 `main`。

### 4.3 发布 workflow 引用了不存在的 ref

`.github/workflows/plugin-release.yml`（官方模板原样生成）：

```yaml
uses: t8y2/dbx/.github/workflows/plugin-release-reusable.yml@plugin-sdk-v1
```

- `plugin-sdk-v1` ref 不存在（见 4.2），该 reusable workflow 在 `main` 上确实存在。
- 影响：发 release 时此 workflow 会因 ref 无法解析而失败。未擅自改为 `main`。

### 4.4 `dbx-plugin dev` 在 Windows 上无法执行 UI build 命令

配置 `[dev] ui_build = ["npm", "run", "build"]` 时：

```text
CMD.EXE was started with the above path as the current directory.
UNC paths are not supported.  Defaulting to Windows directory.
Error: EISDIR: illegal operation on a directory, lstat 'E:'
Build failed (exit 1)
```

- 根因：dev runtime 把 canonicalize 得到的 verbatim 路径 `\\?\E:\...` 作为子进程 cwd 传给 `cmd.exe`，而 cmd 不支持 UNC 路径。dev 自身日志亦印证：`"project":"\\\\?\\E:\\vbcoding\\..."`。
- 实测绕过：移除 `[dev]` 的 `ui_build` / `ui_watch` 后，dev host 正常启动并服务已构建的 `ui/`（`GET / → HTTP 200`）。
- 现状：仓库保留官方模板默认配置（在 Linux / macOS 上正常），Windows 下需手动临时移除该段，或改用 WSL。

### 4.5 template README 的相对链接在独立仓库中失效

官方模板 README 使用 `../../../../GETTING_STARTED.zh-CN.md` 指向 DBX 主仓内文件，在独立插件仓库中为坏链接。本仓库 README 已改写为上游公开地址。

### 4.6 版本差异观察

模板生成的 workflow 固定 `plugin-cli-version: 0.1.6`，本次初始化使用 `0.1.9`（两者在 npm 上均存在）。如后续出现打包行为差异，需先核对 CLI 版本。

## 5. 待办

1. ✅ Phase 0 Host Capability Audit 已完成（历史结论 BLOCKED，清单见 [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md)）；能力缺口已正式提交为 [#9675](https://github.com/t8y2/dbx/issues/9675)。
2. 上游反馈状态（2026-09-20 复核）：result-view 缺陷已提交 [#9597](https://github.com/t8y2/dbx/issues/9597) 并由 [#9599](https://github.com/t8y2/dbx/pull/9599) 修复合入上游 `main`（尚未进入 release）。Estimated Plan Host API 已正式提交为 [t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)，已由 `0verme` `/claim`，是当前唯一 canonical upstream contract；下游设计已收敛（[docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md](docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md)，PR #4 已合并；`docs/DBX_HOST_API_GAP_PROPOSAL.md` 已同步）。
3. 当前 blocker = #9675 的实现 / 合并。上游落地前**暂停真实 Host 接入**；不设计插件侧替代架构、不引入数据库 Driver。
4. 离线 Plan Core 已由 Phase 0B 落地（PR #6），不受 Host blocker 影响：契约与 fixture 约定见 [docs/PLAN_INPUT_AND_FIXTURES.md](docs/PLAN_INPUT_AND_FIXTURES.md)；`DBX Estimated Plan Response → RawPlanInput` adapter 契约已由 Issue [#9](https://github.com/0verme/dbx-plugin-plan-detective/issues/9) 离线实现（`src/core/adapter/`，mock response 即全链路可测）；#9692 落地后只把真实 Host 返回值交给该 adapter，不再重新设计下游。
5. Fixture-driven MVP UI 已由 Issue [#7](https://github.com/0verme/dbx-plugin-plan-detective/issues/7) 落地：可在无 DBX、无数据库环境下演示完整分析链路；后续 UI 扩展（Plan Diff / Canvas 等）仍需独立 Issue。
6. 就第 4 节上游问题决定处理方式：本地修正 ref / 提 Issue 到 `t8y2/dbx` / 等待上游修复。

## 6. 相关文档

- [README.md](README.md) —— 项目定位与开发方式
- [AGENTS.md](AGENTS.md) —— 仓库约束与红线
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构边界与职责划分
- [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) —— 决策记录、Phase 0 审计清单与结论、Fixture 策略
- [docs/PLAN_INPUT_AND_FIXTURES.md](docs/PLAN_INPUT_AND_FIXTURES.md) —— RawPlanInput / NormalizedPlan / Metrics / Rules / Findings 契约与 Fixture 约定
- [docs/HOST_CAPABILITY_AUDIT.md](docs/HOST_CAPABILITY_AUDIT.md) —— Phase 0 审计矩阵、逐项证据、运行时实测、复现步骤
- [docs/DBX_HOST_API_GAP_PROPOSAL.md](docs/DBX_HOST_API_GAP_PROPOSAL.md) —— 上游能力缺口、一期 Estimated Plan API 提案、Future / historical design 记录
- [docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md](docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md) —— downstream design note；canonical upstream contract 为 [t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)
