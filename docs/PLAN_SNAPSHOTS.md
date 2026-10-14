# 本地计划快照契约

## 开发状态

- **Phase 72.1 完成**：版本化 Snapshot envelope、session provenance、校验与 JSON/Text/XML round-trip。
- **Phase 72.2 完成**：正式 DBX Host Storage adapter 与有界单值快照仓库。
- **Phase 72.3 完成（PR #88）**：快照保存/历史管理 UI、窗口内基线选择和本地历史回看。
- **Phase 72.4 软件回归通过**：全量 `npm test`、build/package、`npm audit --audit-level=high` 与 diff-check 均通过；package 仅为 unsigned review candidate，未发布。这不等同于真实 Host 验收。
- **Issue #72 仍 OPEN**：NAS 无 DBX Desktop；Host Storage 持久化、安装/升级权限、重启恢复及多窗口行为均 **NOT VERIFIED**，待真实 DBX Desktop 验收后再关闭。

## Snapshot Schema v1

`src/lib/plan-snapshot.js` 是插件侧 snapshot envelope 的唯一实现。v1 字段为：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | envelope schema 版本，当前固定为 `1` |
| `snapshotId` | 快照唯一 ID |
| `savedAt` | 保存时间（UTC ISO-8601） |
| `capturedAt` | Host 计划返回时间；未知时为 `null` |
| `title` / `note` | 用户名称和说明；标题最多 120 字符，说明最多 2,000 字符 |
| `producerVersion` | 创建快照的插件版本；未知时为 `null` |
| `rawInput` | whitelisted 的完整 `RawPlanInput`（Estimated only） |
| `source` | 可取得的数据库名称和 schema 展示上下文；未知字段省略 |

只接受完成且成功 structured 的分析 session；`raw-only`、错误、截断、Actual 或缺少分析结果的 session 会拒绝。SQL、数据库 family/version、原始计划 payload 和来源信息都取自**同一个分析完成时的 session**，而不是之后变化的编辑器或连接表单。

`rawInput` 继续使用 Plan Core 现有契约，不把 Host 或持久化元数据放进 Core。`json` 计划必须是 JSON object/array；`text` / `xml` 必须是字符串。序列化前检查循环引用、稀疏数组、非有限数字、函数、`undefined`、非普通对象等 JSON 有损值，避免静默改写 payload。JSON/Text/XML 均通过 `serializePlanSnapshot` / `deserializePlanSnapshot` round-trip。

## DBX Host Storage 契约与最低版本

插件只使用正式公开 API：`window.dbxPlugin.capabilities.storage` 与 `window.dbxPlugin.storage.get/set/delete`，manifest 声明 `host.storage`。须等待 Host init；capability 缺失/false、方法不全或宿主明确拒绝权限时，快照仓库 fail closed，已有分析链路不依赖 Storage、继续可用。禁止用 iframe `localStorage` / IndexedDB 作 fallback。

最低版本审计不是只依据 DBX v0.6.42：

