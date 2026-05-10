/**
 * @file StatementImportModal.tsx
 * @description Bank statement upload + parse modal. Spec §5.3 "Import Pipeline".
 *
 * Responsible for: collecting period_start / period_end + the statement file;
 *                  inserting the reconciliation_periods row (status=open) if
 *                  one doesn't exist; reading the CSV headers + applying or
 *                  collecting a column-mapping; parsing the file into the
 *                  canonical row shape; inserting the bank_statement_imports
 *                  row with raw_data + status='processing' and linking it
 *                  back to the open period; caching the column-map on
 *                  bank_accounts.csv_column_map for re-use on next import.
 * NOT responsible for: matching engine + review (1h.2), completion (1h.3),
 *                      OFX / QIF parsers (FORWARD: 1h.4 — surfaces a clear
 *                      "format not yet supported" message instead of crashing).
 *
 * UX rules:
 *   1. If an open reconciliation_periods row already exists for the account
 *      (the partial unique index in 00025 enforces at most one), the period
 *      inputs are hidden and the modal goes straight to the file picker.
 *   2. If the open period already has an import (statement uploaded but not
 *      yet reviewed), surface that state with the review-pending message
 *      pointing at 1h.2 — the modal does not allow re-uploading from this
 *      stage.
 *   3. Pre-flight validation before any DB write: file content parses
 *      cleanly with the chosen mapping. Failed rows are surfaced as a count
 *      ("3 rows skipped") so the PM knows the file wasn't fully clean.
 *   4. The column-map is saved back to bank_accounts.csv_column_map AFTER
 *      successful import, so a failed import doesn't pollute the cache.
 *
 * FORWARD: PROD-GATE — the column-mapping flow is per-firm self-mapped at
 * PoC. Production ships curated bank-template presets so PMs aren't shown
 * a blank mapping screen on first import. Anchor: parseStatement.ts header.
 */
import { useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import {
  Card, CardContent, Button, Input,
} from '@/components/ui'
import { X, AlertTriangle, Upload, ArrowRight, Lock } from 'lucide-react'
import { todayISODate } from '@/lib/utils'
import {
  detectFormat, readCsvHeaders, parseStatement,
  StatementParseError, type CsvColumnMap, type ParsedStatementRow,
} from '@/lib/reconciliation/parseStatement'
import type { Database } from '@/types/database'

type BankAccount          = Database['public']['Tables']['bank_accounts']['Row']
type ReconciliationPeriod = Database['public']['Tables']['reconciliation_periods']['Row']
type BankStatementImport  = Database['public']['Tables']['bank_statement_imports']['Row']

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ' +
  'disabled:cursor-not-allowed disabled:opacity-60'

const REVIEW_PENDING_MESSAGE =
  'Statement uploaded successfully. The matching engine and review screen ' +
  'land in commit 1h.2 — until then this period stays in "statement uploaded" ' +
  'state. (FORWARD: PROD-GATE — review screen.)'

interface Props {
  firmId:              string
  account:             BankAccount
  openPeriod:          ReconciliationPeriod | null
  openPeriodImport:    BankStatementImport | null
  defaultPeriodStart:  string  // YYYY-MM-DD
  onClose:             () => void
  onSaved:             () => void
}

export function StatementImportModal(props: Props) {
  const { firmId, account, openPeriod, openPeriodImport,
          defaultPeriodStart, onClose, onSaved } = props
  const userId = useAuthStore(s => s.user?.id ?? null)

  // ── Already-uploaded path ────────────────────────────────────────────────
  if (openPeriod && openPeriodImport) {
    return (
      <ModalShell onClose={onClose} title={`Reconciliation — ${account.account_name}`}>
        <div className="flex items-start gap-2 text-sm border rounded-md px-3 py-2 bg-muted/40 mb-4">
          <Lock className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">{REVIEW_PENDING_MESSAGE}</span>
        </div>
        <div className="text-sm space-y-1">
          <div><strong>File:</strong> {openPeriodImport.filename ?? 'unnamed'}</div>
          <div><strong>Rows parsed:</strong> {openPeriodImport.row_count ?? 0}</div>
          <div><strong>Status:</strong> {openPeriodImport.status}</div>
        </div>
        <div className="flex justify-end pt-4">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </ModalShell>
    )
  }

  return (
    <ImportFlow
      firmId={firmId}
      account={account}
      openPeriod={openPeriod}
      defaultPeriodStart={defaultPeriodStart}
      userId={userId}
      onClose={onClose}
      onSaved={onSaved}
    />
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Import flow — period setup (optional) → file pick → mapping → save
// ════════════════════════════════════════════════════════════════════════════
function ImportFlow({
  firmId, account, openPeriod, defaultPeriodStart, userId, onClose, onSaved,
}: {
  firmId:             string
  account:            BankAccount
  openPeriod:         ReconciliationPeriod | null
  defaultPeriodStart: string
  userId:             string | null
  onClose:            () => void
  onSaved:            () => void
}) {
  const cachedMap = (account.csv_column_map ?? null) as CsvColumnMap | null

  const [periodStart, setPeriodStart] = useState(openPeriod?.period_start ?? defaultPeriodStart)
  const [periodEnd,   setPeriodEnd]   = useState(openPeriod?.period_end   ?? todayISODate())

  const [filename,    setFilename]    = useState<string | null>(null)
  const [content,     setContent]     = useState<string | null>(null)
  const [headers,     setHeaders]     = useState<string[]>([])
  const [parseError,  setParseError]  = useState<string | null>(null)

  const [columnMap, setColumnMap] = useState<CsvColumnMap>(() => cachedMap ?? defaultMap())

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  /** Two-column (debit + credit) toggle. Driven by whether columnMap.amount
   *  is empty when there's a debit/credit pair. */
  const [twoCol, setTwoCol] = useState<boolean>(
    !!cachedMap && (!cachedMap.amount && !!cachedMap.debit && !!cachedMap.credit)
  )

  async function handleFile(file: File) {
    setParseError(null)
    setSaveError(null)
    setFilename(file.name)
    const text = await file.text()
    setContent(text)

    const fmt = detectFormat(file.name, text)
    if (fmt !== 'csv') {
      setParseError(
        fmt === 'ofx'
          ? 'OFX format is not yet supported in this PoC. CSV only for now. ' +
            '(FORWARD: 1h.4 — OFX/QIF parsers.)'
          : 'QIF format is not yet supported in this PoC. CSV only for now. ' +
            '(FORWARD: 1h.4 — OFX/QIF parsers.)'
      )
      setHeaders([])
      return
    }

    try {
      const hs = readCsvHeaders(text)
      setHeaders(hs)
      // If the cached map references headers that aren't present, reset.
      if (cachedMap) {
        const seen = new Set(hs)
        const required = [
          cachedMap.date, cachedMap.description,
          ...(cachedMap.amount ? [cachedMap.amount] : []),
          ...(cachedMap.debit  ? [cachedMap.debit]  : []),
          ...(cachedMap.credit ? [cachedMap.credit] : []),
        ]
        if (required.some(h => !seen.has(h))) {
          setColumnMap(defaultMap())
          setTwoCol(false)
        }
      }
    } catch (err) {
      setParseError(err instanceof StatementParseError ? err.message : String(err))
      setHeaders([])
    }
  }

  /** Pre-flight: try parsing with the current map and surface row counts. */
  const previewParse = useMemo(() => {
    if (!content || !headers.length) return null
    if (!isMapComplete(columnMap, twoCol)) return null
    try {
      const result = parseStatement('csv', content, columnMap)
      return { ok: true as const, rows: result.rows, skipped: result.skippedRows }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  }, [content, headers, columnMap, twoCol])

  async function handleSubmit() {
    setSaveError(null)
    if (!content || !filename) { setSaveError('Pick a file first.'); return }
    if (!isMapComplete(columnMap, twoCol)) {
      setSaveError('Complete the column mapping below.')
      return
    }
    if (!previewParse?.ok) {
      setSaveError(previewParse?.ok === false ? previewParse.message : 'Parse failed.')
      return
    }
    if (!userId) { setSaveError('User session missing.'); return }
    if (!periodStart || !periodEnd) { setSaveError('Period dates required.'); return }
    if (periodEnd < periodStart) { setSaveError('Period end must be on or after period start.'); return }

    setSaving(true)

    // 1. Period — create if missing.
    let period: ReconciliationPeriod
    if (openPeriod) {
      period = openPeriod
    } else {
      const { data, error } = await supabase
        .from('reconciliation_periods')
        .insert({
          firm_id:         firmId,
          bank_account_id: account.id,
          period_start:    periodStart,
          period_end:      periodEnd,
          status:          'open',
        })
        .select('*')
        .single()
      if (error || !data) {
        const message = error?.code === '23505'
          ? 'This account already has an in-progress reconciliation period. Open it from the list.'
          : (error?.message ?? 'Failed to create reconciliation period.')
        setSaveError(message); setSaving(false); return
      }
      period = data
    }

    // 2. bank_statement_imports — insert with parsed raw_data + status processing.
    const rows: ParsedStatementRow[] = previewParse.rows
    const { data: importRow, error: importErr } = await supabase
      .from('bank_statement_imports')
      .insert({
        firm_id:         firmId,
        bank_account_id: account.id,
        filename,
        row_count:       rows.length,
        matched_count:   0,
        unmatched_count: rows.length,
        raw_data:        rows as unknown as Database['public']['Tables']['bank_statement_imports']['Insert']['raw_data'],
        status:          'processing',
        imported_by:     userId,
      })
      .select('id')
      .single()
    if (importErr || !importRow) {
      setSaveError(importErr?.message ?? 'Failed to write statement import.'); setSaving(false); return
    }

    // 3. Link import to period.
    const { error: linkErr } = await supabase
      .from('reconciliation_periods')
      .update({ bank_statement_import_id: importRow.id })
      .eq('id', period.id)
    if (linkErr) {
      setSaveError(linkErr.message); setSaving(false); return
    }

    // 4. Cache column-map back to bank_accounts for re-use.
    const { error: mapErr } = await supabase
      .from('bank_accounts')
      .update({ csv_column_map: columnMap as unknown as Database['public']['Tables']['bank_accounts']['Update']['csv_column_map'] })
      .eq('id', account.id)
    if (mapErr) {
      // Non-fatal: import is saved; just log.
      // eslint-disable-next-line no-console
      console.warn('Failed to cache csv_column_map:', mapErr.message)
    }

    setSaving(false)
    onSaved()
  }

  return (
    <ModalShell onClose={onClose} title={`Reconciliation — ${account.account_name}`}>
      {/* Period selection */}
      {openPeriod ? (
        <div className="text-sm text-muted-foreground mb-4">
          Continuing open period: <strong>{openPeriod.period_start}</strong> →{' '}
          <strong>{openPeriod.period_end}</strong>.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className="space-y-1">
            <label htmlFor="period-start" className="text-sm font-medium">Period start *</label>
            <Input id="period-start" type="date" value={periodStart}
              onChange={e => setPeriodStart(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <label htmlFor="period-end" className="text-sm font-medium">Period end *</label>
            <Input id="period-end" type="date" value={periodEnd}
              onChange={e => setPeriodEnd(e.target.value)} required />
          </div>
        </div>
      )}

      {/* File picker */}
      <div className="mb-4">
        <label className="text-sm font-medium block mb-1">Statement file (CSV) *</label>
        <input
          type="file"
          accept=".csv,.txt,text/csv"
          aria-label="Statement file"
          data-testid="statement-file-input"
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
          }}
          className="block w-full text-sm"
        />
        {filename && (
          <p className="text-xs text-muted-foreground mt-1">
            Selected: <strong>{filename}</strong>
          </p>
        )}
      </div>

      {parseError && (
        <div className="mb-4 flex items-start gap-2 text-sm text-amber-900 border border-amber-300 bg-amber-50 rounded-md px-3 py-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span data-testid="parse-error">{parseError}</span>
        </div>
      )}

      {/* Column mapping */}
      {headers.length > 0 && (
        <ColumnMappingForm
          headers={headers}
          map={columnMap}
          twoCol={twoCol}
          onChangeMap={setColumnMap}
          onChangeTwoCol={setTwoCol}
        />
      )}

      {previewParse && (
        previewParse.ok ? (
          <div className="mt-3 text-sm text-green-700">
            Preview: <strong>{previewParse.rows.length}</strong> rows ready to import
            {previewParse.skipped > 0 && ` (${previewParse.skipped} rows skipped — malformed)`}.
          </div>
        ) : (
          <div className="mt-3 text-sm text-destructive">{previewParse.message}</div>
        )
      )}

      {saveError && (
        <div className="mt-3 flex items-start gap-2 text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span data-testid="save-error">{saveError}</span>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          onClick={handleSubmit}
          disabled={saving || !previewParse?.ok}
          data-testid="statement-import-submit"
        >
          {saving ? 'Saving…' : (
            <>Import statement <ArrowRight className="h-4 w-4 ml-1" /></>
          )}
        </Button>
      </div>
    </ModalShell>
  )
}

// ── Column mapping form ─────────────────────────────────────────────────────
function ColumnMappingForm({
  headers, map, twoCol, onChangeMap, onChangeTwoCol,
}: {
  headers: string[]
  map: CsvColumnMap
  twoCol: boolean
  onChangeMap: (m: CsvColumnMap) => void
  onChangeTwoCol: (b: boolean) => void
}) {
  function set<K extends keyof CsvColumnMap>(key: K, value: CsvColumnMap[K]) {
    onChangeMap({ ...map, [key]: value })
  }
  function toggleTwoCol(next: boolean) {
    onChangeTwoCol(next)
    if (next) onChangeMap({ ...map, amount: undefined })
    else      onChangeMap({ ...map, debit: undefined, credit: undefined })
  }

  return (
    <Card className="bg-muted/20">
      <CardContent className="p-4 space-y-3">
        <div className="text-sm font-medium">Column mapping</div>
        <div className="text-xs text-muted-foreground">
          Tell PropOS which columns in the file correspond to each canonical field.
          The mapping is saved on the bank account for re-use on next import.
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date column *">
            <Select value={map.date} headers={headers}
              onChange={v => set('date', v)} testid="map-date" />
          </Field>
          <Field label="Description column *">
            <Select value={map.description} headers={headers}
              onChange={v => set('description', v)} testid="map-description" />
          </Field>

          <Field label="Date format *">
            <select
              className={SELECT_CLASS}
              value={map.dateFormat}
              onChange={e => set('dateFormat', e.target.value as CsvColumnMap['dateFormat'])}
              data-testid="map-date-format"
            >
              <option value="DD/MM/YYYY">DD/MM/YYYY (UK)</option>
              <option value="YYYY-MM-DD">YYYY-MM-DD (ISO)</option>
              <option value="MM/DD/YYYY">MM/DD/YYYY (US)</option>
            </select>
          </Field>
          <Field label="Amount mode *">
            <select
              className={SELECT_CLASS}
              value={twoCol ? 'two' : 'one'}
              onChange={e => toggleTwoCol(e.target.value === 'two')}
              data-testid="map-amount-mode"
            >
              <option value="one">Single Amount column (sign-bearing)</option>
              <option value="two">Separate Debit / Credit columns</option>
            </select>
          </Field>

          {!twoCol ? (
            <Field label="Amount column *">
              <Select value={map.amount ?? ''} headers={headers}
                onChange={v => set('amount', v)} testid="map-amount" />
            </Field>
          ) : (
            <>
              <Field label="Debit column *">
                <Select value={map.debit ?? ''} headers={headers}
                  onChange={v => set('debit', v)} testid="map-debit" />
              </Field>
              <Field label="Credit column *">
                <Select value={map.credit ?? ''} headers={headers}
                  onChange={v => set('credit', v)} testid="map-credit" />
              </Field>
            </>
          )}

          <Field label="Reference column (optional)">
            <Select value={map.reference ?? ''} headers={headers} allowEmpty
              onChange={v => set('reference', v || undefined)} testid="map-reference" />
          </Field>
          <Field label="Payee column (optional)">
            <Select value={map.payee ?? ''} headers={headers} allowEmpty
              onChange={v => set('payee', v || undefined)} testid="map-payee" />
          </Field>
        </div>
      </CardContent>
    </Card>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function Select({
  value, headers, onChange, testid, allowEmpty,
}: {
  value: string
  headers: string[]
  onChange: (v: string) => void
  testid: string
  allowEmpty?: boolean
}) {
  return (
    <select
      className={SELECT_CLASS}
      value={value}
      onChange={e => onChange(e.target.value)}
      data-testid={testid}
    >
      <option value="">{allowEmpty ? '(none)' : 'Choose column…'}</option>
      {headers.map(h => <option key={h} value={h}>{h}</option>)}
    </select>
  )
}

// ── Modal shell ─────────────────────────────────────────────────────────────
function ModalShell({
  title, onClose, children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <Card className="w-full max-w-3xl my-8">
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold flex items-center gap-2">
              <Upload className="h-4 w-4" /> {title}
            </h3>
            <Button variant="ghost" size="sm" onClick={onClose}><X className="h-4 w-4" /></Button>
          </div>
          {children}
        </CardContent>
      </Card>
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function defaultMap(): CsvColumnMap {
  return {
    date: '', description: '',
    dateFormat: 'DD/MM/YYYY',
  }
}

function isMapComplete(map: CsvColumnMap, twoCol: boolean): boolean {
  if (!map.date || !map.description) return false
  if (twoCol) return !!map.debit && !!map.credit
  return !!map.amount
}
