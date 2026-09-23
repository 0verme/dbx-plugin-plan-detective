# OceanBase MySQL Fixtures

本目录固定 OceanBase MySQL compatibility mode 的 Estimated JSON plan。Plan Core family 为 `oceanbase-mysql`，与 `oceanbase-oracle` 区分，但两者共用 OceanBase JSON parser / normalizer。

## Provenance

`estimated/mysql-mode-full-scan.plan.json` 是本 Issue 问题报告提供的真实 OceanBase 4.2.5.7 MySQL compatibility-mode 脱敏样本。原始 DB version 为 `5.7.25-OceanBase-v4.2.5.7`；业务表名采用报告中的脱敏名 `t_field_error_log`。报告未提供原始 SQL、采集日期或完整 capture command，因此 metadata 中相应字段保留为 `null`，不补造来源信息。本环境没有真实 OceanBase 实例，未进行独立数据库回放。

样本保留 `ID`、`OPERATOR`、`NAME`、`EST.ROWS`、`EST.TIME(us)`、`output` 等 OceanBase operator-tree 字段，代表的不是原生 MySQL `query_block` 结构。Fixture metadata 使用既有 provenance contract 的 `source.kind: "real"`；family、版本和脱敏说明分别由 `database`、`databaseVersion` 与 `source.detail` 记录。
