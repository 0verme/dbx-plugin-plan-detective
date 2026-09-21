import { MESSAGE_CATALOG } from "./messages.js";

export const DEFAULT_LOCALE = "zh-CN";
export const SUPPORTED_LOCALES = Object.freeze(["zh-CN", "en"]);

/**
 * Keep the runtime locale deliberately small. DBX may report a regional
 * locale, while the first catalog only has Chinese and English.
 *
 * @param {unknown} locale
 * @returns {"zh-CN"|"en"}
 */
export function normalizeLocale(locale) {
  if (typeof locale !== "string") return DEFAULT_LOCALE;
  const normalized = locale.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  return DEFAULT_LOCALE;
}

/**
 * Create the small translator used by Finding Presentation. Missing messages
 * first fall back to the default catalog and then to the key itself.
 *
 * @param {unknown} locale
 * @param {Record<string, Record<string, string>>} [catalog]
 * @returns {{ locale: "zh-CN"|"en", t: (key: string, params?: Record<string, unknown>) => string }}
 */
export function createTranslator(locale, catalog = MESSAGE_CATALOG) {
  const resolvedLocale = normalizeLocale(locale);
  const selected = catalog[resolvedLocale] ?? {};
  const fallback = catalog[DEFAULT_LOCALE] ?? {};

  return {
    locale: resolvedLocale,
    t(key, params = {}) {
      const template = selected[key] ?? fallback[key] ?? key;
      return interpolateMessage(template, params);
    },
  };
}

/**
 * Interpolate only named values. Catalogs cannot execute logic: they receive
 * already-decided facts and only turn them into a sentence.
 *
 * @param {string} template
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export function interpolateMessage(template, params = {}) {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (placeholder, name) => {
    const value = params[name];
    return value === null || value === undefined ? placeholder : String(value);
  });
}
