import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator, DEFAULT_LOCALE, interpolateMessage, normalizeLocale, SUPPORTED_LOCALES } from "../../src/lib/i18n/index.js";

test("locale normalization keeps the first catalog intentionally small", () => {
  assert.deepEqual([...SUPPORTED_LOCALES], ["zh-CN", "en"]);
  assert.equal(DEFAULT_LOCALE, "zh-CN");
  assert.equal(normalizeLocale("zh-CN"), "zh-CN");
  assert.equal(normalizeLocale("zh"), "zh-CN");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("en"), "en");
  assert.equal(normalizeLocale("fr-FR"), "zh-CN");
  assert.equal(normalizeLocale(null), "zh-CN");
});

test("translator interpolates values without moving detection logic into the catalog", () => {
  const translator = createTranslator("en-US");
  assert.equal(translator.locale, "en");
  assert.equal(translator.t("finding.largeSequentialScan.summary", { relation: "events", estimatedRows: "101,885" }), "events is estimated to scan about 101,885 rows.");
  assert.equal(interpolateMessage("{count} rows / {missing}", { count: 3 }), "3 rows / {missing}");
});

test("translator falls back to the default locale and then to the key", () => {
  const translator = createTranslator("en", {
    "zh-CN": { known: "默认 {value}" },
    en: {},
  });

  assert.equal(translator.t("known", { value: "值" }), "默认 值");
  assert.equal(translator.t("missing"), "missing");
});
