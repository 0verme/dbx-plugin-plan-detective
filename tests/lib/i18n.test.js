import assert from "node:assert/strict";
import test from "node:test";
import { MESSAGE_CATALOG } from "../../src/lib/i18n/messages.js";
import { createTranslator, DEFAULT_LOCALE, interpolateMessage, normalizeLocale, SUPPORTED_LOCALES } from "../../src/lib/i18n/index.js";
import {
  LOCALE_PREFERENCE_STORAGE_KEY,
  readLocalePreference,
  resolveLocalePreference,
  saveLocalePreference,
} from "../../src/lib/i18n/locale-preference.js";

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

test("locale preference precedence is manual, stored, host, then default", () => {
  assert.equal(resolveLocalePreference({ hostLocale: "en-US" }), "en");
  assert.equal(resolveLocalePreference({ hostLocale: "zh-CN" }), "zh-CN");
  assert.equal(resolveLocalePreference({ hostLocale: "fr-FR" }), "zh-CN");
  assert.equal(resolveLocalePreference({ storedLocale: "en", hostLocale: "zh-CN" }), "en");
  assert.equal(resolveLocalePreference({ manualLocale: "zh-CN", storedLocale: "en", hostLocale: "en-US" }), "zh-CN");
  assert.equal(resolveLocalePreference({ storedLocale: "unknown", hostLocale: "en-US" }), "en");
  assert.equal(resolveLocalePreference({}), "zh-CN");
});

test("repeated host locale updates never override a manual selection or saved preference", () => {
  const manualLocale = "en";
  const storedLocale = "zh-CN";
  for (const hostLocale of ["zh-CN", "en-US", "fr-FR", undefined]) {
    assert.equal(resolveLocalePreference({ manualLocale, storedLocale, hostLocale }), "en");
  }

  for (const hostLocale of ["en-US", "zh-CN", "de-DE"]) {
    assert.equal(resolveLocalePreference({ storedLocale: "zh-CN", hostLocale }), "zh-CN");
  }
});

test("locale preference persistence normalizes recognized locales and safely handles blocked storage", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  assert.equal(readLocalePreference(storage), null);
  assert.equal(saveLocalePreference("en-US", storage), true);
  assert.equal(values.get(LOCALE_PREFERENCE_STORAGE_KEY), "en");
  assert.equal(readLocalePreference(storage), "en");
  assert.equal(saveLocalePreference("zh-CN", storage), true);
  assert.equal(readLocalePreference(storage), "zh-CN");

  const denied = {
    getItem() { throw new Error("storage blocked"); },
    setItem() { throw new Error("storage blocked"); },
  };
  assert.equal(readLocalePreference(denied), null);
  assert.equal(saveLocalePreference("en", denied), false);
  assert.equal(resolveLocalePreference({ manualLocale: "en", hostLocale: "zh-CN" }), "en");
  assert.equal(readLocalePreference(null), null);
  assert.equal(saveLocalePreference("en", null), false);
});

test("both catalogs have complete key and interpolation parity", () => {
  const zh = MESSAGE_CATALOG["zh-CN"];
  const en = MESSAGE_CATALOG.en;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of Object.keys(zh)) {
    assert.equal(typeof zh[key], "string", `zh-CN: ${key}`);
    assert.equal(typeof en[key], "string", `en: ${key}`);
    assert.ok(zh[key].length > 0, `zh-CN: ${key}`);
    assert.ok(en[key].length > 0, `en: ${key}`);
    const placeholders = (value) => [...value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `interpolation placeholders: ${key}`);
    if (key !== "locale.switcher.chinese") assert.doesNotMatch(en[key], /\p{Script=Han}/u, `English copy: ${key}`);
  }
});

test("translator falls back to the default locale and then to the key", () => {
  const translator = createTranslator("en", {
    "zh-CN": { known: "默认 {value}" },
    en: {},
  });

  assert.equal(translator.t("known", { value: "值" }), "默认 值");
  assert.equal(translator.t("missing"), "missing");
});
