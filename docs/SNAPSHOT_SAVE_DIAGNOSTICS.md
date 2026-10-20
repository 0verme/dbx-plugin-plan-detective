# PR #93：快照保存事件链诊断与验收

## 根因（已在真实浏览器 DOM 复现，不代表 Desktop 已验收）

用户的 Windows 日志表明 Storage 可用、历史 GET 成功、按钮已启用，但两次 `SNAPSHOT_UI_CLICK` 后都没有 `SNAPSHOT_FORM_SUBMIT`。本轮没有修改 Storage Repository。

**断点是 Host iframe 的 HTML sandbox，而非 Storage 或 Svelte 5 的 `onsubmit` 语法。** DBX 使用 `sandbox="allow-scripts"`，没有 `allow-forms`：

- 上游固定源码：[PluginWorkbenchHost.vue:920 @ d1e88ab4](https://github.com/t8y2/dbx/blob/d1e88ab4b5b196d8b920b56ee8bc1735dcdc6269/apps/desktop/src/components/plugins/PluginWorkbenchHost.vue#L920)。只读核查，没有修改 DBX 仓库。
- 本插件故障基线 `be63bec`：`src/components/SnapshotManager.svelte:445` 只绑定 `onsubmit={saveCurrent}`；`:463` 的 `type="submit"` 按钮 `onclick` 仅记录点击（`:274–281`），依赖默认提交。沙箱在校验和 submit 事件**之前**禁止该默认动作，因而保存处理函数不可达；`form.requestSubmit()` 也一样被禁止。
- 原生产 bundle 对照：顶层页面 `button.form` 正确、`disabled=false`、`checkValidity()=true`，click → submit → 一次 set；同一 bundle 放入 `allow-scripts` opaque iframe 后，相同状态下 click → **无 submit、零 set**。Chromium 控制台原文：`Blocked form submission to '' because the form's frame is sandboxed and the 'allow-forms' permission is not set.`
- 复现是 Linux Chromium，不是用户设备的 Windows WebView2/DBX Desktop。源码与复现解释了日志断点，实际安装环境的修复结果仍需人工验收。

### 八项排查结果

| 检查项 | 结果 |
| --- | --- |
| 按钮 form 归属 | 原 DOM 正确；新诊断核对关联及 connected，错配明确报错 |
| 原生 submit | 顶层触发；Host 同型 sandbox 中被浏览器拦截 |
| constraint validation | 原复现合法输入为 true，不是此次断点；沙箱默认路径甚至不会进入原生校验 |
| invalid 捕获 | 原来只监听标题；现在 form capture 同时覆盖 input/textarea（invalid 不冒泡） |
| onsubmit | 实际收到 submit 时正常；新增 capture 与 handler 两个事件区分传播断点 |
| 同步异常 | 原复现无应用异常；DOM 校验/派发及保存入口异常现在有脱敏 failed trace |
| disabled | 原 DOM 与业务状态一致且 false；日志新增实际 DOM 值和 mismatch |
| 渲染/Popover/传播 | 本组件没有 Popover/Portal；原复现是 iframe sandbox 限制；新增传播中断回归 |

## 最小修复

- **仍使用 `<form>` 和 `type="submit"`**，不改成普通按钮、不放宽 Host sandbox、不增加 `allow-forms`。
- 按钮激活时先 `preventDefault()` 取消必定被禁止的导航路径，再调用原生 `form.reportValidity()`；合法时同步派发 `new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button })`，仍由 form 的 `onsubmit` 进入同一个保存处理函数。这是应用派发的 DOM 事件，日志 `eventTrusted=false`，不冒充原生默认提交。
- 保留浏览器原有 Enter 隐式激活和按钮 Enter/Space 键盘行为；没有全局 keydown/手工吞键，textarea Enter 仍换行。`requestSubmit()` 不是本沙箱的可行替代。
- 空名称允许点击以获得 required 校验提示；表单错误既有原生反馈，也有本地化 `role=alert`。空白名称等仍由 `createPlanSnapshot` 的业务校验拒绝。
- 原有 in-flight 防重复、保存中 disabled、失败保留名称/说明、写后只读核验全部保留；没有自动重试写入。
- Snapshot Schema v1、`plan-detective.snapshot-store.v1` key、Storage 协议与历史无连接打开能力不变；`plan-snapshot-store.js`、`dbx-plugin-storage.js` 无修改。

## Trace 状态与脱敏

- 点击 → `SNAPSHOT_UI_CLICK`（DOM form/disabled/关联状态）→ `SNAPSHOT_FORM_VALIDATION_RESULT` → `SNAPSHOT_FORM_SUBMIT_DISPATCH` → `SNAPSHOT_FORM_SUBMIT_CAPTURE` → `SNAPSHOT_FORM_SUBMIT` → 现有 gate/create/repository/get/set/verify/UI 事件。
- `invalid` capture 记录 `invalidField`、`valueMissing`、`tooLong`、`customError`，终态 `blocked`；不记录字段值、原生错误消息或自定义校验文本。
- click/capture 没有进入 handler 时，在本次事件任务结束后记录 `FORM_SUBMIT_NOT_OBSERVED` 并 `blocked`；同步异常为 `failed`。旧点击不会串到以后无关的 submit。
- 历史初始化/刷新在真正的读操作结束后显式 `completed`；读取失败 `failed`；已过期的读取 `blocked`。不再出现初始化 END success 但顶层永久 pending。
- 保存成功后的后台 refresh 使用**独立 history trace**：save 可以 completed，而真实未返回的后台 GET 保持 pending；不再把未完成的 Host 操作挂在已完成的 save trace 下。
- click watchdog 在进入 submit 时撤销，**不会**给 Host get/set/read-back 加假超时，也不会把仍等待的操作标 completed。长时间写入仍显示 `UNKNOWN/PENDING` 并禁止重复写入。
- 仍只保留会话内有界、白名单脱敏 JSON：最多 8 条 trace、每条 128 个事件、导出上限 48 KiB；不写日志到 Host Storage，不导出 SQL、Raw Plan、名称、说明、Storage key/value、连接信息或原始 Host/DOM 错误文本。

## 自动验证

```bash
npm ci --include=dev
npx playwright install chromium # Linux 缺系统库时使用 --with-deps
npm run test:dom
npm test
npm run build
npm run package
npm audit --audit-level=high
git diff --check
```

`tests/ui/snapshot-dom.test.js` 构建并运行真实生产 App/Svelte bundle，不直接调用 `saveCurrent()`；使用 Chromium opaque `sandbox="allow-scripts"` iframe。仅公开 Host bridge 是测试替身，不是 DBX Desktop 验收。

覆盖：原生沙箱断点与 requestSubmit 对照、真实点击进入 capture/handler、合法保存及历史增加、required/textarea invalid、Enter/Space、textarea 换行、双击仅一次写入、Host set pending/busy、失败保留输入、旧 v1 记录与其它 key 不变、无连接历史打开、历史 pending→completed、保存与后台刷新状态分离、submit 传播中断、form 归属错配、同步异常及业务校验不被绕过。

本轮 Linux 验证：`npm test` **1442/1442 PASS**（其中 **17/17 真实 DOM 测试**，Chromium `153.0.8010.12` / Playwright `1.63.0`）；build、package、audit（0 vulnerabilities）、diff-check 全部 PASS。包内 UI 与本地生成 UI 逐字节一致，manifest/官方 artifact metadata/fingerprint 校验通过，无 backend/Node runtime。证据摘要与来源 commit 同时记录在开发包旁的验收报告。

## 新开发包与 Windows 最短验收

新 unsigned 开发包（仍为 `0.7.1`，**未发布版本**）：

`dist/pr93-save-event-chain/io.github.0verme.plan-detective-0.7.1-universal.dbxp`

- SHA-256：`bdc169e45e5d068d130afdb5bc696d13685ddbb263d8e617f82f53fbd2fcd3f1`
- UI fingerprint：`sha256:5419fcb86e3c6236ea25fc3c5b60fab26ead9f5ed14aa7ffa9430c0d9c650c48`

同目录的验收报告记录包 SHA-256、build fingerprint、来源 PR commit 与自动检查结果。manifest 保持 `host.plans:read`、`host.storage`；仅静态 UI，无 backend/Node runtime。

**Windows DBX Desktop 实际保存：NOT VERIFIED。** 本 Agent 只有 Linux/headless Chromium，没有 Windows GUI 或用户设备操作通道。

1. 在 Windows DBX Desktop 插件管理页安装/更新该开发包；记录 About 版本，核对包 SHA 与运行诊断 fingerprint。若同版本替换被拒绝，反馈错误，不绕过安全保护。
2. 完成一次 structured Estimated Plan；打开保存，空名称确认应看到校验反馈；输入合法名称和说明，点击保存应成功且历史数 +1。再用 Enter 保存一次；快速双击只能增加一条。
3. 打开历史确认新增记录和旧记录均可读；重启 DBX，在无连接状态再打开历史。复制脱敏诊断：保存应有 dispatch/capture/submit/create/set/verify/UI success，save 与已返回的 history 顶层应 completed。

回传成功/失败结果、脱敏 JSON、DBX About 版本和包 SHA；不附 SQL/Raw Plan/连接信息/说明原文。实机证据返回前不声称 Windows 通过或 READY TO MERGE。本轮不新建 PR、不发布、不自动合并。
