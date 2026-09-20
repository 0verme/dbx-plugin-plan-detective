# MySQL Fixtures

本目录用于存放 MySQL 执行计划的**离线样本**，作为 Parser、Normalizer、Metrics、Rule Engine 与 UI 的
一等开发与测试输入。

> **当前状态：仅占位，尚未放入任何计划样本；MySQL parser 本轮不实现。**
> MySQL 属于 Adapter Roadmap（非 Tier 1），不在首期并行采集。
> 本文档记录的是 adapter boundary 设计，不是已实现能力。

目录、metadata sidecar、provenance 标记与 Golden Test 约定与 PostgreSQL 相同，见
[docs/PLAN_INPUT_AND_FIXTURES.md](../../docs/PLAN_INPUT_AND_FIXTURES.md)。

## 用途

MySQL 属于 Adapter Roadmap；其 fixture 的核心作用是**验证跨数据库抽象是否成立**：
同一套 NormalizedPlan / Metrics / Rules 模型，能否同时承载 PostgreSQL 与 MySQL 的计划语义。

```text
raw plan → parser → normalized plan → metrics → findings
```

## Adapter Boundary 设计（尚未实现）

MySQL 接入时必须沿用现有依赖方向，不得让 Normalizer / Metrics / Rules 感知数据库差异：

```text
MySQL raw payload
   │
   ▼
mysql parser（新增，只负责 MySQL 字段映射）
   │
   ▼
ParsedPlan（引擎专有，结构对齐 src/core/postgres 的输出形状）
   │
   ▼
Normalizer 扩展（kind 映射 + engineSpecific）
   │
   ▼
复用现有 Metrics / Rules / Findings
```

约定的边界条件：

- `RawPlanInput.database` 目前只允许 `"postgresql"`（`SUPPORTED_DATABASES`）；扩展 MySQL 时必须同时扩展
  契约与 fixture 校验，不允许用 PG parser 兜底解析。
- `RawPlanInput.format` 目前只允许 `"json"`。MySQL 的 `EXPLAIN FORMAT=TREE` 与 classic 表格输出属于不同
  文本形态，需要显式的 format 值与对应 parser，不得塞进 `unknown`。
- `mode` 语义保持 `estimated` / `actual`；MySQL `EXPLAIN ANALYZE` 自 8.0.18 起存在，且语义与 PostgreSQL
  不同，须在 parser 层显式标注差异，不得伪装成 PostgreSQL 的 Actual 语义。
- `NormalizedPlan` 的公共字段（`estimatedRows` / `actualRows` / `loops` / `cost` / `children` / join 条件 /
  index 信息）是跨库契约；MySQL 专有字段（`select_type`、`type`、`Extra` 等）进入 `engineSpecific`，
  不强行统一、也不丢弃。
- 每条规则只能依赖 NormalizedPlan 公共字段，不能因为某个规则"只对 PG 有意义"而在 Metrics / Rules 中
  引入数据库分支。

## 计划中的样本类型

| 类型 | 说明 | 获取方式 |
| --- | --- | --- |
| classic | 传统 `EXPLAIN` 表格输出（id / select_type / type / key / rows / Extra） | 真实实例采集 |
| json | `EXPLAIN FORMAT=JSON` 输出 | 真实实例采集 |
| tree | `EXPLAIN FORMAT=TREE` 输出 | 真实实例采集 |
| analyze | `EXPLAIN ANALYZE` 输出（注：8.0.18+ 才有，且语义与 PG 不同） | 真实实例采集（采集时显式触发；插件不执行） |
| minimal | 人工构造的最小结构样本 | 手工编写，必须标注 |

## 约定

- 一个样本一个文件，原始输出单独保存，不在采集时人工改写。
- 每个样本配套元数据：MySQL 版本、是否实际执行、是否裁剪、目标分析结论。
- 人工构造的样本必须显式标注为构造样本，不得冒充真实采集数据。
- 不放入任何包含真实生产数据、凭据或连接串的内容。
- 与 PostgreSQL 样本可对应的场景（例如同样的表结构与查询），应记录对应关系，便于验证抽象一致性。
