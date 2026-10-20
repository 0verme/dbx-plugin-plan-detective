import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium } from "playwright";
import { createPlanSnapshot } from "../../src/lib/plan-snapshot.js";
import { PLAN_SNAPSHOT_STORAGE_KEY } from "../../src/lib/plan-snapshot-store.js";

// Real Chromium DOM + the real production App/Svelte bundle and Repository.
// Only the public DBX bridge is a test double: these are NOT Desktop acceptance.
const root = fileURLToPath(new URL("../../", import.meta.url));
let output;
let browser;
let bundle;
let css;

before(async () => {
  output = await mkdtemp(path.join(tmpdir(), "snapshot-dom-"));
  await build({ root, logLevel: "error", build: { outDir: output, emptyOutDir: true } });
  const assets = await readdir(path.join(output, "assets"));
  bundle = await readFile(path.join(output, "assets", assets.find((name) => name.endsWith(".js"))), "utf8");
  css = await readFile(path.join(output, "assets", assets.find((name) => name.endsWith(".css"))), "utf8");
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (output) await rm(output, { recursive: true, force: true });
});

function installTestHost({ key, initialDocument = null, connected = true, holdReads = false, holdSet = false, failSet = false, holdPostSaveRead = false }) {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const values = { [key]: initialDocument, "unrelated.preferences": { keep: "untouched" } };
  const control = window.snapshotTest = {
    values, gets: [], sets: [], planCalls: 0, reports: [], holdReads, holdSet, failSet, holdPostSaveRead,
    releaseReads: [], releaseSet: null, readsAfterWrite: 0,
  };
  window.dbxPlugin = {
    locale: "en", ready: Promise.resolve(), capabilities: { planApi: true, storage: true },
    context: connected ? { connectionId: "test-connection", sql: "SELECT * FROM orders", database: "analytics", schema: "public" } : null,
    async getPlanCapabilities() {
      return { dbType: "postgres", dbVersion: "17.2", supports: { estimatedPlan: true }, limits: { maxTimeoutMs: 60000, maxPlanBytes: 4194304 } };
    },
    async explainPlan() {
      control.planCalls += 1;
      // Synthetic parser input, never represented as a real database capture.
      return { dbType: "postgres", dbVersion: "17.2", format: "json", truncated: false, warnings: [], rawPlan: [
        { Plan: { "Node Type": "Seq Scan", "Relation Name": "orders", "Plan Rows": 18, "Startup Cost": 0, "Total Cost": 10, "Plan Width": 8 } },
      ] };
    },
    async request(method, { text }) {
      if (method !== "host.copy") throw new Error("Unexpected Host request");
      control.reports.push(JSON.parse(text));
    },
    storage: {
      async get(storageKey) {
        control.gets.push(storageKey);
        if (control.sets.length > 0) control.readsAfterWrite += 1;
        if (control.holdReads || (control.holdPostSaveRead && control.readsAfterWrite >= 2)) {
          await new Promise((resolve) => control.releaseReads.push(resolve));
        }
        return clone(values[storageKey] ?? null);
      },
      async set(storageKey, value) {
        control.sets.push(storageKey);
        if (control.failSet) throw new Error("Host write failed SENSITIVE_HOST_TEXT");
        if (control.holdSet) await new Promise((resolve) => { control.releaseSet = resolve; });
        values[storageKey] = clone(value);
      },
      async delete() { throw new Error("Save must not delete Storage data"); },
    },
  };
}

async function app(t, options = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "no uncaught event errors");
  });
  const configuration = { key: PLAN_SNAPSHOT_STORAGE_KEY, ...options };
  const html = `<!doctype html><html><head><style>${css}</style></head><body><div id="app"></div><script>(${installTestHost})(${JSON.stringify(configuration)});</script><script type="module">${bundle.replaceAll("</script", "<\\/script")}</script></body></html>`;
  let frame = page;
  if (options.sandbox === false) {
    await page.setContent(html);
  } else {
    // Matches DBX PluginWorkbenchHost.vue: no allow-forms or allow-same-origin.
    await page.setContent('<iframe sandbox="allow-scripts" style="width:100%;height:95vh;border:0"></iframe>');
    await page.locator("iframe").evaluate((iframe, source) => { iframe.srcdoc = source; }, html);
    frame = page.frames()[1];
  }
  await frame.getByRole("button", { name: "Copy diagnostic log", exact: true }).waitFor();
  return frame;
}

