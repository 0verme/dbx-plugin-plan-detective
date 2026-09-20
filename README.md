# DBX Plan Detective

DBX Plan Detective 是一个 DBX 插件，用于 SQL 执行计划的解析、性能诊断与 Plan Diff 分析。

| 项目 | 值 |
| --- | --- |
| 插件 ID | `io.github.0verme.plan-detective` |
| Publisher | `0verme` |
| 当前版本 | `0.1.0` |
| 模板 | DBX 官方 `svelte`（Svelte + Vite，`universal`，frontend-only） |

## 项目定位

> **DBX provides the database capabilities.**
> **Plan Detective provides the execution-plan intelligence.**

DBX 负责数据库连接、Credential、驱动、SQL 执行和 Host 能力；
Plan Detective 负责理解和分析执行计划。

## 目标能力

- Execution Plan Parsing ✅（离线，PostgreSQL）
- Plan Normalization ✅（离线，PostgreSQL）
- Performance Metrics ✅（确定性基础指标，不含综合评分）
- Hotspot Analysis ⛔
- Rule-based Diagnosis ✅（3 条确定性规则）
- Findings + Evidence ✅
- Plan Diff ⛔

> ✅ 为 **Phase 0B Offline Core**（fixture-first，不依赖 DBX Host API）；⛔ 为未实现，
> 仍需等待上游能力落地（`Phase 0 completed · Upstream implementation in progress`）。
> 实际完成度以 [STATUS.md](STATUS.md) 与 [docs/PLAN_INPUT_AND_FIXTURES.md](docs/PLAN_INPUT_AND_FIXTURES.md) 为准。

## 首批目标数据库

- PostgreSQL
- MySQL

DWS 暂时视为 PostgreSQL-family 的后续兼容目标，当前不作为第一阶段独立 Adapter。

## 当前不依赖 AI

当前项目不依赖 AI：仓库中不存在 AI SDK、LLM 调用或任何模型凭据。

未来 AI 只能作为 Explain / Rewrite 辅助层，不能成为 Rule Engine 的真相来源。

## 架构原则

1. **Thin Plugin** —— 只提供执行计划智能，不重复实现 DBX 已有基础设施。
2. **DBX 已有能力优先复用** —— Connection、Credential、驱动、Query Context、SQL 执行、Timeout、Cancel 均属于 DBX。
3. **frontend-only** —— 当前不引入 Rust / Go sidecar，也不修改 DBX Core。
4. **不提前架构** —— 只有确认 Host API 无法满足需求后，才讨论 native backend 或 DBX Core 变更。

当前阶段明确**不**引入：PostgreSQL driver、MySQL driver、sqlx、JDBC、自定义连接池、Credential 管理、SSH Tunnel、自定义数据库执行层、AI SDK、LLM、自动 SQL Rewrite、Rust backend、Go backend。

完整边界说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 当前进度

当前状态：**Phase 0 completed · Upstream implementation in progress**。Phase 0 Host Capability Audit 已于 2026-09-18 完成（历史结论 **BLOCKED — Host API capability gap**）：

```text
DBX 内部有执行计划能力
≠
第三方插件可通过公开 Host API 取得执行计划
```

在真实 DBX `v0.6.16` 宿主中，`host.getContext` 返回空上下文，全部查询/计划/上下文/cancel/timeout 方法名均不存在；DBX 内部 EXPLAIN 可用但插件不可达。完整矩阵与证据见 [docs/HOST_CAPABILITY_AUDIT.md](docs/HOST_CAPABILITY_AUDIT.md)。

该能力缺口已正式提交为 upstream Issue **[t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)**（OPEN，已由 `0verme` `/claim`），是当前唯一 canonical contract：一期只请求 **Estimated Plan**（`EXPLAIN ...`）—— 权限 `host.plans:read`、方法 `host.getPlanCapabilities` / `host.explainPlan`、`mode=estimated`。Actual Plan / `EXPLAIN ANALYZE` / `host.plans:execute` / `host.getQueryContext()` 不属于一期。详见 [docs/DBX_HOST_API_GAP_PROPOSAL.md](docs/DBX_HOST_API_GAP_PROPOSAL.md) 与 [docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md](docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md)。

当前 blocker 是 #9675 的实现 / 合并：真实 Host 接入需等待上游落地，本仓库**不会**自行引入数据库 Driver / 连接池 / 凭据管理来绕过。**但这不阻止离线内核开发**：Phase 0B 已落地与 DBX 完全解耦的 fixture-first 分析内核：

