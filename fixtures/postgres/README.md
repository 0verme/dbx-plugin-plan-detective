# PostgreSQL Fixtures

本目录用于存放 PostgreSQL 执行计划的**离线样本**，作为 Parser、Metrics、Rule Engine 与 UI 的一等开发与测试输入。

> **当前状态：仅占位，尚未放入任何计划样本。**
> 本次项目初始化不伪造执行计划样本。样本将在 Phase 1 起按需加入。

## 用途

```text
raw plan → normalized plan → metrics → findings
```

配合 fixture，即使没有真实 PostgreSQL 环境，也能开发和回归大部分解析与分析逻辑。

## 计划中的样本类型

| 类型 | 说明 | 获取方式 |
| --- | --- | --- |
| estimated | `EXPLAIN` 输出的文本计划 | 真实实例采集 |
| actual | `EXPLAIN (ANALYZE, ...)` 输出 | 真实实例采集，需显式触发 |
| json | `EXPLAIN (FORMAT JSON)` 输出 | 真实实例采集 |
| minimal | 人工构造的最小结构样本 | 手工编写，必须标注 |

## 约定

- 一个样本一个文件，原始输出单独保存，不在采集时人工改写。
- 每个样本配套元数据：数据库版本、是否实际执行、是否裁剪、目标分析结论。
- 人工构造的样本必须显式标注为构造样本，不得冒充真实采集数据。
- 不放入任何包含真实生产数据、凭据或连接串的内容。