async function openSave(frame) {
  await frame.getByRole("button", { name: "Analyze Plan", exact: true }).click();
  await frame.getByRole("button", { name: "Save snapshot", exact: true }).click();
  return {
    form: frame.locator(".snapshot-save-panel form"),
    title: frame.locator(".snapshot-save-panel input"),
    note: frame.locator(".snapshot-save-panel textarea"),
    submit: frame.locator('.snapshot-save-panel button[type="submit"]'),
  };
}

async function log(frame) {
  await frame.getByRole("button", { name: "Copy diagnostic log", exact: true }).click();
  return frame.evaluate(() => window.snapshotTest.reports.at(-1));
}

const hasStep = (trace, step) => trace.events.some((event) => event.step === step);
const historyButton = (frame, count) => frame.getByRole("button", { name: `History (${count})`, exact: true });
const saved = async (frame, count = 1) => {
  await frame.getByText("Snapshot saved.", { exact: true }).waitFor();
  await historyButton(frame, count).waitFor();
};

test("DBX's allow-scripts sandbox blocks native default submission and requestSubmit before submit/invalid", async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.setContent('<iframe sandbox="allow-scripts"></iframe>');
  await page.locator("iframe").evaluate((iframe) => {
    iframe.srcdoc = `<form><input required value="valid"><button type="submit">Save</button></form><script>
      window.counts={click:0,submit:0,invalid:0};
      document.querySelector('button').onclick=()=>counts.click++;
      document.querySelector('form').onsubmit=e=>{e.preventDefault();counts.submit++};
      document.addEventListener('invalid',()=>counts.invalid++,true);
    </script>`;
  });
  const frame = page.frames()[1];
  const submit = frame.getByRole("button", { name: "Save", exact: true });
  await submit.click();
  assert.deepEqual(await submit.evaluate((button) => ({ associated: button.form === document.querySelector("form"), disabled: button.disabled, valid: button.form.checkValidity() })), { associated: true, disabled: false, valid: true });
  await frame.locator("input").press("Enter");
  await frame.locator("input").fill(""); // Even required/invalid never fires on this sandboxed native path.
  await frame.locator("form").evaluate((form) => form.requestSubmit());
  assert.deepEqual(await frame.evaluate(() => window.counts), { click: 2, submit: 0, invalid: 0 });
  assert.ok(consoleErrors.some((message) => message.includes("allow-forms")), "the browser identifies the sandbox restriction");
});

test("a real click in the opaque DBX sandbox reaches capture and submit, saves once, and adds history", async (t) => {
  const frame = await app(t);
  const { title, note, submit } = await openSave(frame);
  await title.fill("DOM baseline");
  await note.fill("Keep this note");
  assert.equal(await submit.evaluate((button) => button.form === document.querySelector(".snapshot-save-panel form")), true);
  assert.equal(await submit.isDisabled(), false);
  await submit.click();
  await saved(frame);
  const report = await log(frame);
  const trace = report.latestSaveTrace;
  assert.equal(trace.status, "completed");
  const expected = ["SNAPSHOT_UI_CLICK", "SNAPSHOT_FORM_VALIDATION_RESULT", "SNAPSHOT_FORM_SUBMIT_DISPATCH", "SNAPSHOT_FORM_SUBMIT_CAPTURE", "SNAPSHOT_FORM_SUBMIT", "SNAPSHOT_SAVE_GATE_START", "SNAPSHOT_CREATE_START", "SNAPSHOT_STORAGE_SET_START", "SNAPSHOT_UI_SUCCESS"];
  const indices = expected.map((step) => trace.events.findIndex((event) => event.step === step));
  assert.ok(indices.every((index, position) => index >= 0 && (position === 0 || index > indices[position - 1])));
  const click = trace.events.find((event) => event.step === "SNAPSHOT_UI_CLICK");
  assert.equal(click.formAssociated, true);
  assert.equal(click.formConnected, true);
  assert.equal(click.domTitlePresent, true);
  assert.equal(click.disabledStateMismatch, false);
  assert.equal(click.framed, true);
  const capture = trace.events.find((event) => event.step === "SNAPSHOT_FORM_SUBMIT_CAPTURE");
  assert.equal(capture.eventTrusted, false, "application DOM dispatch is not misrepresented as native/trusted");
  assert.ok(report.recentTraces.some((entry) => entry.kind === "history" && entry.status === "completed"));
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 1);
  await historyButton(frame, 1).click();
  await frame.locator(".snapshot-item h3").getByText("DOM baseline", { exact: true }).waitFor();
});