```text
PostgreSQL fixture → RawPlanInput → Parser → NormalizedPlan → Metrics → Rules → Findings
```

- 实现：`src/core/`；契约与阈值：[docs/PLAN_INPUT_AND_FIXTURES.md](docs/PLAN_INPUT_AND_FIXTURES.md)
- fixture：`fixtures/postgres/`（19 个：17 真实采集 + 2 synthetic），带四 stage golden test
- 与 DBX 的衔接点只有未来的 `dbx-adapter`：将 #9675 的 `rawPlan` 映射为 `RawPlanInput`，
  内核不感知 connectionId / credential / Host API

离线验证（无需 DBX、无需数据库、无需 `npm install`）：

```bash
npm test                                  # 契约 / parser / normalize / metrics / rules / golden
npm run analyze -- estimated/seq-scan     # 对单个 fixture 跑完整 pipeline
```

## 开发

安装依赖并启动独立浏览器开发主机（Node.js 22+）：

```bash
npm install
dbx-plugin dev --path . --port 5190
```

UI 从 `src/` 编译到 `ui/`。前端通过宿主注入的 `window.dbxPlugin` 桥接读取 DBX 上下文、语言、主题并调用宿主方法。最终集成测试请使用真实 DBX 宿主。

> `ui/` 是**必须入库的发布产物**：DBX 官方 release workflow 不执行 `npm install` / `npm run build`，直接运行 `dbx-plugin package .`，因此修改 `src/` 后需要重新构建并提交 `ui/` 变更。`.gitignore` 只忽略 `dist/`、`.dbx-dev/`、`node_modules/` 等本地生成物，不忽略 `ui/`。详见 [AGENTS.md](AGENTS.md) 的 Git 规则。

构建未签名的 universal 候选包：

```bash
dbx-plugin package .
```

产物为 `dist/` 下的 `.dbxp` 与对应 artifact metadata。

## 目录结构

```text
.
├── .github/workflows/     # 官方模板生成的发布工作流
├── assets/                # 插件图标等静态资源
├── docs/                  # 架构 / 计划 / 契约 / Phase 0 审计
├── fixtures/              # 离线执行计划样本（postgres 已建立 / mysql 占位）
├── scripts/               # 开发与测试脚本（golden 生成、fixture 分析）
├── src/                   # Svelte 前端源码
│   ├── core/              # Plan Core：无 UI / 无 DBX / 无数据库依赖
│   └── App.svelte         # Phase 0 Audit Harness（开发用）
├── tests/                 # node:test，离线运行
├── manifest.json          # DBX 插件清单
├── dbx-plugin.toml        # 打包与开发配置
└── STATUS.md              # 当前状态与已知问题
```

`fixtures/` 与 `docs/` 不参与打包：`dbx-plugin.toml` 的 `[package] include` 只包含 `assets` 与 `ui`。

## 发布

发布未签名候选包供审核。若本仓库已注册 `autoUpdate: true`，DBX Store 会自动创建或更新候选 PR；否则向 `t8y2/dbx-store:main` 提交一个候选 PR，附带 release 与 artifact metadata。

不要向 `t8y2/dbx` 提交普通插件源码：该仓库只接受插件宿主、SDK、CLI、schema、文档与官方示例的变更。

## 文档

- [STATUS.md](STATUS.md) —— 当前状态、上游 #9675 contract、已验证项与已知问题
- [docs/HOST_CAPABILITY_AUDIT.md](docs/HOST_CAPABILITY_AUDIT.md) —— Phase 0 Host Capability Matrix、逐项证据、真实宿主实测
- [docs/DBX_HOST_API_GAP_PROPOSAL.md](docs/DBX_HOST_API_GAP_PROPOSAL.md) —— 上游能力缺口、一期 Estimated Plan API 提案、Future / historical design 记录
- [docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md](docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md) —— downstream design note（canonical upstream contract：[t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)）
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构边界与职责划分
- [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) —— 已确认决策、Phase 0 审计清单与结论、一期 / Future 边界、Fixture 策略
- [docs/PLAN_INPUT_AND_FIXTURES.md](docs/PLAN_INPUT_AND_FIXTURES.md) —— RawPlanInput / NormalizedPlan / Metrics / Rules / Findings 契约与 Fixture 约定
- 上游插件开发指南：<https://dbxio.com/en/docs/plugin-development>
