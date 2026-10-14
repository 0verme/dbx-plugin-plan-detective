# Plan Detective v0.7.0 AI Tool：保留契约与暂缓发布状态

关联：[Issue #66：将执行计划分析能力暴露为 DBX AI Agent Tool](https://github.com/0verme/dbx-plugin-plan-detective/issues/66)

## 当前状态

- 已发布的 v0.7.0 manifest 注册了 Node.js backend。其 launcher 检查系统 Node.js 22+，不满足时仅 backend sidecar 无法启动；已发布的 v0.7.0 `.dbxp` 仍保持这个行为。
- 该 sidecar 不是 UI / Plan Core 的依赖。WorkBench、查询结果入口、DBX Host Plan API、解析、Findings、Hotspots、i18n 和复制 AI Prompt 的普通路径不调用 backend。代码结构因此不支持“没有 Node.js 整个插件都无法使用”的结论；真实 Desktop 安装 / 打开流程仍需实测。
- 本修复的发布候选采用 frontend-only manifest 与 DBX 官方 CLI，只将 `assets/`、`ui/` 打入 universal `.dbxp`。`backend/plan-detective-runtime.mjs`、`src/ai-tool/**`、本契约和测试留在仓库，但不在正式包注册或运行 AI Tool。
- 既有 Host 契约保持：插件 ID `io.github.0verme.plan-detective`、`host.plans:read`、DBX `>=0.6.23`、Host API `^1.2`。Node.js 22+ 仅用于开发 / CI 构建，不是 frontend-only 包的运行时要求。

## 上游复核（2026-10-14）

- Plan Detective 基线：`origin/main` `85fc63651c119fb81b44ec70de92603e2f945990`。
- DBX 上游：`t8y2/dbx` 最新 `main` `0db01f7f284ec6b0b090fe7369de7d05c37b25b0`；最新发布版为 `v0.6.42`。
- 插件 AI Tool Issue #66 仍开放，既有记录明确要求等真实 Desktop runtime gate；未发现此后消除下列集成限制的上游变更。

### 普通数据库连接上的 Tool binding 尚不支持

DBX `crates/dbx-core/src/ai/plugin_tools.rs` 的 `open_plugin_connections()` 仅从 `PoolKind::PluginConnection` 收集插件连接。Agent Tool 调用时还会重新读取相同插件连接的 lifecycle。Plan Detective 没有数据库连接 provider，也不应伪造连接或凭据，因此其 tool 不会绑定到普通 PostgreSQL / MySQL / SQL Server 等原生 DBX Agent 连接。

### `explain_query` 尚无结构化 Estimated Plan handoff

DBX `crates/dbx-core/src/ai/agent_tools.rs` 将 `explain_query` 的结果格式化为 Markdown 文本，放入模型可见的 `ToolResult.content`。虽然 `ToolResult` 另有 `explain_data`，上游代码注释明确它只供前端展示、Agent follow-up 只传 `content`；这不是 Plan Detective 所需的 `{ dbType, dbVersion?, format, rawPlan, truncated, warnings }` contract。不能把 Markdown 表格作为原始 JSON / XML / text plan 来解析。

因此在当前上游状态下，保留 sidecar 注册不能使目标 Agent 链路在普通 DBX 数据库连接上可用。不得声称 AI Tool 已验证，也不得在插件内重新调用 Host Plan API 获取计划以规避这个限制。

**恢复 runtime 注册的条件：** DBX 上游支持普通已打开 Agent database connection 的 plugin tool binding（不向插件暴露凭据），并为 `explain_query` 提供可传递、明确包含数据库类型 / 格式 / 原始计划 / 截断与警告信息的结构化 Estimated Plan contract；之后还必须完成真实 Desktop 端到端 smoke。恢复前不要求普通用户安装 Node.js。

## 保留的 `analyze_estimated_plan` 实现契约

仓库中的 `src/ai-tool/**` adapter、`backend/plan-detective-runtime.mjs` 与相关单元测试保留，用于验证未来恢复条件及防止逻辑漂移；它们不再被 frontend-only `.dbxp` 打包。其边界仍是：

- 唯一工具名 `analyze_estimated_plan`，`annotations.readOnlyHint: true`；只分析已取得的完整 Estimated Plan，不执行 SQL、不连接数据库、不访问 Host API、网络、credential 或 connection lifecycle。
- `dbType`、`mode=estimated`、`format=json|text|xml`、`rawPlan`、`truncated`、`warnings` 是显式输入；不从 plan 猜数据库类型，不接受 Actual Plan / EXPLAIN ANALYZE、截断 / 不完整 / malformed plan、Markdown 表格或连接凭据。
- `rawPlan` 最大 100,000 字符，超限 fail closed；可选 SQL 只作有限长度 provenance，不执行、不回显；不接受 `connectionId` 等额外字段。
- 映射为 `RawPlanInput` 并调用既有 Plan Core；输出复用 `buildAiAnalysisPrompt()`、Finding / Hotspot presentation，最大 24,000 Unicode code points、Evidence 预算 5,000 字符，不回传 raw plan、SQL、DB version、credential 或 lifecycle。
- 输出必须说明 Estimated Plan 不等于实际运行性能、cost 不等于 elapsed time、Finding / Hotspot 是带 caveat 的推断，没有 Finding 不代表 SQL 没问题。
- AI Tool 不增加权限；`host.plans:read` 仅供 UI 的 DBX Host Plan API 使用，绝不新增 `host.data:read`。

## frontend-only 打包

正式候选 manifest 只保留 `entrypoints.ui`。`dbx-plugin.toml` 的 package inputs 仅为 `assets` 与 `ui`，Node.js 项目 packager 不再创建包；`npm run package` 构建静态 UI 后调用项目锁定版本的 DBX 官方 `dbx-plugin package`，生成 universal `.dbxp` 与 artifact metadata。官方 CLI 支持没有 backend 的 frontend-only manifest，因此没有继续携带 launcher、无用途 sidecar 文件或自定义 ZIP packager 的理由。

Release workflow 由 `npm ci` 安装本地锁定的官方 CLI，仅在 CI 构建使用 Node.js。包身份、版本与 artifact SHA-256 / size 校验保留。正式插件 ID、权限、Host API 版本和完整静态 UI 不变。

## Desktop 验收状态

**真实 DBX Desktop：`NOT RUN — awaiting manual DBX Desktop validation`**。本环境没有 DBX Desktop；Node.js 下的单元测试与包检查不等同于无 Node.js Desktop 验证。

人工验收应在未安装 Node.js 的 Windows、macOS、Linux 环境分别确认：

1. 安装 frontend-only `.dbxp` 并从插件中心打开 Plan Detective。
2. 从 DBX 查询结果上下文打开，并从 Workbench 打开。
3. 用已打开连接获取和分析 Estimated Plan；查看计划树、Findings、Hotspots。
4. 切换简体中文 / English，复制 AI 分析 Prompt。
5. 关闭并重新打开插件，再重启 DBX 并重复普通分析路径。
6. 确认这些操作不提示安装 Node.js / 配置 PATH；Built-in AI Tool 不作为可用功能注册。

若后续要恢复 AI Tool，另需按 Issue #66 gate 确认工具展示、read-only 标记、普通原生连接绑定、结构化 plan handoff、最终 Agent 输出与 DBX 重启后状态；上游 gap 未补齐前不把 Agent 步骤记作通过。