test("native required validation is captured, shown, and blocked without entering submit or Storage", async (t) => {
  const frame = await app(t);
  const { title, note, submit } = await openSave(frame);
  await submit.click();
  await frame.getByRole("alert").filter({ hasText: "Check the snapshot name" }).waitFor();
  let trace = (await log(frame)).latestSaveTrace;
  assert.equal(trace.status, "blocked");
  assert.equal(hasStep(trace, "SNAPSHOT_FORM_SUBMIT"), false);
  assert.ok(trace.events.some((event) => event.invalidField === "title" && event.valueMissing));
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 0);
  await title.fill("After validation");
  await note.fill("Retained notes");
  await submit.click();
  await saved(frame);
  trace = (await log(frame)).latestSaveTrace;
  assert.equal(trace.status, "completed");
});

test("invalid is captured from textarea too, with visible feedback and no sensitive validation text", async (t) => {
  const frame = await app(t);
  const { title, note, submit } = await openSave(frame);
  await title.fill("Valid title");
  await note.fill("Retain me");
  await note.evaluate((input) => input.setCustomValidity("SENSITIVE_VALIDATION_TEXT"));
  await submit.click();
  await frame.getByRole("alert").waitFor();
  const report = await log(frame);
  const trace = report.latestSaveTrace;
  assert.equal(trace.status, "blocked");
  assert.ok(trace.events.some((event) => event.invalidField === "note" && event.customError));
  assert.equal(hasStep(trace, "SNAPSHOT_FORM_SUBMIT"), false);
  assert.equal(JSON.stringify(report).includes("SENSITIVE_VALIDATION_TEXT"), false);
  assert.equal(await title.inputValue(), "Valid title");
  assert.equal(await note.inputValue(), "Retain me");
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 0);
});

test("Enter implicitly activates the submit button in the sandbox; Enter in textarea remains multiline", async (t) => {
  const frame = await app(t);
  const { title, note } = await openSave(frame);
  await title.fill("Enter submission");
  await note.fill("First line");
  await note.press("Enter");
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 0);
  assert.equal(await note.inputValue(), "First line\n");
  await title.press("Enter");
  await saved(frame);
  const trace = (await log(frame)).latestSaveTrace;
  assert.equal(hasStep(trace, "SNAPSHOT_FORM_SUBMIT"), true);
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 1);
});

test("Space keyboard activation of the real submit button also saves", async (t) => {
  const frame = await app(t);
  const { title, submit } = await openSave(frame);
  await title.fill("Keyboard space");
  await submit.focus();
  await submit.press("Space");
  await saved(frame);
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 1);
});

test("rapid real double click writes once and keeps genuinely pending Host set pending and busy", async (t) => {
  const frame = await app(t, { holdSet: true });
  const { title, note, submit } = await openSave(frame);
  await title.fill("Only once");
  await submit.dblclick();
  await frame.waitForFunction(() => window.snapshotTest.sets.length === 1);
  assert.equal(await title.isDisabled(), true);
  assert.equal(await note.isDisabled(), true);
  assert.equal(await submit.isDisabled(), true);
  assert.equal(await frame.locator(".snapshot-save-panel").getAttribute("aria-busy"), "true");
  const trace = (await log(frame)).latestSaveTrace;
  assert.equal(trace.status, "pending");
  assert.equal(trace.finishedAt, null);
  assert.equal(trace.events.filter((event) => event.step === "SNAPSHOT_FORM_SUBMIT").length, 1);
  assert.equal(hasStep(trace, "SNAPSHOT_STORAGE_SET_START"), true);
  assert.equal(hasStep(trace, "SNAPSHOT_STORAGE_SET_END"), false);
  await frame.evaluate(() => window.snapshotTest.releaseSet());
  await saved(frame);
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 1);
});

test("save failure leaves typed inputs intact, clears busy, and never automatically repeats the write", async (t) => {
  const frame = await app(t, { failSet: true });
  const { title, note, submit } = await openSave(frame);
  await title.fill("Keep title after error");
  await note.fill("Keep notes after error");
  await submit.click();
  await frame.getByRole("alert").waitFor();
  assert.equal(await title.inputValue(), "Keep title after error");
  assert.equal(await note.inputValue(), "Keep notes after error");
  assert.equal(await submit.isDisabled(), false);
  assert.equal(await frame.locator(".snapshot-save-panel").getAttribute("aria-busy"), "false");
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 1);
  assert.equal((await log(frame)).latestSaveTrace.status, "failed");
  await frame.evaluate(() => { window.snapshotTest.failSet = false; });
  await submit.click();
  await saved(frame);
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 2, "only the user's explicit retry writes again");
});

