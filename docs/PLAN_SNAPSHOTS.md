# 本地计划快照契约

> 本文记录 Issue #72 的快照数据契约。当前开发阶段为 **72.1：Schema 与数据契约**；此阶段只提供纯数据构造、校验和序列化代码，尚未提供 Host Storage 持久化或快照 UI。

## Snapshot Schema v1

`src/lib/plan-snapshot.js` 是插件侧 snapshot envelope 的唯一实现。v1 字段为：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | envelope schema 版本，当前固定为 `1` |
| `snapshotId` | 快照唯一 ID |
| `savedAt` | 保存时间（UTC ISO-8601） |
| `capturedAt` | Host 计划返回时间；旧/无 provenance 时为 `null` |
| `title` / `note` | 用户名称和说明；标题最多 120 字符，说明最多 2,000 字符 |
| `producerVersion` | 创建快照的插件版本；未知时为 `null` |
| `rawInput` | whitelisted 的完整 `RawPlanInput`（Estimated only） |
| `source` | 可取得的数据库名称和 schema 展示上下文；未知字段省略 |

Snapshot 仅接收完成且成功 structured 的分析 session；`raw-only`、错误、截断、Actual 或缺少分析结果的 session 会拒绝。SQL、数据库 family/version、原始计划 payload 和来源信息都取自**同一个分析完成时的 session**，而不是之后变化的编辑器或连接表单。

`rawInput` 继续使用 Plan Core 现有契约，不把 Host 或持久化元数据放进 Core。`json` 计划必须是 JSON object/array；`text` / `xml` 必须是字符串。序列化前检查循环引用、稀疏数组、非有限数字、函数、`undefined`、非普通对象等 JSON 有损值，避免静默改写 payload。JSON/Text/XML 均通过 `serializePlanSnapshot` / `deserializePlanSnapshot` round-trip。

## 隐私与恢复行为

- envelope 只复制 `RawPlanInput` 中已知字段，以及 `source.databaseName` / `source.schema`；不保留完整分析 session、DBX bridge、connectionId、credential、capability 或 lifecycle 对象。
- SQL 与 Raw Plan 默认会一起进入用户主动保存的本地快照。计划或 SQL 可能含用户提供的敏感字面量；**本功能不声称脱敏**。后续保存 UI 必须明确本地保存内容。
- `deserializePlanSnapshot` 对损坏 JSON 返回 `CORRUPT_SNAPSHOT`，对未知版本返回 `UNSUPPORTED_SNAPSHOT_VERSION`；`validatePlanSnapshot` 返回稳定的错误码。读取端不得静默覆盖、丢弃或把未知 schema 当成 v1。
- 当前只实现 v1 校验，不自动迁移未知版本。任何未来迁移必须是显式、可测试的迁移步骤，保留原始记录直到迁移成功。
- v1 只定义数据格式；容量预算、Host Storage 多键一致性、并发和权限降级属于后续 Phase 72.2，历史管理 UI 属于 Phase 72.3。

## 当前验证边界

Node tests 覆盖 session provenance、保存资格、字段白名单、JSON/Text/XML round-trip、非 JSON-safe payload、损坏记录与未知 schema 版本。此阶段未做真实 DBX Desktop 验证；没有实现持久化，因此关闭/重启恢复尚未验证。
