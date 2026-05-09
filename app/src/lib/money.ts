/**
 * @file money.ts
 * @description Financial amount utilities for PropOS.
 * Responsible for: converting between pence (internal integer representation) and
 *   pounds (database NUMERIC and display string), and formatting currency for UI.
 * NOT responsible for: financial calculations beyond unit conversion and formatting.
 *
 * Per Section 6.4: all financial amounts are integers (pence) in memory.
 * Database stores NUMERIC(14,2) — conversion happens at the boundary.
 *
 * IMPORTANT: Never perform arithmetic on the raw database NUMERIC values.
 * Always convert to pence first, calculate, then convert back.
 */

/** Convert a database NUMERIC value (pounds) to integer pence. */
export function poundsToP(pounds: number | null | undefined): number {
  if (pounds == null) return 0
  return Math.round(pounds * 100)
}

/** Convert integer pence to a database NUMERIC value (pounds). */
export function pToPounds(pence: number): number {
  return pence / 100
}

/**
 * Format pence as a UK currency string.
 * @example formatMoney(12345) → "£123.45"
 */
export function formatMoney(pence: number): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
  }).format(pence / 100)
}

/**
 * Format a database pounds value as a UK currency string.
 * Use only at the display layer.
 */
export function formatPounds(pounds: number | null | undefined): string {
  return formatMoney(poundsToP(pounds))
}

/** Add two pence amounts safely. */
export function addP(a: number, b: number): number {
  return a + b
}

/** Subtract pence amounts safely. */
export function subtractP(a: number, b: number): number {
  return a - b
}

/**
 * Parse a free-form user-entered money string into integer pence.
 * Returns null for empty / invalid input. Accepts:
 *   "1234"      → 123400
 *   "1234.56"   → 123456
 *   "1,234.56"  → 123456
 *   "  £12.5 "  → 1250
 *   "-50"       → -5000   (only when allowNegative)
 * Rejects more than two decimal places, alpha characters, multiple decimals.
 */
export function parseMoneyInput(
  raw: string,
  opts: { allowNegative?: boolean } = {}
): number | null {
  if (raw == null) return null
  const cleaned = raw.replace(/[£\s,]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
  const sign = opts.allowNegative ? '-?' : ''
  const re = new RegExp(`^${sign}\\d+(\\.\\d{1,2})?$`)
  if (!re.test(cleaned)) return null
  const pounds = parseFloat(cleaned)
  if (!Number.isFinite(pounds)) return null
  return Math.round(pounds * 100)
}

/**
 * Format integer pence for display inside a text input — no currency symbol,
 * always 2dp, locale-grouped. Negative values render with a leading minus.
 *   123456  → "1,234.56"
 *   -5000   → "-50.00"
 *   null    → ""
 */
export function formatPenceForInput(pence: number | null | undefined): string {
  if (pence == null) return ''
  return (pence / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
