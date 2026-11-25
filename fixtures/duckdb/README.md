# DuckDB EXPLAIN Fixtures

Only `estimated/` is present: DBX Host API ([t8y2/dbx#14899](https://github.com/t8y2/dbx/pull/14899)) executes `EXPLAIN <sql>` for `dbType: "duckdb"` and returns `format: "text"` with `rawPlan` containing the box-rendered physical plan text.

## Provenance

- **Official (1):** `official-hash-join-filter` is transcribed from the [official DuckDB EXPLAIN documentation](https://duckdb.org/docs/stable/guides/meta/explain). It is a documentation transcription, not a local database capture, so capture metadata fields remain `null`.
- **Synthetic (4):** `seq-scan-order-by.synthetic`, `large-seq-scan.synthetic`, `rounded-box-group-by.synthetic`, and `unknown-operator.synthetic` cover the `physical_plan` prefix, `ORDER_BY`, high-`EC` `SEQ_SCAN`, modern rounded-box rendering (`╭─ ... ─╮` with `~N rows` and routing bus connectors), `HASH_GROUP_BY`, `PARQUET_SCAN`, `INDEX_SCAN`, and unknown operator retention.
- **Real local DuckDB captures: 0.** No local DuckDB worker was executed in this workspace; official and synthetic fixtures are never described as a live DBX Desktop E2E test.