- **DBX tag v0.6.23** 的 `plugins/README.md` 已记载 `storage`、`host.storage` 和 `capabilities.storage`；同 tag 的 [`plugins/manifest.schema.json`](https://github.com/t8y2/dbx/blob/v0.6.23/plugins/manifest.schema.json) 允许 `host.storage`。
- 同 tag [`pluginHostBridge.ts`](https://github.com/t8y2/dbx/blob/v0.6.23/apps/desktop/src/lib/plugins/pluginHostBridge.ts) 只在 get/set/delete 三个 Host adapter 都存在时 advertise `storage: true`，并对各方法执行 `host.storage` permission gate；对应 [`plugin_storage.rs`](https://github.com/t8y2/dbx/blob/v0.6.23/src-tauri/src/commands/plugin_storage.rs) 实现 per-plugin 持久化。
- 同一公开契约也在 DBX tag v0.6.42 核验：[`plugins/README.md`](https://github.com/t8y2/dbx/blob/v0.6.42/plugins/README.md)、[`pluginHostBridge.ts`](https://github.com/t8y2/dbx/blob/v0.6.42/apps/desktop/src/lib/plugins/pluginHostBridge.ts)、[`plugin_storage.rs`](https://github.com/t8y2/dbx/blob/v0.6.42/src-tauri/src/commands/plugin_storage.rs)。

因此仓库现有 `engines.dbx >=0.6.23` 有 tagged-source 契约证据，本阶段不必人为抬高最低版本；同时 capability gate 仍必须保留，以兼容不完整/裁剪的 Host 实现。以上为**源码和文档审计**，不是本插件在任一 DBX Desktop 版本上的运行时验证。升级安装后的权限行为仍待 Windows/Desktop 验收。

## 容量、原子性与并发

DBX v0.6.23/v0.6.42 Host 契约：每个 storage value ≤256 KiB UTF-8 JSON bytes，整个插件 store ≤1 MiB，最多 1,024 个 key，key ≤256 字符。Host native 实现对每次调用序列化 read-modify-write，并通过 temp file + fsync + rename 原子替换其单个后端文件；这些宿主实现事实不能证明插件侧多个 get/set 调用组成一个事务。

Plan Detective 将全部快照和索引保存为**一个版本化 value / 一个 key**，每次变更只调用一次 `storage.set`，避免多键索引与记录不一致。插件自身限制：单条序列化快照 ≤128 KiB、整个快照文档 ≤192 KiB；在 256 KiB 单值限制下预留 64 KiB，在 1 MiB 插件 store 中至少留出 832 KiB 给其他用途。容量按 `TextEncoder(JSON.stringify(value)).byteLength` 计算；超限在调用 Host 前拒绝，不截断、不驱逐旧快照、不覆盖旧数据。可保存数量随计划大小变化，不承诺固定份数。

同一 bridge 下的仓库操作串行化，并在写入前复核 revision、写后读回核对；已观察到并发变化时返回 `SNAPSHOT_STORAGE_CONFLICT`，不自动重试或覆盖。公开 Storage API 没有 compare-and-swap / transaction，也没有 key enumeration；**不同 DBX 窗口之间存在无法从插件侧完全消除的极窄并发竞态**。因此不能宣称跨窗口并发写入无损：管理 UI 必须告知用户不要在多个插件窗口同时修改快照；检测到冲突时要求刷新再操作。要提供强跨窗口一致性需要 DBX Host 新增原子 compare-and-swap 或事务接口，本项目不修改上游 DBX。

损坏仓库、损坏记录和未知 schemaVersion 都 fail closed；不得重置、清空或覆盖原值。Host 低层存储自身如何备份损坏文件由 DBX 实现决定，插件不访问其私有目录。

## 隐私与恢复行为

- envelope 只复制 `RawPlanInput` 已知字段，以及 `source.databaseName` / `source.schema`；不保留完整分析 session、DBX bridge、connectionId、credential、capability 或 lifecycle 对象。
- SQL 与 Raw Plan 默认会一起进入用户主动保存的本地快照。计划或 SQL 可能含用户提供的敏感字面量；**本功能不声称脱敏**。保存表单会明确告知写入 DBX Host Storage 的内容。
- `deserializePlanSnapshot` 遇到损坏的序列化快照返回 `CORRUPT_SNAPSHOT`；持久化仓库遇到损坏的 store envelope/记录返回 `CORRUPT_SNAPSHOT_STORE`。未知快照/store 版本分别返回 `UNSUPPORTED_SNAPSHOT_VERSION` / `UNSUPPORTED_STORE_VERSION`。读取端不会静默覆盖、丢弃或按 v1 解码未知版本。
- 当前只支持 v1，不自动迁移未知版本。任何未来迁移必须显式、可测试，并保留旧记录直到迁移成功。
- 打开历史快照时，使用快照中的完整 `RawPlanInput` 由当前 Plan Core 本地重新计算 Findings / Hotspots；不调用 `explainPlan`、不要求连接仍打开。UI 显示保存时插件版本与当前 analyzer 版本，并明确重新计算结果不代表保存时的诊断判断；当当前 Core 无 parser 或解析失败时仍保留并展示 Raw Plan。
- 「选作基线」状态当前只保存在插件窗口内，不修改快照，不跨重启持久化；Issue #73 Phase 73.1 已实现纯 Estimated Plan Diff Core，但尚未接入该选择、比较 UI 或诊断关联。

## 当前验证边界

Node tests 覆盖 Host capability/init gate、权限拒绝和 UTF-8 限额、快照保存资格/格式 round-trip、单值容量、旧数据保护、同窗口并发串行化及可观察的跨窗口冲突。模拟 Host 不等于真实持久化验证；真实 DBX Desktop 安装/升级权限、重启恢复与多窗口行为均仍 **NOT VERIFIED**。
