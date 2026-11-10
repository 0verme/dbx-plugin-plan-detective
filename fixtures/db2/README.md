# DB2 LUW Estimated JSON fixtures

- `estimated/shared-temp-plan.plan.json` is copied from the DBX upstream desktop test fixture [`db2-shared-temp-plan.json`](https://github.com/t8y2/dbx/blob/main/apps/desktop/src/lib/__tests__/query/fixtures/db2-shared-temp-plan.json). It demonstrates the DBX Agent JSON v1 envelope, DB2 operators / streams / predicates, high-precision decimal strings, and a shared producer. The upstream fixture does not state how its original plan was captured; this repository did not execute SQL or independently verify a DB2 database.
- `estimated/simple-select.synthetic.plan.json` and `estimated/index-join-sort-aggregate.synthetic.plan.json` are hand-authored contract fixtures based on the DBX upstream reader/viewer shape. They are explicitly synthetic and are not captures from a DB2 instance.

All fixtures cover the **DB2 LUW** Agent contract only. They do not establish support for Db2 for z/OS or Db2 for i, and they do not constitute DBX Desktop / DB2 Agent end-to-end verification.
