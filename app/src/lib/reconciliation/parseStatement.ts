/**
 * @file parseStatement.ts
 * @description Bank statement parser dispatch + CSV implementation.
 *
 * Spec §5.3 (Bank Reconciliation Engine) — "PM uploads a CSV, OFX, or QIF
 * bank statement file via the bank statement import screen. File parser
 * detects format, extracts transactions, and writes them as rows in
 * bank_statement_imports.raw_data with import status 'pending'."
 *
 * Responsible for: detecting file format from filename + content sniffing,
 *                  parsing CSV statement rows into a canonical shape, applying
 *                  a per-bank column-mapping JSONB to extract the canonical
 *                  fields {date, description, amount, reference, payee}.
 * NOT responsible for: matching the parsed rows against transactions (that
 *                      lives in matchingEngine.ts, 1h.2), writing to
 *                      bank_statement_imports (the modal does that), the
 *                      column-mapping UI (StatementImportModal owns it).
 *
 * FORWARD: PROD-GATE — CSV-only at PoC. OFX (SGML/XML) and QIF parsers are
 * stubs that throw a "format not yet supported" error. Production replacement
 * is the format registry below populated for OFX and QIF, plus Open Banking
 * AIS sync (DECISIONS 2026-05-09 — Open Banking).
 *
 * FORWARD: PROD-GATE — column-mapping is per-firm self-mapped. Production
 * must ship curated bank-template presets (Lloyds / Barclays / NatWest /
 * HSBC / Monzo / Starling) so PMs aren't confronted with a blank mapping
 * screen on first import. The JSONB stays as override for outliers.
 */

/**
 * Canonical column-mapping shape stored on bank_accounts.csv_column_map.
 * Keys are canonical field names; values are the CSV header strings to read
 * from. `amount` is the single-signed-column path (e.g. Lloyds, Monzo);
 * `debit` + `credit` is the two-column path (e.g. NatWest, Barclays exports).
 * Exactly one of (amount) OR (debit AND credit) must be present.
 *
 * `dateFormat` is the format string used to parse the date column. Supported:
 *   - 'DD/MM/YYYY' (UK default)
 *   - 'YYYY-MM-DD' (ISO)
 *   - 'MM/DD/YYYY' (US-style; rare for UK banks but Quicken exports use it)
 */
export interface CsvColumnMap {
  date:        string
  description: string
  amount?:     string
  debit?:      string
  credit?:     string
  reference?:  string
  payee?:      string
  dateFormat:  'DD/MM/YYYY' | 'YYYY-MM-DD' | 'MM/DD/YYYY'
}

/** A canonical parsed statement row. Stored as one element of the
 *  `bank_statement_imports.raw_data` JSONB array. */
export interface ParsedStatementRow {
  /** Index in the source file, after header skip. Used as the audit-log
   *  anchor in `suspense_items.statement_row_index`. */
  index:        number
  /** ISO date `YYYY-MM-DD`. */
  date:         string
  description:  string
  /** Pence (integer) — positive = credit (money in), negative = debit
   *  (money out). Matches the `transactions.amount` sign convention. */
  amountP:      number
  reference:    string | null
  payee:        string | null
  /** Verbatim copy of the source row (raw fields) — kept for audit. */
  raw:          Record<string, string>
}

export interface ParseResult {
  rows:        ParsedStatementRow[]
  /** Header row from the source file. Used by the column-mapping UI to
   *  let the PM map their bank's columns. */
  headers:     string[]
  /** Number of rows that failed to parse (skipped). Surfaced to the PM
   *  so a malformed file is obvious. */
  skippedRows: number
}

export type SupportedFormat = 'csv' | 'ofx' | 'qif'

export class StatementParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'StatementParseError'
  }
}

/**
 * Detect a statement file's format from its name + a content sniff.
 * Falls back to extension if content sniffing is inconclusive.
 */
export function detectFormat(filename: string, content: string): SupportedFormat {
  const trimmed = content.trimStart()
  // OFX 1.x is SGML; OFX 2.x is XML; both start with <?xml or <OFX or OFXHEADER.
  if (/^(OFXHEADER|<\?xml|<OFX)/i.test(trimmed)) return 'ofx'
  // QIF starts with !Type:<class>
  if (/^!Type:/i.test(trimmed)) return 'qif'
  // Otherwise treat as CSV. Filename hint is secondary.
  const ext = filename.toLowerCase().split('.').pop()
  if (ext === 'ofx') return 'ofx'
  if (ext === 'qif') return 'qif'
  return 'csv'
}

