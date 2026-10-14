# DBX Plan Detective v0.7.1 Release Notes

## 概览

v0.7.1 汇总 v0.7.0 之后已合并到 `main` 的插件中心首次使用引导、分析页信息组织与响应式/键盘体验优化、中英文切换状态保持及冗余文案精简；同时将正式安装包改为 frontend-only，移除普通用户安装后对系统 Node.js 的运行时依赖。

本版本没有改变插件 ID、DBX Host API、权限或数据库分析范围。此版本不把实验性 AI Tool 宣称为可用能力。

## 相比 v0.7.0 的实际变更

- **插件中心首次进入引导**：[PR #75](https://github.com/0verme/dbx-plugin-plan-detective/pull/75)，属于 UI/UX 总控 [Issue #74](https://github.com/0verme/dbx-plugin-plan-detective/issues/74)。Host 初始化后无连接 / SQL 上下文时提供中英双语引导；已存在的查询结果上下文仍直接进入分析工作台。[PR #76](https://github.com/0verme/dbx-plugin-plan-detective/pull/76) 是本轮布局审计与回归基线文档，不单独代表已验证的视觉修复。
- **分析页布局与信息密度**：[PR #77](https://github.com/0verme/dbx-plugin-plan-detective/pull/77)、[#78](https://github.com/0verme/dbx-plugin-plan-detective/pull/78)。Plan Tree 与 Inspector 就近组织；摘要突出核心估算指标，次级信息可按需查看；压缩空诊断与连接技术细节展示，同时保留 Estimated Plan 风险说明和原有分析语义。
- **窄容器与键盘体验**：[PR #79](https://github.com/0verme/dbx-plugin-plan-detective/pull/79)、[#80](https://github.com/0verme/dbx-plugin-plan-detective/pull/80)。布局按可用宽度换行，计划树增加键盘导航与焦点/选中可见性；语言切换不清除 SQL、当前分析、节点选择或折叠状态；补充跨组件自动化回归覆盖。
- **精简界面文案**：[PR #81](https://github.com/0verme/dbx-plugin-plan-detective/pull/81)。移除重复说明与原始节点 ID 展示，保留状态提示、操作、错误反馈及 AI 分析提示词复制。
- **取消正式包 Node.js runtime 注册**：[PR #83](https://github.com/0verme/dbx-plugin-plan-detective/pull/83)，关闭 [Issue #82](https://github.com/0verme/dbx-plugin-plan-detective/issues/82)。manifest 仅保留 UI entrypoint；正式包只分发 `assets/` 与已构建 `ui/`，不携带 backend launcher、sidecar 或开发依赖。Node.js 22+ 仍是仓库开发、测试与构建工具，不是 v0.7.1 安装后运行时要求。

上列 PR 均在本次基于的 `origin/main` 中。本次发布范围核对（创建 Release PR #84 前）未发现其他 targeting `main` 的开放 PR。Issue #74 仍作为 UI/UX 总控开放；Issue [#66](https://github.com/0verme/dbx-plugin-plan-detective/issues/66) 的 AI Tool 仍受 DBX 上游普通原生连接绑定与结构化 Estimated Plan handoff 能力限制，不属于 v0.7.1 已发布功能。

## 兼容性与行为边界

- 插件 ID：`io.github.0verme.plan-detective`（不变）。
- DBX 最低版本：`>=0.6.23`；Host API：`^1.2`；权限仍为 `host.plans:read`。不新增 `host.data:read` 或其他权限。
- 仍通过 DBX Host Plan API 读取 Estimated Plan；不建立数据库连接、不读取凭据、不执行用户 SQL、不请求 Actual / `EXPLAIN ANALYZE`。
- v0.7.1 包不注册或打包 `analyze_estimated_plan` backend sidecar。其源码、契约和测试仍保留在仓库，但 AI Tool 端到端链路尚未完成验证。UI 内复制 AI 分析提示词不受影响。
- 已发布的 v0.7.0 `.dbxp` 不会被覆盖或改写；该旧包仍有其原始 sidecar 内容。此处 Node.js runtime 结论专指本次生成的 v0.7.1 正式包。
- DBX Store / 签名流程不在本次范围内。

## 发布与验证

- `npm ci`：通过，锁定依赖 39 packages。当前工作区抽取的 esbuild binary 缺少执行权限，首次安装脚本报 `EACCES`；通过 `ESBUILD_BINARY_PATH` 指向同版本、可执行的临时 binary 后重新执行干净安装成功。该 workaround 仅用于本地环境，不需要提交或加入发布工作流。
- `npm test`：通过，1296/1296，0 失败。
- `npm run build`：通过；tracked `ui/` 已包含本次已合并 UI PR 的构建产物，重建无额外差异。
- `npm run package`：通过，DBX 官方 CLI 生成 universal frontend-only `.dbxp` 与 artifact metadata。
- 本地 preflight `.dbxp`：包内 manifest 版本 `0.7.1`；插件 ID、DBX/Host API 约束和权限与源 manifest 一致。归档共 6 个条目（manifest、checksums、1 个 asset、3 个 UI 文件），包含完整静态 UI；不含 `node_modules`、backend、launcher、sidecar、源码、测试、fixtures 或开发目录。Metadata 的 target、size 与 SHA-256 匹配本地包。本地 candidate SHA-256 为 `a4168ac3d11221f2116b1701c0aebe9d5729ccf5b64358b686fec118d1baafd2`，它与正式 Release workflow 生成的上传包分开校验。
- Release PR [#84](https://github.com/0verme/dbx-plugin-plan-detective/pull/84) 已合并；release commit 与 tag `v0.7.1` 均指向 `522bce8850d2e9de888d849ed32658eef5197404`，该 commit 已进入 `main`。GitHub Release [DBX Plan Detective v0.7.1](https://github.com/0verme/dbx-plugin-plan-detective/releases/tag/v0.7.1) 已正式发布（非 Draft / 非 Prerelease）。
- `release: published` workflow [#38506438728](https://github.com/0verme/dbx-plugin-plan-detective/actions/runs/38506438728) 成功，`head_sha` 与 tag commit 一致；`Build universal` 与 `Publish plugin release assets` 均成功。
- 正式 `.dbxp`：[io.github.0verme.plan-detective-0.7.1-universal.dbxp](https://github.com/0verme/dbx-plugin-plan-detective/releases/download/v0.7.1/io.github.0verme.plan-detective-0.7.1-universal.dbxp)，107352 bytes，SHA-256 `701635897fd4e2b2ac943a00083dfb141bf02fe94688596ba1e023a85f31d413`。下载的 `release-candidates.json` 标注 `version=0.7.1` / `target=universal`，asset size / SHA-256 匹配；已检查包内 manifest、内部 checksums、完整 UI/assets 与 tag 源码一致，且无 Node runtime、launcher、sidecar 或开发文件。
- 维护者已报告近期合并 PR 在真实 DBX 环境完成测试；本轮未独立重复宿主测试，也不据此声称已覆盖 Windows/macOS/Linux 全矩阵。

## 尚未验证 / 未包含

- `analyze_estimated_plan` 的 Agent 端到端调用仍未验证，且当前受 DBX 上游能力限制；它不会注册或进入 v0.7.1 包。
- 未在本次工作站独立复测所有 DBX 版本、操作系统、真实数据库类型及视觉布局组合。
- 发布包为 unsigned universal 插件包；本次不更新 DBX Store。

## English summary

v0.7.1 improves the plugin-center first-use flow, analysis layout, responsive and keyboard behavior, locale-state preservation, and UI copy. The official package is frontend-only and no longer requires a system Node.js runtime. Plugin ID, DBX/Host API compatibility, and `host.plans:read` remain unchanged. The experimental AI Tool remains unavailable and is excluded from the package because required upstream DBX handoff capabilities are not yet available.
