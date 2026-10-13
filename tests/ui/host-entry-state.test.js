import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { describeConnectionContext } from "../../src/lib/host-view-model.js";
import { describeHostEntryState, HOST_ENTRY_STATES } from "../../src/lib/host-entry-state.js";
import { createTranslator } from "../../src/lib/i18n/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appSource = await readFile(path.join(root, "src/App.svelte"), "utf8");
const EMPTY_COPY_KEYS = [
  "app.empty.title",
  "app.empty.description",
  "app.empty.path.ariaLabel",
  "app.empty.path.connection",
  "app.empty.path.execute",
  "app.empty.path.results",
  "app.empty.path.plugin",
  "app.empty.helper",
  "app.empty.manual",
  "app.context.loading",
  "app.context.needsSql",
  "app.context.needsConnection",
  "app.entry.returnToGuide",
];

function classify(overrides = {}) {
  return describeHostEntryState({
    contextReady: true,
    planApiState: "available",
    planApiAvailable: true,
    ...overrides,
  });
}

test("waits for Host initialization instead of briefly showing the empty state", () => {
  assert.equal(classify({ contextReady: false, hasContext: false }), HOST_ENTRY_STATES.loading);
  assert.equal(classify({ planApiState: "initializing", hasContext: false }), HOST_ENTRY_STATES.loading);
  assert.equal(classify({ hasContext: false }), HOST_ENTRY_STATES.empty);
});

test("a complete result-view context opens the existing analysis workbench", () => {
  const context = describeConnectionContext({
    connectionId: "conn-1",
    database: "analytics",
    sql: "SELECT 1",
    result: { columns: ["value"], rows: [[1]] },
  });

  assert.equal(context.source, "result-view");
  assert.equal(
    classify({ hasContext: context.hasConnection || context.contextSql !== null, connectionId: context.connectionId, sql: context.contextSql }),
    HOST_ENTRY_STATES.ready,
  );
});

test("partial DBX context is retained and classified by the missing value", () => {
  const connectionOnly = describeConnectionContext({ connectionId: "conn-1" });
  assert.equal(
    classify({ hasContext: connectionOnly.hasConnection, connectionId: connectionOnly.connectionId, sql: "" }),
    HOST_ENTRY_STATES.needsSql,
  );

  const sqlOnly = describeConnectionContext({ sql: "SELECT 1" });
  assert.equal(sqlOnly.contextSql, "SELECT 1");
  assert.equal(
    classify({ hasContext: sqlOnly.contextSql !== null, connectionId: null, sql: sqlOnly.contextSql }),
    HOST_ENTRY_STATES.needsConnection,
  );
});

test("manual entry is separate from first-use guidance and never erases existing values", () => {
  assert.equal(classify({ hasContext: false, manualMode: false }), HOST_ENTRY_STATES.empty);
  assert.equal(classify({ hasContext: false, manualMode: true }), HOST_ENTRY_STATES.manual);
  assert.equal(
    classify({ hasContext: false, manualMode: true, connectionId: "manual-conn", sql: "SELECT 1" }),
    HOST_ENTRY_STATES.ready,
  );
  assert.equal(
    classify({ hasContext: false, manualMode: false, connectionId: "manual-conn", sql: "SELECT 1" }),
    HOST_ENTRY_STATES.empty,
    "returning to the guide hides, but does not clear, the manual values",
  );

  assert.match(appSource, /onclick=\{\(\) => \(manualMode = true\)\}/u);
  assert.match(appSource, /if \(sqlText\.length === 0 && typeof contextSql === "string"/u);
});

test("unsupported Host Plan API is distinct from missing SQL or connection", () => {
  assert.equal(
    describeHostEntryState({ contextReady: true, planApiState: "unavailable", planApiAvailable: false, hasContext: false }),
    HOST_ENTRY_STATES.unavailable,
  );
});

test("the first-use branch excludes the analysis workbench and its technical panels", () => {
  const start = appSource.indexOf('{:else if hostEntryState === "empty"}');
  const end = appSource.indexOf("{:else}", start);
  assert.ok(start >= 0 && end > start, "the empty-state branch is present");
  const branch = appSource.slice(start, end);
  assert.match(branch, /class="empty-state"/u);
  assert.match(branch, /app\.empty\.title/u);
  assert.match(branch, /app\.empty\.manual/u);
  assert.doesNotMatch(branch, /<ConnectionContext|<SqlInput|<PlanAnalysisLayout|<RawPlanViewer/u);

  assert.match(appSource, /hostContextReady = \$state\(bridge === null \|\| initialPlanApi\.state === "unavailable"\)/u);
  assert.match(appSource, /hostContextReady = true;/u);
});

test("new entry guidance is fully localized in Simplified Chinese and English", () => {
  const zh = createTranslator("zh-CN").t;
  const en = createTranslator("en").t;
  for (const key of EMPTY_COPY_KEYS) {
    assert.notEqual(zh(key), key, `Chinese translation for ${key}`);
    assert.notEqual(en(key), key, `English translation for ${key}`);
  }

  assert.equal(zh("app.empty.title"), "请先选择一条 SQL 进行分析");
  assert.equal(zh("app.empty.path.connection"), "打开数据库连接");
  assert.match(zh("app.empty.helper"), /无需重新执行原查询/u);
  assert.match(en("app.empty.helper"), /original query is not run again/u);
  assert.match(en("app.context.needsConnection"), /preserved/u);
});
