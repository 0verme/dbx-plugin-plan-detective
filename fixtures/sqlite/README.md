# SQLite Fixtures

Only `estimated/` is present: DBX Host API ([t8y2/dbx#14885](https://github.com/t8y2/dbx/pull/14885)) executes `EXPLAIN QUERY PLAN <sql>` for `dbType: "sqlite"` and returns `format: "json"` with `rawPlan` as an array of structured row objects (`{ id, parent, notused, detail }`).

## Provenance

- 5 `locally-generated` fixtures captured from a throwaway in-memory SQLite `3.54.0` instance (`table-scan`, `index-search`, `covering-index-search`, `join-temp-btree-order`, `compound-cte-subquery`).
- 1 `synthetic` fixture (`automatic-index-unknown.synthetic`) covering `USING INTEGER PRIMARY KEY`, `USING AUTOMATIC COVERING INDEX`, `MULTI-INDEX OR`, `USE TEMP B-TREE FOR GROUP BY`, and unknown future EQP `detail` retention.
- SQLite `EXPLAIN QUERY PLAN` does not report estimated row counts or cost numbers; all row/cost fields remain `null`.
