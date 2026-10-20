# PR #93：快照保存与重命名事件链诊断与验收

## 根因（已在真实浏览器 DOM 复现）

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

## 重命名：同一类缺陷（第二轮修复，`983faf8`）

保存与重命名**属于同一类 sandbox 表单兼容性问题，不是 Storage 故障**。第一轮只修复了保存表单，重命名表单仍保留原写法（`<form onsubmit={(event) => saveRename(event, snapshot.snapshotId)}>` + `type="submit"`），因此在 Windows 上历史可读、表单可打开，但点击「保存修改」既不提交也不报错。

真实 Chromium + 生产 bundle + `sandbox="allow-scripts"`（预置 1 条 v1 快照）复现：

- 点击前：提交按钮 `association {form: true, disabled: false, valid: true}`，历史 `get` 3 次（读取正常），`set` 0 次。
- 点击后：`set` **0** 次，表单仍处于编辑状态，列表标题不变，无 alert，**没有任何 `RENAME_*` 事件**（`saveRename()` 从未被调用）。
- 名称框 Enter：`set` **0** 次。
- 控制台原文：`Blocked form submission to '' because the form's frame is sandboxed and the 'allow-forms' permission is not set.`（点击与 Enter 各一条）。

### 修复

- 把已通过测试的保存接管逻辑抽为 `src/lib/sandbox-form-submit.js`，**保存与重命名共用**：`preventDefault()` → 校验 form/submitter 关联与 disabled → `reportValidity()` → 派发单个可取消 `SubmitEvent` → 校验 handler 是否真的被触达。这样第三个表单无法再静默退化。
- 重命名改为 `handleRenameClick → handleRenameSubmit → saveRename`；保留 `required`/`maxlength`、Enter 隐式提交、聚焦按钮 Space；`aria-busy` + 真实 disabled 防重复（真实双击只写一次）。
- 只有 Host 回读确认后才更新列表并关闭表单；失败保留输入、显示 `role=alert` 行内错误、旧记录不变、不自动重试。
- 未改 Snapshot Schema v1、`plan-detective.snapshot-store.v1` key、Storage 协议与 manifest。

### 全量提交路径审计（`src/`）

- 仅有两个 `<form>`，都在 `SnapshotManager.svelte`，现在都走同一 helper。
- 没有其它 `requestSubmit`、`.submit()`、`onreset`、`novalidate`。
- 打开历史 / 刷新 / 关闭 / 打开快照 / 设置或清除窗口内基线 / 删除确认 / 语言切换 / 取消均为 `type="button"` + `onclick`，不依赖表单提交；全部 26 个 DOM 测试在 `after` 钩子中断言「`allow-forms` 控制台错误为 0」。
- 当前 UI 没有「清空全部」动作，只有逐条删除，已覆盖。

## 最小修复

- **仍使用 `<form>` 和 `type="submit"`**，不改成普通按钮、不放宽 Host sandbox、不增加 `allow-forms`。两个表单都通过 `src/lib/sandbox-form-submit.js` 完成同一个接管步骤。
- 按钮激活时先 `preventDefault()` 取消必定被禁止的导航路径，再调用原生 `form.reportValidity()`；合法时同步派发 `new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button })`，仍由 form 的 `onsubmit` 进入同一个表单处理函数（保存为 `saveCurrent`，重命名为 `handleRenameSubmit`）。这是应用派发的 DOM 事件，日志 `eventTrusted=false`，不冒充原生默认提交。
- 保留浏览器原有 Enter 隐式激活和按钮 Enter/Space 键盘行为；没有全局 keydown/手工吞键，textarea Enter 仍换行。`requestSubmit()` 不是本沙箱的可行替代。
- 空名称允许点击以获得 required 校验提示；表单错误既有原生反馈，也有本地化 `role=alert`。空白名称等仍由 `createPlanSnapshot` 的业务校验拒绝。
- 原有 in-flight 防重复、保存中 disabled、失败保留名称/说明、写后只读核验全部保留；没有自动重试写入。
- Snapshot Schema v1、`plan-detective.snapshot-store.v1` key、Storage 协议与历史无连接打开能力不变；`plan-snapshot-store.js`、`dbx-plugin-storage.js` 无修改。

## Trace 状态与脱敏

