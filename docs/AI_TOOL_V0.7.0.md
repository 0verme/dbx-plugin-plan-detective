# Plan Detective v0.7.0 AI Tool：契约与 runtime gate

关联：[#66 feat: 将 Plan Detective 执行计划分析能力暴露为 DBX AI Agent Tool](https://github.com/0verme/dbx-plugin-plan-detective/issues/66)

## 审计基线

- Plan Detective `origin/main`：`7b17560e2144aa6a3374d0400b85afd752a0c723`，版本 0.6.7。
- t8y/dbx 最新 `main`：`adaaec5a3ca348448aaae15d0046a2ac530b03c2`；截至审计最新 DBX release 为 0.6.26。DBX v0.6.23 release notes 首次列出插件 AI tools。
- 当前插件此前只有 UI entrypoint，`[package].include = ["assets", "ui"]`，无 backend；已有 permission 为 `host.plans:read`，Host Plan API 需要 Host API 1.2。

## 确定的上游 sidecar contract

DBX plugin runtime 向 sidecar 发送 `plugin/initialize`，校验其返回的 protocol version 与 manifest `id/version`。Built-in AI tools 使用：

```text
mcp/tools { connectionId? }
→ { tools: [{ name, description, inputSchema, annotations? }] }

mcp/call { tool, arguments, lifecycle }
→ { content: [{ type: "text", text }], isError }
```

只有 `annotations.readOnlyHint: true` 被当作只读，其他 tool 按调用逐次要求用户审批。用户必须在 Plugin Center → Installed → Built-in AI tools 显式启用。最新 DBX sidecar JSONL 单条消息上限为 8 MiB；sidecar stdout 只用于 JSONL，诊断走 stderr。

## 两个已验证 upstream blocker

1. **普通原生连接上无法发现 / 执行此插件 tool。** DBX 当前 `discover_plugin_tools()` 从 `PoolKind::PluginConnection` 列举连接，并且 `execute_plugin_tool()` 在调用前重新查找插件 connection 的 lifecycle。Plan Detective 不实现数据库 connection provider，因此普通 PostgreSQL / MySQL / SQL Server Agent connection 不会绑定本插件工具。Plugin Center 的工具预览可以直接询问 sidecar，但这不代表 Agent 会把工具加入该原生连接的 tool set。
2. **explain_query 当前没有可交接的 structured raw-plan ToolResult。** DBX 内置 Agent `explain_query` 的模型可见 `ToolResult.content` 是 query result 的 Markdown 表格文本；structured `explain_data` 是 ToolResult 中供前端显示的附加字段，不是传给模型的结构化 raw plan。Oracle 分支也返回 plan text。此 Agent contract 与 Plan Host API 的 `PluginPlanResult` `{dbType, dbVersion?, format, rawPlan, truncated, warnings}` 不同。Markdown 表格内容不能安全地当作原始 JSON/XML/text plan 解析。

上述限制依据 t8y/dbx 当前 `crates/dbx-core/src/ai/plugin_tools.rs`、`crates/dbx-core/src/ai/agent_tools.rs` 和 `crates/dbx-ai-provider/src/agent_events.rs`。因此不能承诺完整链路已经运行；不允许插件在 sidecar 中调用 Host Plan API 再执行一次 EXPLAIN 来绕过。

**最小上游建议：** (a) Built-in AI plugin tools 支持绑定普通、已打开的 Agent database connection，并只暴露非敏感的连接类型上下文，允许无 plugin-owned connection / 无 credential lifecycle 的只读工具；(b) `explain_query` 向 Agent 暴露有明确定义的 structured Estimated Plan result，包含 DBX database type、format、raw plan、truncation / warnings，并允许后续工具将该结果作为输入。无需开放 `host.data:read`。

## 插件 Tool contract

唯一工具 `analyze_estimated_plan`：

- `dbType`：显式 DBX database type（不允许从 plan 推测）；OceanBase MySQL 仅使用显式 `dbVersion` 中的产品标识区分。
- `mode`：必须是 `estimated`；Actual Plan / `EXPLAIN ANALYZE` 不接受。
- `format`：`json | text | xml`。
- `rawPlan`：已完整取得的原始计划；JSON 格式传 JSON 文本，另外两种传原始文本。上限 100,000 字符，超限 fail closed，不静默截断。
- `truncated` 与 `warnings`：必须显式传入；被标记截断或携带 truncation / incomplete warning 时拒绝分析；安全格式化的其他 source warning codes 会保留在模型 context 中。
- `sql`：可选 provenance，仅接受有限长度，不执行、不回显。`connectionId`、credentials、connection string 等额外字段拒绝。
- 工具 description 明确指出当前 DBX Agent `explain_query` 没有 structured raw-plan handoff contract；若没有完整 raw plan 与 provenance，不应调用本工具。
- AI Tool adapter 位于 `src/ai-tool/**`，映射为 `RawPlanInput` 后调用现有 `analyzePlan()`。UI 的 `runHostAnalysis()` 使用 `analyzeRawPlan()`，两者进入同一 parser registry 与分析管线；针对同一 fixture 验证 metrics/findings/hotspots 相等。
- 输出复用 `buildAiAnalysisPrompt()`、finding/hotspot presentation，最大 24,000 Unicode code points、Evidence 预算 5,000 字符。不序列化 raw plan；不回显 SQL / DB version / lifecycle；明确 Estimated ≠ 实际运行、cost ≠ elapsed time、finding 是推断、无 finding 不等于 SQL 无问题。

## 权限与兼容性

- AI Tool 不取计划、不访问 Host bridge、数据库或网络，不读业务数据；不增加 `host.data:read` 或其他权限。现有 `host.plans:read` 保留给既有 UI Host Plan 路径。
- Host API 版本仍为 `^1.2`。manifest DBX 最低版本调到 `>=0.6.23`（该 release 起提供 plugin AI tool 能力）。
- Node backend 使用系统 Node.js 22+；没有运行时 npm dependency。Unix/Windows launcher 与所有 sidecar 依赖随 `.dbxp` 打包，包内提供最小 `{"type":"module"}` descriptor 供 `.js` runtime modules 加载，不携带开发依赖。DBX 官方 CLI package 当前只从 `[backend]` 编译 Rust/Go，因此发布 workflow 调用仓库自有 `npm run package`（按 SchemaSeed 的已验证 Node package 模式实现，不存在跨仓 runtime 依赖）。

## DBX Desktop smoke checklist（尚未运行）

1. 安装 `0.7.0-rc.1`。
2. Plugin Center → Installed，确认 Plan Detective 出现 Built-in AI tools 区域。
3. 确认“查看工具”列出 `analyze_estimated_plan`，并标为 read-only。
4. 打开一个受支持的原生数据库连接。
5. 开启 Built-in AI tools，切换 DBX AI 的 Agent mode。
6. 提问：“分析这条 SQL 的执行计划，指出主要风险和证据”。
7. 仅当上游提供普通 Agent connection tool binding 与 structured Estimated Plan handoff 后，验证 Agent 能将 `explain_query` 结果传给 `analyze_estimated_plan`，最终回答引用 findings / hotspots / evidence。
8. 确认不触发写操作确认、不申请 `host.data:read`。
9. 重启 DBX，确认设置与工具仍正常。

当前按 upstream blocker 预期，第 4–7 步会阻塞：原生连接不参与 DBX plugin tool discovery，且 explain_query 没有模型可直接传递的 structured raw plan。实际执行前不得将结果描述为通过；若仍阻塞，记录 `BLOCKED — upstream capability gap`，由 DBX 上游补齐后再完成 smoke。正式 0.7.0 发布以 smoke 通过为 gate；本 PR 只准备 `0.7.0-rc.1`。