const legacySnapshot = createPlanSnapshot({
  session: { status: "structured", analysis: { status: "structured" }, hostResult: { truncated: false }, rawInput: {
    database: "postgresql", mode: "estimated", format: "json", sql: "SELECT * FROM orders", plan: [
      { Plan: { "Node Type": "Seq Scan", "Relation Name": "orders", "Plan Rows": 18, "Startup Cost": 0, "Total Cost": 10, "Plan Width": 8 } },
    ],
  } },
  snapshotId: "legacy-record", title: "Existing v1 snapshot", note: "Existing notes", producerVersion: "0.7.1", now: new Date("2026-10-14T01:00:00Z"),
});
const legacyStore = { storageSchemaVersion: 1, revision: 7, lastMutationId: "legacy-mutation", snapshots: [legacySnapshot] };

test("a DOM save preserves old v1 Storage records and unrelated keys exactly", async (t) => {
  const frame = await app(t, { initialDocument: legacyStore });
  await historyButton(frame, 1).waitFor();
  const { title, submit } = await openSave(frame);
  await title.fill("New v1 snapshot");
  await submit.click();
  await saved(frame, 2);
  const state = await frame.evaluate(() => ({ values: window.snapshotTest.values, sets: window.snapshotTest.sets }));
  assert.deepEqual(state.sets, [PLAN_SNAPSHOT_STORAGE_KEY]);
  const document = state.values[PLAN_SNAPSHOT_STORAGE_KEY];
  assert.equal(document.storageSchemaVersion, 1);
  assert.equal(document.revision, 8);
  assert.deepEqual(document.snapshots.find((entry) => entry.snapshotId === "legacy-record"), legacySnapshot);
  assert.deepEqual(state.values["unrelated.preferences"], { keep: "untouched" });
  await historyButton(frame, 2).click();
  assert.equal(await frame.locator(".snapshot-item").count(), 2);
});

test("history still opens without any connection or SQL execution", async (t) => {
  const frame = await app(t, { initialDocument: legacyStore, connected: false });
  await historyButton(frame, 1).click();
  await frame.locator(".snapshot-item").getByRole("button", { name: "Open history", exact: true }).click();
  await frame.locator(".snapshot-history h2").getByText("Existing v1 snapshot", { exact: true }).waitFor();
  assert.equal(await frame.evaluate(() => window.snapshotTest.planCalls), 0);
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 0);
});

test("initial history is pending only until the actual Host GET finishes, then completed", async (t) => {
  const frame = await app(t, { holdReads: true });
  await frame.waitForFunction(() => window.snapshotTest.gets.length > 0);
  let report = await log(frame);
  assert.ok(report.recentTraces.some((trace) => trace.kind === "history" && trace.status === "pending" && hasStep(trace, "SNAPSHOT_HOST_STORAGE_GET_START")));
  await frame.evaluate(() => {
    window.snapshotTest.holdReads = false;
    window.snapshotTest.releaseReads.forEach((resolve) => resolve());
  });
  await historyButton(frame, 0).waitFor();
  report = await log(frame);
  assert.ok(report.recentTraces.some((trace) => trace.kind === "history" && trace.status === "completed"));
  assert.equal(report.recentTraces.some((trace) => trace.kind === "history" && trace.status === "pending"), false);
});

test("confirmed save and still-pending background history have separate, truthful trace states", async (t) => {
  const frame = await app(t, { holdPostSaveRead: true });
  const { title, submit } = await openSave(frame);
  await title.fill("Confirmed before refresh");
  await submit.click();
  await saved(frame);
  await frame.waitForFunction(() => window.snapshotTest.releaseReads.length > 0);
  let report = await log(frame);
  assert.equal(report.latestSaveTrace.status, "completed");
  assert.equal(hasStep(report.latestSaveTrace, "SNAPSHOT_HISTORY_REFRESH_START"), false);
  assert.ok(report.recentTraces.some((trace) => trace.kind === "history" && trace.status === "pending"));
  await frame.evaluate(() => {
    window.snapshotTest.holdPostSaveRead = false;
    window.snapshotTest.releaseReads.forEach((resolve) => resolve());
  });
  await frame.waitForFunction(() => !document.querySelector('.snapshot-toolbar button:nth-child(2)').disabled);
  report = await log(frame);
  assert.ok(report.recentTraces.some((trace) => trace.kind === "history" && trace.status === "completed"));
});