/**
 * Parse a statement file. Dispatches by format. Throws StatementParseError
 * on OFX / QIF (PoC limitation, surfaced to the PM in the import modal).
 */
export function parseStatement(
  format: SupportedFormat,
  content: string,
  columnMap: CsvColumnMap | null,
): ParseResult {
  switch (format) {
    case 'csv':
      if (!columnMap) {
        throw new StatementParseError(
          'CSV column mapping required. Map your bank\'s columns first.'
        )
      }
      return parseCsv(content, columnMap)
    case 'ofx':
      // FORWARD: PROD-GATE — implement OFX parser before any firm exits demo
      // mode. Approach: SGML-to-XML normaliser + DOM walk extracting <STMTTRN>
      // elements. Library candidate: node-ofx-parser. Anchor: plan 1h §3.
      throw new StatementParseError(
        'OFX format is not yet supported in this PoC. CSV only for now. ' +
        '(FORWARD: 1h.4 — OFX/QIF parsers.)'
      )
    case 'qif':
      // FORWARD: PROD-GATE — implement QIF parser before any firm exits demo
      // mode. Line-based with `^` row terminators; date format is bank-export
      // dependent (US/UK ambiguity). Anchor: plan 1h §3.
      throw new StatementParseError(
        'QIF format is not yet supported in this PoC. CSV only for now. ' +
        '(FORWARD: 1h.4 — OFX/QIF parsers.)'
      )
    default: {
      const exhaustive: never = format
      throw new StatementParseError(`Unknown format: ${exhaustive as string}`)
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CSV implementation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse the headers row of a CSV without consuming data rows. Used by the
 * import modal to populate the column-mapping selects on first import.
 */
export function readCsvHeaders(content: string): string[] {
  const lines = splitCsvLines(content)
  const headerLine = findHeaderLine(lines)
  if (headerLine == null) {
    throw new StatementParseError(
      'CSV file does not contain a recognisable header row (expected at ' +
      'least one of: Date, Description, Amount, Reference).'
    )
  }
  return parseCsvLine(headerLine)
}

function parseCsv(content: string, map: CsvColumnMap): ParseResult {
  const lines = splitCsvLines(content)
  const headerLine = findHeaderLine(lines)
  if (headerLine == null) {
    throw new StatementParseError(
      'CSV file does not contain a recognisable header row.'
    )
  }
  const headers = parseCsvLine(headerLine)
  validateColumnMap(map, headers)

  const headerIndex = lines.indexOf(headerLine)
  const dataLines = lines.slice(headerIndex + 1)

  const rows: ParsedStatementRow[] = []
  let skipped = 0

  for (let i = 0; i < dataLines.length; i++) {
    const cells = parseCsvLine(dataLines[i])
    if (cells.length === 0 || cells.every(c => c.trim() === '')) continue

    const raw: Record<string, string> = {}
    for (let h = 0; h < headers.length; h++) {
      raw[headers[h]] = (cells[h] ?? '').trim()
    }

    try {
      const row = projectRow(raw, map, rows.length)
      rows.push(row)
    } catch {
      skipped++
    }
  }

  return { rows, headers, skippedRows: skipped }
}

function projectRow(
  raw: Record<string, string>,
  map: CsvColumnMap,
  index: number,
): ParsedStatementRow {
  const dateRaw = raw[map.date]
  const description = raw[map.description] ?? ''
  if (!dateRaw || !description) {
    throw new StatementParseError('Row missing required fields')
  }

  const date = parseDate(dateRaw, map.dateFormat)

  let amountP: number
  if (map.amount) {
    amountP = parseAmountToPence(raw[map.amount] ?? '')
  } else if (map.debit && map.credit) {
    const debit  = parseAmountToPence(raw[map.debit]  ?? '')
    const credit = parseAmountToPence(raw[map.credit] ?? '')
    // Two-column convention: debit means money out (negative), credit means in (positive).
    amountP = (credit !== 0 ? credit : -Math.abs(debit))
  } else {
    throw new StatementParseError('Column map missing amount path')
  }

  const reference = map.reference ? (raw[map.reference] || null) : null
  const payee     = map.payee     ? (raw[map.payee]     || null) : null

  return { index, date, description, amountP, reference, payee, raw }
}

// ── CSV primitives ──────────────────────────────────────────────────────────

/**
 * Split content into lines, dropping CR. Empty lines preserved at this stage
 * because Lloyds-style preambles include them.
 */
function splitCsvLines(content: string): string[] {
  return content.replace(/\r/g, '').split('\n')
}

/**
 * Find the first line that looks like a header — has at least 3 comma-separated
 * cells and contains at least one of the canonical field anchors. This skips
 * Lloyds-style preambles ("Account,Sort Code,…" then the actual header).
 */
function findHeaderLine(lines: string[]): string | null {
  const ANCHORS = /\b(date|description|amount|reference|payee|debit|credit|memo)\b/i
  for (const line of lines) {
    const cells = parseCsvLine(line)
    if (cells.length >= 3 && ANCHORS.test(line)) return line
  }
  return null
}

/**
 * Parse a single CSV line, respecting double-quoted fields and escaped quotes
 * ("" inside a quoted field). Does not handle multi-line quoted fields (rare
 * in bank exports; surface as parse error if encountered).
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuote = false }
      } else {
        cur += ch
      }
    } else {
      if (ch === ',')      { cells.push(cur); cur = '' }
      else if (ch === '"') { inQuote = true }
      else                 { cur += ch }
    }
  }
  cells.push(cur)
  return cells
}

function validateColumnMap(map: CsvColumnMap, headers: string[]): void {
  const seen = new Set(headers)
  const required = [map.date, map.description]
  if (map.amount) required.push(map.amount)
  else if (map.debit && map.credit) required.push(map.debit, map.credit)
  else throw new StatementParseError(
    'Column map must specify either `amount` or both `debit` and `credit`.'
  )
  if (map.reference) required.push(map.reference)
  if (map.payee) required.push(map.payee)
  const missing = required.filter(c => !seen.has(c))
  if (missing.length) {
    throw new StatementParseError(
      `Column map references headers not present in the file: ${missing.join(', ')}`
    )
  }
}

// ── Date / amount primitives ────────────────────────────────────────────────

export function parseDate(raw: string, format: CsvColumnMap['dateFormat']): string {
  const cleaned = raw.trim()
  if (!cleaned) throw new StatementParseError('Empty date')
  if (format === 'YYYY-MM-DD') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned)
    if (!m) throw new StatementParseError(`Date "${cleaned}" not in YYYY-MM-DD format`)
    return cleaned
  }
  const parts = cleaned.split(/[\/\-.]/)
  if (parts.length !== 3) throw new StatementParseError(`Date "${cleaned}" malformed`)
  let dd: string, mm: string, yyyy: string
  if (format === 'DD/MM/YYYY') {
    [dd, mm, yyyy] = parts
  } else {
    // MM/DD/YYYY
    [mm, dd, yyyy] = parts
  }
  if (yyyy.length === 2) yyyy = (Number(yyyy) >= 70 ? '19' : '20') + yyyy
  const ddN = Number(dd), mmN = Number(mm), yN = Number(yyyy)
  if (!isFinite(ddN) || !isFinite(mmN) || !isFinite(yN)) {
    throw new StatementParseError(`Date "${cleaned}" not numeric`)
  }
  if (mmN < 1 || mmN > 12 || ddN < 1 || ddN > 31) {
    throw new StatementParseError(`Date "${cleaned}" out of range`)
  }
  return `${yyyy.padStart(4, '0')}-${String(mmN).padStart(2, '0')}-${String(ddN).padStart(2, '0')}`
}

/**
 * Parse a money amount into integer pence. Handles:
 *   - £ prefix
 *   - thousand separators (commas)
 *   - parens for negative ("(123.45)")
 *   - leading minus
 *   - empty string → 0
 */
export function parseAmountToPence(raw: string): number {
  const cleaned = (raw ?? '').trim()
  if (!cleaned) return 0
  let s = cleaned.replace(/[£\s,]/g, '')
  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1) }
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1) }
  if (s.startsWith('+')) { s = s.slice(1) }
  if (!s) return 0
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new StatementParseError(`Amount "${raw}" not in expected format`)
  }
  const [whole, frac = ''] = s.split('.')
  const fracPadded = (frac + '00').slice(0, 2)
  const pence = Number(whole) * 100 + Number(fracPadded)
  return negative ? -pence : pence
}
