# Issue #72 / PR #93 快照保存端到端诊断

## 当前结论

- **Windows DBX Desktop 故障根因：UNKNOWN / NOT VERIFIED。** 本次 Agent 环境为 Linux，不具备 Windows DBX Desktop GUI，也没有用户设备的安装记录、Host 权限状态或真实 Host Storage 调用日志。自动化模拟不能证明真实 Host 写入、历史读取或重启恢复成功。
- 本轮不修改 Snapshot Schema v1、Storage key、数据一致性协议或 UI 入口结构；不重试 `storage.set`。仅增加运行会话内的诊断追踪、复制入口、包构建指纹及针对性模拟测试。
- PR #93 当前基线为 `5dad75a59eea6857f5a45a2fdcf63cb10dc7aaf3`；该 HEAD 中 `manifest.json` 已声明 `host.storage`。这只证明仓库源码/候选包，不证明用户当前安装了该包或该权限已生效。

## 诊断追踪行为

- 每次确认保存创建唯一 `traceId`；会话生命周期和历史读取也有独立 trace。保存 trace 缓存最多 8 条，每条最多 128 个事件；会话事件最多 128 条；复制 JSON 上限 48 KiB。数据只驻留当前插件 UI 会话，不写入 Host Storage，不访问外部日志服务。
- 每个异步阶段输出 `*_START` 与 `*_END` 事件。START 包含 `status: pending`、单调计时的相对 `started`；END 包含 `finished`、`durationMs`、`status`。Promise 保持 pending 时保留最后 START，可直接区分卡在 Store load、Host get、set、读回核验或历史 refresh。
- 覆盖保存按钮点击/表单提交/原生校验/save gate、Snapshot 创建、Repository save、Store load/validate、Host Storage get/set、写后读回、历史初始化和手动刷新、Host bridge 初始化、Storage capability/manifest 权限声明、权限状态以及保存按钮 disabled 状态变化。
- Host permission 状态由公开 Storage API 的结果推断：`not-verified`、`usable` 或 `denied`。Host 没有公开权限查询 API，因此不将 manifest 声明冒充为“已授予”。DBX 版本仅从明确的 Host version 字段或 User-Agent 版本标记提取；否则导出 `unknown`，需用户从 DBX Desktop About 页面确认。
- 日志只包含插件版本、源码/构建 fingerprint、非敏感 manifest 权限、能力布尔值、稳定错误码、阶段和固定脱敏错误描述。不会包含 SQL、Raw Plan、用户名、连接凭据、用户备注、Storage key/value 或原始 Host 错误文本。
- Host Storage 写入长时间无响应时 UI 显示 `UNKNOWN/PENDING` 并禁止重复提交。不会用 Promise race 将写入判为失败，也不会自动重试 set。set 已返回但读回不能确认时，现有安全只读历史核验路径仍生效。

## 候选包证据（Linux 自动构建）

- 开发包：`dist/io.github.0verme.plan-detective-0.7.1-universal.dbxp`
- 版本：`0.7.1`（unsigned review/development candidate，不是正式发布）
- UI build fingerprint：`sha256:d57f3261ed062b233073fa6cc20bfd9c459488de8560710f5c95fa7d7cf9160b`
- `.dbxp` SHA-256：`2ca450c20a26b9272f3bf8817c45f3684c9992bc8e0fb6d155878dc3b8bdadc0`
- 包内 manifest permissions：`host.plans:read`、`host.storage`
- 包含 UI entrypoint；无 backend entrypoint、Node runtime 或系统 Node.js 运行依赖。
- `npm run package` 会重新计算源输入 fingerprint 并核对已生成 UI bundle。已验证候选包 UI bundle 含当前源码 fingerprint；用户复制的运行时 fingerprint 可与本节候选值比较。此核对不能识别用户设备当前安装了哪个包。

## 验证状态

- 自动化模拟：`npm test` **1422/1422 PASS**。覆盖正常保存、Storage capability 缺失、权限拒绝、get/set pending、读回不匹配、历史刷新失败、UI 状态更新失败、并发重复提交、非 structured session、空历史、原生表单校验、脱敏及 fingerprint 不匹配。
- `npm run build`：PASS。
- `npm run package`：PASS；unsigned candidate；包内 manifest 与 build fingerprint 核对通过。
- `npm audit --audit-level=high`：0 vulnerabilities。
- `git diff --check`：PASS。
- **真实 Windows Desktop 保存、历史读取及 DBX 重启恢复：NOT VERIFIED。** 不得据此标记修复成功或 READY TO MERGE。

## Windows 人工验证（不超过 5 步）

1. 在 DBX Desktop 插件管理页安装/更新以上 `.dbxp`；记录 DBX Desktop About 版本，并确认已安装包 SHA-256 与上面的候选包一致。若客户端拒绝同版本替换，先不要绕过版本/签名保护，反馈安装页的安全错误。
2. 打开 PostgreSQL 查询结果并完成一次成功的 structured Estimated Plan；打开快照保存，输入名称/备注并确认保存。等待 UI 成功或 `UNKNOWN/PENDING` 提示；pending 时不要重复点击。
3. 点击快照区域的 **复制诊断日志 / Copy diagnostic log**。若复制按钮报告无事件或复制失败，记录反馈，不打开开发者工具也不要手动导出 Storage 内容。
4. 打开历史并手动刷新，确认新记录可读；关闭并重启 DBX Desktop，再打开历史确认该记录恢复。
5. 将复制的脱敏 JSON、DBX About 版本、Installed 页面显示版本及候选包 SHA 一并回复到 PR #93/Issue #72；不要附 SQL、Raw Plan、连接信息或备注原文。

只有真实 Windows 证据同时确认保存成功、历史可读和 DBX 重启后恢复，才可解除 BLOCKED。