test("native top-level requestSubmit still enters the same handler without a click trace", async (t) => {
  const frame = await app(t, { sandbox: false });
  const { form, title } = await openSave(frame);
  await title.fill("Native submit");
  await form.evaluate((element) => element.requestSubmit());
  await saved(frame);
  const trace = (await log(frame)).latestSaveTrace;
  assert.equal(hasStep(trace, "SNAPSHOT_UI_CLICK"), false);
  assert.equal(hasStep(trace, "SNAPSHOT_FORM_SUBMIT_CAPTURE"), true);
  assert.equal(hasStep(trace, "SNAPSHOT_FORM_SUBMIT"), true);
});

test("submit propagation interference is failed, visible, and does not leave a pending click", async (t) => {
  const frame = await app(t);
  const { form, title, submit } = await openSave(frame);
  await title.fill("Interrupted submit");
  await form.evaluate((element) => element.addEventListener("submit", (event) => event.stopImmediatePropagation(), true));
  await submit.click();
  await frame.getByRole("alert").filter({ hasText: "did not reach the save handler" }).waitFor();
  const trace = (await log(frame)).latestSaveTrace;
  assert.equal(trace.status, "failed");
  assert.equal(hasStep(trace, "SNAPSHOT_FORM_SUBMIT_CAPTURE"), true);
  assert.equal(hasStep(trace, "SNAPSHOT_FORM_SUBMIT"), false);
  assert.ok(trace.events.some((event) => event.errorCode === "FORM_SUBMIT_NOT_OBSERVED"));
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 0);
});

test("an incorrectly associated submit button is diagnosed before validation or persistence", async (t) => {
  const frame = await app(t);
  const { title, submit } = await openSave(frame);
  await title.fill("Wrong form");
  await submit.evaluate((button) => {
    const otherForm = document.createElement("form");
    otherForm.id = "foreign-form";
    document.body.append(otherForm);
    button.setAttribute("form", otherForm.id);
  });
  await submit.click();
  await frame.getByRole("alert").filter({ hasText: "not associated" }).waitFor();
  const trace = (await log(frame)).latestSaveTrace;
  assert.equal(trace.status, "failed");
  assert.ok(trace.events.some((event) => event.formAssociated === false));
  assert.ok(trace.events.some((event) => event.errorCode === "FORM_ASSOCIATION_MISMATCH"));
  assert.equal(hasStep(trace, "SNAPSHOT_FORM_SUBMIT"), false);
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 0);
});

test("synchronous DOM event exceptions are recorded without leaking raw text or clearing inputs", async (t) => {
  const frame = await app(t);
  const { form, title, submit } = await openSave(frame);
  await title.fill("Keep after DOM exception");
  await form.evaluate((element) => { element.reportValidity = () => { throw new Error("SENSITIVE_DOM_ERROR"); }; });
  await submit.click();
  await frame.getByRole("alert").waitFor();
  const report = await log(frame);
  assert.equal(report.latestSaveTrace.status, "failed");
  assert.equal(hasStep(report.latestSaveTrace, "SNAPSHOT_FORM_EVENT_ERROR"), true);
  assert.equal(JSON.stringify(report).includes("SENSITIVE_DOM_ERROR"), false);
  assert.equal(await title.inputValue(), "Keep after DOM exception");
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 0);
});

test("whitespace that passes native required still fails business validation before any write", async (t) => {
  const frame = await app(t);
  const { title, submit } = await openSave(frame);
  await title.fill("   ");
  await submit.click();
  await frame.getByRole("alert").waitFor();
  const trace = (await log(frame)).latestSaveTrace;
  assert.equal(hasStep(trace, "SNAPSHOT_FORM_SUBMIT"), true);
  assert.equal(hasStep(trace, "SNAPSHOT_CREATE_START"), true);
  assert.equal(trace.status, "failed");
  assert.equal(await frame.evaluate(() => window.snapshotTest.sets.length), 0);
  assert.equal(await title.inputValue(), "   ");
});