- 点击 → `SNAPSHOT_UI_CLICK`（DOM form/disabled/关联状态）→ `SNAPSHOT_FORM_VALIDATION_RESULT` → `SNAPSHOT_FORM_SUBMIT_DISPATCH` → `SNAPSHOT_FORM_SUBMIT_CAPTURE` → `SNAPSHOT_FORM_SUBMIT` → 现有 gate/create/repository/get/set/verify/UI 事件。
- 重命名使用独立 trace（`kind: "rename"`）：`RENAME_CLICK` → `RENAME_VALIDATE` → `RENAME_REPOSITORY_START` / `RENAME_STORAGE_SET_START` / `RENAME_STORAGE_SET_END` / `RENAME_STORAGE_VERIFY_START` / `RENAME_STORAGE_VERIFY_END` / `RENAME_STORAGE_VERIFY_RESULT` / `RENAME_REPOSITORY_END` → `RENAME_SUCCESS`，失败为 `RENAME_ERROR`；每条带 `status`、`durationMs` 与安全 `errorCode`。导出为 `latestRenameTrace`，与 `latestSaveTrace` 分开，不冒充保存阶段。
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

重命名新增覆盖：真实点击写入并更新列表、名称框 Enter、聚焦按钮 Space、空名称原生校验拦截、全空白名称业务校验拦截、Host set pending 期间真实双击只写一次、写入失败保留输入且不自动重试（仅显式重试再写）、关闭重开历史仍可见、新会话只凭 Host Storage 读回（`connected: false`、`planCalls === 0`）、打开历史/设置与清除基线/删除回归、中英文反馈。

本轮 Linux 验证：`npm test` **1454/1454 PASS**（其中 **26/26 真实 DOM 测试**，Chromium `153.0.8010.12` / Playwright `1.63.0`）；build、package、audit（0 vulnerabilities，`npm audit` 需指向 `registry.npmjs.org`，本地 npmmirror 源不实现 audit API）、diff-check 全部 PASS。包内 UI 与本地生成 UI 逐字节一致，manifest/官方 artifact metadata/fingerprint 校验通过，无 backend/Node runtime。证据摘要与来源 commit 同时记录在开发包旁的验收报告。

## 新开发包与 Windows 最短验收

新 unsigned 开发包（仍为 `0.7.1`，**未发布版本**）：

`dist/io.github.0verme.plan-detective-0.7.1-universal.dbxp`

- SHA-256：`0ebcb903be36104854313471d913d29380f70bc326ef8970bbaa48cc76f906fa`（134374 bytes）
- UI fingerprint：`sha256:b4c42d6f0fdf9406cde9787add648036e2cbdda4160079e854008986b67d0bcf`
- 同目录 `.artifact.json` 记录同一 SHA 与 size；本轮两个 commit：`29d60ec`（保存接管）、`983faf8`（重命名接管 + helper 抽取）。

同目录的 `.artifact.json` 记录包 SHA-256 与 size；build fingerprint 由 `npm run package` 输出并内嵌进 bundle，由 `npm test` 校验与当前源码输入一致。manifest 保持 `host.plans:read`、`host.storage`；仅静态 UI，无 backend/Node runtime。

**Windows DBX Desktop 验收状态**：保存与重命名已由用户在本机 Windows DBX Desktop 手工验收通过（用户反馈，无阻塞问题）。本 Agent 只有 Linux/headless Chromium，无法独立复现该环境，因此本仓库内可复现的证据仍是「上游源码 + 真实 Chromium opaque sandbox + 测试替身 Host bridge」；实机结论以用户验收为准，是否合并由维护者决定。

1. 在 Windows DBX Desktop 插件管理页安装/更新该开发包；记录 About 版本，核对包 SHA 与运行诊断 fingerprint。若同版本替换被拒绝，反馈错误，不绕过安全保护。
2. 完成一次 structured Estimated Plan；打开保存，空名称确认应看到校验反馈；输入合法名称和说明，点击保存应成功且历史数 +1。再用 Enter 保存一次；快速双击只能增加一条。
3. 打开历史选择一条记录：分别用点击「保存修改」、名称框 Enter、聚焦按钮 Space 改名，列表应立即更新；空名称应有校验提示且不写入；真实双击只写入一次。
4. 关闭并重开历史，名称与说明仍在；重启 DBX，在无连接状态再打开历史确认读回一致。回归打开历史、设为基线、删除。
5. 复制脱敏诊断：保存应有 dispatch/capture/submit/create/set/verify/UI success；重命名应有 `RENAME_*` 全链（`RENAME_CLICK` → `RENAME_SUCCESS`），save 与已返回的 history 顶层应为 completed。

回传成功/失败结果、脱敏 JSON、DBX About 版本和包 SHA；不附 SQL/Raw Plan/连接信息/说明原文。本轮不新建 PR、不发布、不自动合并。
