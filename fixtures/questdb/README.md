# QuestDB EXPLAIN fixtures

These samples exercise the DBX Host's QuestDB contract: `dbType: "questdb"`,
`format: "text"`, `mode: "estimated"`, with the host-generated
`EXPLAIN <source SQL>` returned as a raw text string.

## Provenance

- **Official (3):** `ordered-backward`, `async-jit-filter`, and `interval-scan`
  are transcribed from the [official QuestDB EXPLAIN documentation](https://questdb.com/docs/query/sql/explain/).
  Accessed / transcribed on **2026-09-23**. The doc examples are not local database
  captures and were not executed here.
- **Synthetic (3):** `asof-two-scans.synthetic`,
  `inline-properties.synthetic`, and `future-operator.synthetic` are hand-written
  contract / edge-case samples. They were not executed against QuestDB.
- **Real local QuestDB captures: 0.** No QuestDB instance was available for this
  task; official and synthetic samples are never described as a real Host smoke.

The official EXPLAIN documentation describes output as a tree of nodes with
properties and children. `PageFrame` contains a row cursor and a frame cursor;
this is one relation-access pipeline, not three separate table scans. The
normalizer counts only the Frame / Interval access node once per relation; the
PageFrame and Row cursor remain visible structural nodes without scan metrics.

Unknown operators, standalone properties, and supported inline properties are
preserved. QuestDB's documented examples do not supply PostgreSQL-style cost or
estimated-row values, so fixtures expect no inferred costs, rows, Findings, or
Hotspots. See the `.meta.json` sidecars for per-fixture provenance and assertions.
