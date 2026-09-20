# AGENTS.md

本文件约束在本仓库中工作的 AI agent 与自动化流程。

## 项目身份

- 项目：DBX Plan Detective
- 插件 ID：`io.github.0verme.plan-detective`
- 类型：独立 DBX 插件（frontend-only，Svelte + Vite，`universal` 包）
- **不是** DBX 主仓（`t8y2/dbx`）的一部分

## 架构红线（必须遵守）

1. **Thin Plugin** —— 只做执行计划智能。
2. **DBX 已有能力优先复用** —— Connection、Credential、Database Driver、Query Context、SQL Execution、Timeout、Cancel、Database Type / Version、Explain execution、基础安全控制均属于 DBX。
3. **frontend-only** —— 当前不引入 native backend。
4. **不调内部接口** —— 只能使用公开的 Plugin Host API。不得为了绕过插件边界而调用 DBX 未公开的内部接口。
5. **不提前架构** —— 不为"未来可能需要"增加复杂架构。

## 禁止引入的依赖与实现

未经明确 Issue 与架构结论，禁止添加：

- PostgreSQL driver / MySQL driver / sqlx / JDBC
- 自定义数据库连接池、自定义数据库执行层
- Credential 管理、SSH Tunnel
- AI SDK、LLM、任何模型推理调用
- 自动 SQL Rewrite、自动调优、自动建索引、自动执行 SQL
- Rust backend、Go backend

禁止顺手实现（均需独立 Issue）：Rule Engine、Metrics Engine、Plan Diff、Plan Canvas、PostgreSQL parser、MySQL parser、数据库连接层。

## 必须区分的能力层级

```text
DBX internal capability      ≠  Plugin Host public capability
```

"DBX 内部已经存在某能力"**不等于**"插件 Host API 已经公开该能力"。
任何以"DBX 已经有了，所以插件可以直接用"为前提的实现，都必须先在 `docs/PROJECT_PLAN.md` 的 Phase 0 审计中取得证据。

## 事实与证据要求

- 涉及 Host API 能力的结论，必须给出可复现证据（文档链接、命令、实际输出）。
- 不得把猜测写成事实。未验证项在文档中标记为"未验证"。
- 不使用伪造的执行计划样本冒充真实数据；样本必须放在 `fixtures/` 并注明来源与是否经过裁剪。

## 开发与验证

- 安装依赖：`npm install`
- 构建：`npm run build`
- 本地开发：`dbx-plugin dev --path .`
- 打包：`dbx-plugin package .`
- Node.js 22+ 是 `dbx-plugin dev` / `package` 的运行时前提。

开发阶段只运行与本次改动直接相关的最小验证，不要运行 DBX 主仓全量测试。

## 打包边界

`dbx-plugin.toml`：

```toml
[package]
include = ["assets", "ui"]
```

`docs/`、`fixtures/`、`src/`、`node_modules/` 不会进入 `.dbxp`。向 `assets/` 或 `ui/` 添加内容前，确认其确实需要随包分发。

`ui/` 由 `npm run build` 生成，但**必须入库**（见下方 Git 规则）；它是发布产物，不是可忽略的本地生成物。

## 语言规则

- 面向用户与文档的自然语言默认使用简体中文。
- 代码、命令、路径、API 名称、日志与报错原文保持原样，不翻译。
- 常用技术术语保留英文原文（PostgreSQL、pytest、sidecar、manifest 等）。

## GitHub UTF-8 约束

- 所有 GitHub PR / Issue / Release 的中文内容必须保持 UTF-8。
- 中文长正文不允许通过 Shell `--body "..."` 直接传递；必须写入 UTF-8 文件后使用 `--body-file`。
- Windows 环境写文件必须显式使用 UTF-8（例如 `[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))`）。
- 创建或修改 GitHub 内容后必须反查校验中文未损坏。

## Git 规则

- 只提交与当前任务直接相关的文件，禁止 `git add .` / `git add -A`。
- 不提交本地生成物：`dist/`、`.dbx-dev/`、`node_modules/`（已由 `.gitignore` 覆盖）。
- **例外：`ui/` 必须入库。** DBX 官方 release workflow 不执行 `npm install` / `npm run build`，直接运行 `dbx-plugin package .`；缺少 `ui/` 会因 `manifest UI entry 'ui/index.html' does not exist` 打包失败。因此修改 `src/` 后必须重新 `npm run build` 并提交 `ui/` 的变更，不要将 `ui/` 加入 `.gitignore`。
- 发现 `.env`、密钥、Token、私钥或真实连接串时，停止提交并提醒用户。
- 不执行 force push，不删除远程内容。
- 不修改 `t8y2/dbx` 仓库。
- 行尾统一为 LF（见 `.gitattributes`）。
