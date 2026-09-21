# README 截图规划

当前仓库暂时没有可直接复用的真实 DBX UI 截图。README 不放 mock 图片，也不引用尚未提交的路径。

## 建议文件

| 文件 | 建议内容 |
| --- | --- |
| `01-overview.png` | Plan Detective 主工作台：连接上下文、SQL 输入、Plan Summary 与分析入口。 |
| `02-findings.png` | Findings / Hotspots 区域：展示真实的规则提示、证据和检查方向。 |
| `03-plan-tree.png` | Plan Tree / Node Inspector / Raw Plan 区域：展示结构化计划树与原始计划查看。 |

## 采集要求

- 使用真实 DBX 宿主和已打开的测试连接，不使用 mock UI 冒充产品截图。
- 优先使用 PostgreSQL 或 MySQL 的 structured plan，确保截图中的内容与 README 支持矩阵一致。
- 遮盖连接名称、主机、数据库名、表名、SQL 中的业务数据以及其他敏感信息。
- 保留 Estimated Plan、Finding / Hotspot 的边界文案；不要把截图内容表达成真实运行时数据。
- 采集后将三张图片放入本目录，再在根目录 README 的“截图”章节添加图片引用。
