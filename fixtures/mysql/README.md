# MySQL Fixtures

本目录用于存放 MySQL 执行计划的**离线样本**，作为 Parser、Metrics、Rule Engine 与 UI 的一等开发与测试输入。

> **当前状态：仅占位，尚未放入任何计划样本。**
> 本次项目初始化不伪造执行计划样本。样本将在 MySQL Adapter 阶段按需加入。

## 用途

MySQL 是第二批目标数据库，其 fixture 的核心作用是**验证跨数据库抽象是否成立**：
同一套 Normalized Plan 与 Metrics 模型，能否同时承载 PostgreSQL 与 MySQL 的计划语义。

```text
raw plan → normalized plan → metrics → findings
```

## 计划中的样本类型

| 类型 | 说明 | 获取方式 |
| --- | --- | --- |
| classic | 传统 `EXPLAIN` 表格输出（id / select_type / type / key / rows / Extra） | 真实实例采集 |
| json | `EXPLAIN FORMAT=JSON` 输出 | 真实实例采集 |
| tree | `EXPLAIN FORMAT=TREE` 输出 | 真实实例采集 |
| analyze | `EXPLAIN ANALYZE` 输出（注：8.0.18+ 才有，且语义与 PG 不同） | 真实实例采集，需显式触发 |
| minimal | 人工构造的最小结构样本 | 手工编写，必须标注 |

## 约定

- 一个样本一个文件，原始输出单独保存，不在采集时人工改写。
- 每个样本配套元数据：MySQL 版本、是否实际执行、是否裁剪、目标分析结论。
- 人工构造的样本必须显式标注为构造样本，不得冒充真实采集数据。
- 不放入任何包含真实生产数据、凭据或连接串的内容。
- 与 PostgreSQL 样本可对应的场景（例如同样的表结构与查询），应记录对应关系，便于验证抽象一致性。
