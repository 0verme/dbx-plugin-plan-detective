/**
 * Display-only formatting helpers for the fixture-driven MVP UI.
 *
 * They never change or re-derive values: analysis values stay raw in the core
 * output, and these helpers only turn them into compact, readable strings.
 */

const numberFormatters = new Map();

/** @param {string} locale */
function numberFormatter(locale = "en-US") {
  const key = locale === "en" ? "en-US" : locale;
  let formatter = numberFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(key, { maximumFractionDigits: 2 });
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * Format a finite number with thousands separators and at most two decimals.
 *
 * @param {unknown} value
 * @param {string} [locale]
 * @returns {string|null} `null` when the value is not a finite number, so the
 *   caller can decide whether to omit the row or show a placeholder.
 */
export function formatNumber(value, locale = "en-US") {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return numberFormatter(locale).format(value);
}

/**
 * Format a fraction (0.3167) as a percentage string ("31.7%").
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Format a raw engine value for display without losing its meaning.
 * Empty strings, empty arrays and missing values become `null`.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function formatRawValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const parts = value.map((item) => formatRawValue(item)).filter((part) => part !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
