# Issue #72 / PR #93 快照保存诊断记录

此记录只包含源码、包元数据与自动化测试证据；不包含 SQL、Raw Plan、连接信息或用户快照内容。

## 结论边界

- **Windows 安装环境的实际 Root Cause：NOT VERIFIED。** 当前运行环境是 Linux，未挂载 Windows 文件系统（`/mnt` 为空、`/mnt/c` 不存在），也没有 DBX Desktop / `dbx` CLI。因而无法检查用户当前已安装的 `.dbxp`、DBX 版本、Host Storage 权限授予状态或该次操作的 Host 日志。不得把模拟 Storage 测试写成真实 Host 写入成功。
- 可确认的源码缺陷是：PR #93 前的 `SnapshotManager.svelte` 对失效保存前置条件直接 `return`，没有说明原因；保存成功后还要等待历史刷新才给成功反馈。它们可能造成“点击后没有可见结果”，但**没有证据证明它们就是 Windows 报告的唯一触发原因**。
- PR #93 已把保存前置条件转为可见错误、分离保存错误与历史管理错误、在确认写入后先反馈成功而不等待列表刷新；后续修复也保证保存 pending 时不能关闭表单。Host 永不返回时页面保留 loading 并显示等待诊断，不会把 timeout/未知结果当作成功，也不会自动重发写入。

## 当前源码保存链路

1. `SnapshotManager.svelte` 的 HTML `<form onsubmit={saveCurrent}>` 使用 Svelte 5 事件绑定；`snapshot-save-action.js` 的 handler 首先 `preventDefault()`。确认按钮受完整 structured session、Host Storage 能力和历史列表状态门控。
2. `createPlanSnapshot()` 只接收当前 structured Estimated Plan session 与名称/说明；错误会落到表单内，不清除名称或说明。
3. `createPlanSnapshotRepository()` 使用既有 key `plan-detective.snapshot-store.v1` 和 Storage Schema v1。`manifest.json` 声明 `host.storage`；`dbx-plugin-storage.js` 等待 Host init、检查 `capabilities.storage` 与 `get/set/delete` 方法，并在权限或容量错误时 fail closed。
4. Repository 先读原文档、检查容量/冲突，然后对单个快照仓库 value 调用一次 `storage.set`；随后 `storage.get` 写后读回比较文档指纹。写后状态未知时只再读、不重复 set；匹配到候选文档才确认保存。
5. 已确认保存后关闭表单、给成功反馈并将新记录加入已确认的列表计数；列表刷新在后台进行。失败时表单保持打开，显示稳定错误码对应说明及可用的 Host 原始错误文本，历史列表可手动刷新。
6. 历史入口与 Host Plan / connection / SQL gate 分离。打开快照只用已保存的 `RawPlanInput` 在本地重新计算，不调用 Host Plan API，也不重新执行 SQL。历史列表自身由 DBX Host Storage 读取；未知计数显示为 `—`，不伪造为零。

## PR review 与包证据

- Codex P2 `4310908497`：非保存操作错误曾与保存错误共用反馈区。已分离 `saveError` / `operationError`，回复并解决。
- Codex P2 `4311269389`：保存 pending 时曾能通过入口关闭表单，可能隐藏后续错误。已在 `5cca8b7` 禁止保存 pending 时关闭表单/进行历史操作，回复并解决；Codex 对 `5cca8b7` 的复审未发现其他问题。
- 已保存的 review candidate `artifacts/issue-72-save-feedback-5cca8b7013f5797e84f975bdf6f6cb3b5f8d59b1/io.github.0verme.plan-detective-0.7.1-universal.dbxp` 对应源码 commit `5cca8b7`，SHA-256 `6558fc72925a59ee8ec9a29476849d8b3bd5639ac4241ed0e2aad5ec168ef30a`；其中 manifest 声明 `host.storage`，包内 UI 与该 commit 对齐。该证据只证明候选包内容，不证明 Windows 安装了此包。
- 本次 UI 更新会产生新的构建包；新包亦只是 unsigned review candidate，不是 Release 或 Store 发布。更新候选包的 SHA-256 应在 build/package 后另行记录。

## 真正完成环境诊断所需证据

Windows 验收时仅需记录脱敏元数据：Installed 页面显示的插件版本、安装 `.dbxp` 的 SHA-256、DBX 版本、`host.storage` 是否已授予、点击保存时 UI 状态、Storage `get/set/get` 的结果与经过时间，以及脱敏后的错误 code/message。禁止采集或提交真实 SQL、Raw Plan、credential、connection ID 或整个 Storage value。只有安装包/权限与调用结果可核对后，才能将 Windows 故障 Root Cause 标记为已确认。
