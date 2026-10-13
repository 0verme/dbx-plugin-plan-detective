import { DEFAULT_LOCALE, normalizeLocale } from "./index.js";

export const LOCALE_PREFERENCE_STORAGE_KEY = "plan-detective.locale";

/**
 * Resolve the active locale using the application-wide precedence contract:
 * manual selection > persisted preference > DBX Host locale > default.
 * Unknown host locales intentionally normalize to the default locale.
 *
 * @param {{ manualLocale?: unknown, storedLocale?: unknown, hostLocale?: unknown, defaultLocale?: unknown }} options
 * @returns {"zh-CN"|"en"}
 */
export function resolveLocalePreference({
  manualLocale = null,
  storedLocale = null,
  hostLocale = null,
  defaultLocale = DEFAULT_LOCALE,
} = {}) {
  if (manualLocale !== null && manualLocale !== undefined) return normalizeLocale(manualLocale);
  if (isRecognizedLocale(storedLocale)) return normalizeLocale(storedLocale);
  if (hostLocale !== null && hostLocale !== undefined) return normalizeLocale(hostLocale);
  return normalizeLocale(defaultLocale);
}

/**
 * Read the optional user preference. Access to localStorage can throw in
 * restricted WebViews, so the UI treats every storage failure as no preference.
 *
 * @param {StorageLike|null|undefined} storage
 * @returns {"zh-CN"|"en"|null}
 */
export function readLocalePreference(storage = getBrowserStorage()) {
  if (!storage || typeof storage.getItem !== "function") return null;
  try {
    const value = storage.getItem(LOCALE_PREFERENCE_STORAGE_KEY);
    return isRecognizedLocale(value) ? normalizeLocale(value) : null;
  } catch {
    return null;
  }
}

/**
 * Persist a user selection when storage is available. The caller must still
 * apply the in-memory choice when this returns false.
 *
 * @param {unknown} locale
 * @param {StorageLike|null|undefined} storage
 * @returns {boolean}
 */
export function saveLocalePreference(locale, storage = getBrowserStorage()) {
  if (!storage || typeof storage.setItem !== "function") return false;
  try {
    storage.setItem(LOCALE_PREFERENCE_STORAGE_KEY, normalizeLocale(locale));
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} locale */
function isRecognizedLocale(locale) {
  if (typeof locale !== "string") return false;
  const normalized = locale.trim().toLowerCase().replaceAll("_", "-");
  return normalized === "en" || normalized.startsWith("en-") || normalized === "zh" || normalized.startsWith("zh-");
}

/** @returns {StorageLike|null} */
function getBrowserStorage() {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

/** @typedef {{ getItem?: (key: string) => string|null, setItem?: (key: string, value: string) => void }} StorageLike */
