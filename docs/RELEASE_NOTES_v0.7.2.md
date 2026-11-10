# DBX Plan Detective v0.7.2 Release Notes

## 概览

v0.7.2 是基于 v0.7.1 的 Patch Release，新增 IBM Db2 LUW Estimated Plan 的条件式结构化解析与树形展示。解析只在 DBX Host 对同一连接明确报告支持 Estimated Plan 时启用，不绕过 Host capability gate。

本版本保持插件 ID、通用 DBX / Host API 要求与 `host.plans:read` 权限不变。未发布过的计划快照与 Estimated Plan Diff 实验功能在本次发布前已从 `main` 移除，不属于 v0.7.1 正式版能力。

## 新增功能

- **IBM Db2 LUW Estimated Plan（Issue [#97](https://github.com/0verme/dbx-plugin-plan-detective/issues/97)）**：支持 DBX DB2 Agent JSON v1 Estimated Plan 的结构化解析；按 operators、streams、predicates 与共享 producer 引用恢复计划结构，支持多个 root。
- **DB2 计划树与节点信息**：展示 DB2 算子、表与索引对象、谓词及树形关系；保留未知算子和原始计划证据。
- **DB2 原生估算指标**：展示 timerons、page I/Os、instructions 等 DB2 原生估算值，以及 stream 输出基数；成本不映射为 PostgreSQL cost，不据此生成通用 Finding / Hotspot，也不将 stream 输出基数解释为扫描行数或实际行数。
- **GaussDB / Huawei DWS 条件式解析**：保留此前合并的 PR [#92](https://github.com/0verme/dbx-plugin-plan-detective/pull/92) 实现，仅在同连接 Host capability 明确为 true 时启用。DBX 上游对普通 GaussDB 的 Estimated Plan 支持尚未合并，本版本不宣称普通 GaussDB 或真实 DWS 已通过端到端验证。
- **未发布实验功能清理**：PR [#99](https://github.com/0verme/dbx-plugin-plan-detective/pull/99) 移除了此前未进入正式版的计划快照与 Estimated Plan Diff 实现；v0.7.1 正式版不提供这些能力，因此没有改变已发布版的既有功能承诺。

## 兼容性与行为边界

- 插件 ID：`io.github.0verme.plan-detective`；通用 manifest 要求保持 DBX `>=0.6.23`、Host API `^1.2`，权限保持 `host.plans:read`。
- DB2 parser 的源码组件基线为 **DBX Desktop >= 0.6.38** 与 **DB2 Agent >= 0.1.78**。这是组件源码能力基线，不代表这些版本组合已通过插件端到端兼容性矩阵测试。
- DB2 支持范围限于 DB2 LUW 的 DBX Agent JSON v1 **Estimated Plan**，且要求同一连接的 Host capability 为 true。
- 只支持 Estimated Plan；不支持 DB2 Actual Plan 或 DB2 Plan Diff。
- 不宣称 Db2 for z/OS 或 Db2 for i 已通过验证或受支持。

## 已知限制与验证边界

- DB2 fixture 包含一份 DBX 上游 unit-test 计划（原始 DB2 capture 来源未说明）及 synthetic 样本；离线 parser / adapter 测试不能替代真实 DB2 数据库端到端验证。
- 用户报告最新 `.dbxp` 已在真实 DBX 环境手工测试并正常运行。本次发布工作站没有 DBX Desktop，未重复该实机测试；该报告不作为真实 DB2 数据库端到端测试的证明。
- Host 未报告同连接 `supports.estimatedPlan = true` 时，DB2 计划保持 unsupported；插件不会猜测能力或绕过 DBX Host。

## 验证

- 使用锁定的 `package-lock.json` 完成 `npm ci`；此工作站的 worktree 文件系统执行 `esbuild` 时返回 `EACCES`，因此依赖安装在 `/tmp` 完成并临时链接到 release worktree，未改动 lockfile。
- `npm test`：**1379/1379 通过**；额外 DB2 parser / fixture / Host contract / view-model 与 DBX adapter 定向回归：**74/74 通过**。
- `npm run build`：通过；bundle fingerprint 为 `sha256:715ccb4d5308d1f8557dfc8f9bc7d1475c8a5fb8e7242e1bbfa356f8d951f7cb`。
- 官方 DBX CLI universal package preflight 已检查 manifest 版本 / ID / Host API / 权限、6 个预期 ZIP 项、构建指纹及 `.artifact.json` 的大小 / SHA-256 一致性。本机 FUSE 生成的本地候选 `manifest.json` ZIP mode 为 `100000`，不作为正式资产；正式 `.dbxp` 与发布元数据由固定的 `ubuntu-24.04` GitHub Release workflow 构建，发布后核对实际 ZIP 权限、签名状态与 metadata。
- 没有在缺少真实数据库的 CI 中伪造 DB2 端到端测试结果；也没有把用户报告的 DBX 手工验收描述为 DB2 数据库 E2E。

## English summary

v0.7.2 adds conditional structured parsing and tree display for IBM Db2 LUW Estimated Plans (Issue #97), preserving DB2-native operators, objects, predicates, timerons, page I/Os, instructions, and stream output cardinality without mapping DB2 costs to PostgreSQL semantics. It requires DBX Desktop source baseline >=0.6.38 and DB2 Agent source baseline >=0.1.78; this is not an end-to-end compatibility certification. Only DB2 LUW JSON v1 Estimated Plans are in scope. Actual Plans and Plan Diff are unsupported, and Db2 for z/OS / Db2 for i are not claimed as verified. The previously merged conditional GaussDB/DWS parser remains gated on affirmative per-connection Host capability, and the never-released snapshot/Diff experiments were removed before this release.
