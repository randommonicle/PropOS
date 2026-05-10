/**
 * @file ReconciliationReviewModal.tsx
 * @description Three-pass matching review screen. Spec §5.3 "Matching
 * Algorithm" + "PM actions on unmatched rows".
 *
 * Responsible for: running the matching algorithm against an open period's
 *                  imported statement rows; auto-applying pass-1 matches
 *                  (with audit-log writes); rendering pass-2 (Suggested) and
 *                  pass-3 (Review carefully) candidate matches with one-click
 *                  Confirm; rendering the unmatched-rows list with the four
 *                  PM actions (Create new transaction / Match manually /
 *                  Mark as suspense / Reject); writing the corresponding
 *                  audit-log row per action.
 * NOT responsible for: completion pre-flight + £0.01 balance gate (1h.3 —
 *                      ReconciliationCompleteModal); the statement upload
 *                      itself (1h.1 — StatementImportModal); suspense-item
 *                      resolution UI (forward — DECISIONS entry).
 *
 * Rules (spec §5.3):
 *   - Pass 1: amount-to-the-penny + ±2 days + (ref contains txn ref OR
 *             payee matches). Confidence 1.00. Auto-matched.
 *   - Pass 2: amount-to-the-penny + ±7 days. Confidence 0.80. PM confirm.
 *   - Pass 3: amount-to-the-penny + ±30 days, OR amount within £0.50 +
 *             ±7 days. Confidence 0.50. PM "review carefully".
 *   - Each action writes a reconciliation_audit_log row citing RICS Rule 3.7
 *     (spec §5.3 RICS RULE; statutory citation doubles as test anchor).
 *
 * FORWARD: PROD-GATE — matching is client-side; production runs in
 * Edge Function `reconciliation_engine.ts`. Anchor: matchingEngine.ts header.
 *
 * FORWARD: PROD-GATE — actor_id on audit-log rows is stamped from client at
 * PoC. Production stamps from server auth context. Anchor: auditLog.ts.
 */
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import {
  Card, CardContent, Button, Input, Badge,
} from '@/components/ui'
import { MoneyInput } from '@/components/shared/MoneyInput'
import {
  X, AlertTriangle, CheckCircle2, Plus, Link as LinkIcon, Pause, Ban,
} from 'lucide-react'
import { formatDate, todayISODate } from '@/lib/utils'
import { pToPounds, formatPounds } from '@/lib/money'
import { runMatching, type MatchResult } from '@/lib/reconciliation/matchingEngine'
import { recordAction } from '@/lib/reconciliation/auditLog'
import type { ParsedStatementRow } from '@/lib/reconciliation/parseStatement'
import type { Database } from '@/types/database'

type BankAccount             = Database['public']['Tables']['bank_accounts']['Row']
type ReconciliationPeriod    = Database['public']['Tables']['reconciliation_periods']['Row']
type BankStatementImport     = Database['public']['Tables']['bank_statement_imports']['Row']
type Transaction             = Database['public']['Tables']['transactions']['Row']

const RICS_3_7_NOTE = 'RICS Rule 3.7 evidence trail'

/** Per-row state inside raw_data after matching has run + PM actions
 *  recorded. Extends ParsedStatementRow. */
interface ProcessedStatementRow extends ParsedStatementRow {
  matchStatus?:           'matched' | 'suspense' | 'rejected'
  matchedTransactionId?:  string
  matchPass?:             1 | 2 | 3
  matchConfidence?:       1.00 | 0.80 | 0.50
  suspenseItemId?:        string
  rejectionReason?:       string
}

interface Props {
  firmId:    string
  account:   BankAccount
  period:    ReconciliationPeriod
  importRow: BankStatementImport
  onClose:   () => void
}

export function ReconciliationReviewModal({
  firmId, account, period, importRow, onClose,
}: Props) {
  const userId = useAuthStore(s => s.user?.id ?? null)

  const [rows,         setRows]         = useState<ProcessedStatementRow[]>(
    () => (importRow.raw_data as unknown as ProcessedStatementRow[]) ?? []
  )
  const [unreconTxns,  setUnreconTxns]  = useState<Transaction[]>([])
  const [loading,      setLoading]      = useState(true)
  const [working,      setWorking]      = useState<string | null>(null)
  const [error,        setError]        = useState<string | null>(null)

  /** Sub-flow state for unmatched-row actions. */
  const [activeAction, setActiveAction] = useState<{
    rowIndex: number
    kind:     'create' | 'manual' | 'suspense' | 'reject'
  } | null>(null)

  /** Track whether pass-1 auto-matches have been applied this session. The
   *  modal idempotently re-runs matching on each open; auto-matches that
   *  were already written persist on the rows themselves. */
  const [autoMatchedDone, setAutoMatchedDone] = useState(false)

  // ── Initial load: fetch unreconciled txns on this account ────────────────
  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data, error } = await supabase
        .from('transactions').select('*')
        .eq('bank_account_id', account.id)
        .eq('reconciled', false)
        .order('transaction_date')
      if (cancelled) return
      if (error) { setError(error.message); setLoading(false); return }
      setUnreconTxns(data ?? [])
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [account.id])

  // ── Run matching once unreconciled txns are loaded ───────────────────────
  useEffect(() => {
    if (loading) return
    if (autoMatchedDone) return
    if (!userId) return
    void runAndApplyMatching()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, userId])

  /**
   * Runs the three-pass matching algorithm, applies pass-1 auto-matches to
   * the DB (transactions.reconciled flip + audit_log auto_match), updates
   * raw_data with the per-row match state, and updates the import status.
   * Pass 2/3 candidates are stored in modal state (`rows[i].matchPass = 2|3`)
   * for the PM to confirm one-click.
   */
  async function runAndApplyMatching() {
    setWorking('Running matching engine…')
    try {
      // Filter out rows that already have a final disposition. Re-running
      // matching is safe and idempotent.
      const candidateRows = rows.filter(r => !r.matchStatus)
      const out = runMatching(candidateRows, unreconTxns)

      // Mutate row state in-place (immutable copy).
      const next = rows.map(r => ({ ...r }))
      for (const m of out.matches) {
        const r = next.find(x => x.index === m.statementRowIndex)
        if (!r) continue
        r.matchPass = m.pass
        r.matchConfidence = m.confidence
        // Pass 1 auto-applies; pass 2/3 are candidates only.
        if (m.pass === 1) {
          r.matchStatus = 'matched'
          r.matchedTransactionId = m.transactionId
        }
      }

      // Apply pass-1 auto-matches to DB.
      const pass1 = out.matches.filter(m => m.pass === 1)
      for (const m of pass1) {
        await applyMatchToDb(m, 'auto_match')
      }

      // Persist updated raw_data + counts + status='matched'.
      const matchedCount = next.filter(r => r.matchStatus === 'matched').length
      const unmatchedCount = next.filter(r => !r.matchStatus).length
      const { error: upErr } = await supabase
        .from('bank_statement_imports')
        .update({
          raw_data:        next as unknown as Database['public']['Tables']['bank_statement_imports']['Update']['raw_data'],
          matched_count:   matchedCount,
          unmatched_count: unmatchedCount,
          status:          'matched',
        })
        .eq('id', importRow.id)
      if (upErr) throw new Error(upErr.message)

      setRows(next)
      setAutoMatchedDone(true)

      // Refetch unreconciled txns to remove the now-reconciled ones.
      await refreshUnreconciledTxns()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(null)
    }
  }

  async function refreshUnreconciledTxns() {
    const { data } = await supabase
      .from('transactions').select('*')
      .eq('bank_account_id', account.id)
      .eq('reconciled', false)
      .order('transaction_date')
    setUnreconTxns(data ?? [])
  }

  /** Flip transactions.reconciled=true + statement_import_id; write audit row.
   *  Used by both pass-1 auto-match and pass-2/3 manual confirm. */
  async function applyMatchToDb(m: MatchResult, action: 'auto_match' | 'manual_match') {
    if (!userId) throw new Error('User session missing')
    const { error: txnErr } = await supabase
      .from('transactions')
      .update({
        reconciled:          true,
        reconciled_at:       new Date().toISOString(),
        reconciled_by:       userId,
        statement_import_id: importRow.id,
      })
      .eq('id', m.transactionId)
    if (txnErr) throw new Error(txnErr.message)

    await recordAction({
      firmId,
      bankAccountId:           account.id,
      reconciliationPeriodId:  period.id,
      bankStatementImportId:   importRow.id,
      action,
      actorId:                 userId,
      beforeState:             { reconciled: false } as never,
      afterState:              {
        reconciled:          true,
        statement_row_index: m.statementRowIndex,
        match_pass:          m.pass,
        match_confidence:    m.confidence,
        transaction_id:      m.transactionId,
      } as never,
      notes: `${RICS_3_7_NOTE} — ${action === 'auto_match' ? 'auto-matched' : 'manual match'} (pass ${m.pass}, confidence ${m.confidence.toFixed(2)})`,
    })
  }

  // ── Confirm a pass-2 / pass-3 candidate ──────────────────────────────────
  async function handleConfirmPassMatch(rowIndex: number) {
    setError(null)
    if (!userId) { setError('User session missing'); return }
    const r = rows.find(x => x.index === rowIndex)
    if (!r || !r.matchPass || r.matchPass === 1 || !r.matchConfidence) return

    setWorking(`Confirming match for row ${rowIndex + 1}…`)
    try {
      // Re-resolve which candidate transaction this should match. Re-running
      // matching gives us a deterministic answer (in case the unrecon pool has
      // shifted while the modal was open).
      const out = runMatching([r], unreconTxns)
      const candidate = out.matches[0]
      if (!candidate) {
        throw new Error(
          'No candidate transaction available — something changed. Close and re-open to refresh.'
        )
      }
      await applyMatchToDb(candidate, 'manual_match')
      await applyRowMutation(rowIndex, {
        matchStatus:          'matched',
        matchedTransactionId: candidate.transactionId,
      })
      await refreshUnreconciledTxns()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(null)
    }
  }

  // ── Helpers to mutate raw_data + persist + counts ────────────────────────
  async function applyRowMutation(rowIndex: number, patch: Partial<ProcessedStatementRow>) {
    const next = rows.map(r => r.index === rowIndex ? { ...r, ...patch } : r)
    setRows(next)
    const matchedCount = next.filter(r => r.matchStatus === 'matched').length
    const unmatchedCount = next.filter(r => !r.matchStatus).length
    const { error } = await supabase
      .from('bank_statement_imports')
      .update({
        raw_data:        next as unknown as Database['public']['Tables']['bank_statement_imports']['Update']['raw_data'],
        matched_count:   matchedCount,
        unmatched_count: unmatchedCount,
      })
      .eq('id', importRow.id)
    if (error) throw new Error(error.message)
  }

  // ── Sections grouped by pass ─────────────────────────────────────────────
  const sections = useMemo(() => {
    const pass1 = rows.filter(r => r.matchStatus === 'matched' && r.matchPass === 1)
    const pass2 = rows.filter(r => !r.matchStatus && r.matchPass === 2)
    const pass3 = rows.filter(r => !r.matchStatus && r.matchPass === 3)
    const unmatched = rows.filter(r => !r.matchStatus && !r.matchPass)
    const suspense  = rows.filter(r => r.matchStatus === 'suspense')
    const rejected  = rows.filter(r => r.matchStatus === 'rejected')
    return { pass1, pass2, pass3, unmatched, suspense, rejected }
  }, [rows])

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4"
      role="dialog" aria-modal="true" aria-label="Reconciliation review"
    >
      <Card className="w-full max-w-5xl my-8">
        <CardContent className="p-6">
          <header className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold">Reconciliation review — {account.account_name}</h3>
              <p className="text-xs text-muted-foreground">
                Period {formatDate(period.period_start)} → {formatDate(period.period_end)}.
                File: {importRow.filename ?? 'unnamed'} · {importRow.row_count ?? 0} rows.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close review">
              <X className="h-4 w-4" />
            </Button>
          </header>

          {error && (
            <div className="mb-3 flex items-start gap-2 text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span className="flex-1" data-testid="review-error">{error}</span>
              <button onClick={() => setError(null)} aria-label="Dismiss error">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {working && (
            <div className="mb-3 text-sm text-muted-foreground">{working}</div>
          )}
          {loading && (
            <div className="text-sm text-muted-foreground">Loading reconciliation…</div>
          )}

          {!loading && (
            <div className="space-y-4">
              <PassSection
                title="Auto-matched (pass 1)"
                badgeVariant="green"
                badgeText="100%"
                description="Amount to the penny, date within ±2 days, and reference or payee matches. Auto-matched, no PM action required."
                rows={sections.pass1}
                renderActions={() => null}
              />

              <PassSection
                title="Suggested matches (pass 2)"
                badgeVariant="amber"
                badgeText="80%"
                description="Amount to the penny, date within ±7 days. One-click confirm to apply."
                rows={sections.pass2}
                renderActions={r => (
                  <Button
                    size="sm"
                    data-testid={`confirm-pass-${r.index}`}
                    onClick={() => handleConfirmPassMatch(r.index)}
                    disabled={!!working}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Confirm match
                  </Button>
                )}
              />

              <PassSection
                title="Review carefully (pass 3)"
                badgeVariant="secondary"
                badgeText="50%"
                description="Amount to the penny + date within ±30 days, OR amount within £0.50 + date within ±7 days (foreign card rounding tolerance)."
                rows={sections.pass3}
                renderActions={r => (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`confirm-pass-${r.index}`}
                    onClick={() => handleConfirmPassMatch(r.index)}
                    disabled={!!working}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Confirm match
                  </Button>
                )}
              />

              <UnmatchedSection
                rows={sections.unmatched}
                onAction={(rowIndex, kind) => setActiveAction({ rowIndex, kind })}
              />

              {sections.suspense.length > 0 && (
                <PassSection
                  title="Suspense items"
                  badgeVariant="amber"
                  badgeText="Held"
                  description="Statement rows held pending investigation. Resolve via the suspense items list (deferred — see DECISIONS forward entry)."
                  rows={sections.suspense}
                  renderActions={() => null}
                />
              )}
              {sections.rejected.length > 0 && (
                <PassSection
                  title="Rejected statement rows"
                  badgeVariant="destructive"
                  badgeText="Rejected"
                  description="Rows the PM has rejected (data error or duplicate). Audit log retains the reason."
                  rows={sections.rejected}
                  renderActions={() => null}
                />
              )}
            </div>
          )}

          {activeAction && (
            <ActionForm
              row={rows.find(r => r.index === activeAction.rowIndex)!}
              kind={activeAction.kind}
              account={account}
              firmId={firmId}
              periodId={period.id}
              importId={importRow.id}
              userId={userId}
              unreconTxns={unreconTxns}
              onClose={() => setActiveAction(null)}
              onApplied={async patch => {
                await applyRowMutation(activeAction.rowIndex, patch)
                setActiveAction(null)
                await refreshUnreconciledTxns()
              }}
            />
          )}

          <div className="flex justify-end pt-4">
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Pass section (read-only or with action button per row) ───────────────────
function PassSection({
  title, description, badgeVariant, badgeText, rows, renderActions,
}: {
  title:           string
  description:     string
  badgeVariant:    'green' | 'amber' | 'secondary' | 'destructive'
  badgeText:       string
  rows:            ProcessedStatementRow[]
  renderActions:   (r: ProcessedStatementRow) => React.ReactNode
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-1">
          <h4 className="font-medium flex items-center gap-2">
            {title} <Badge variant={badgeVariant}>{badgeText}</Badge>
          </h4>
          <span className="text-xs text-muted-foreground">{rows.length} {rows.length === 1 ? 'row' : 'rows'}</span>
        </div>
        <p className="text-xs text-muted-foreground mb-3">{description}</p>
        {rows.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">None.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="text-left py-1">Date</th>
                <th className="text-left py-1">Description</th>
                <th className="text-right py-1">Amount</th>
                <th className="text-left py-1 pl-2">Reference</th>
                <th className="text-right py-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.index} className="border-t" data-testid={`stmt-row-${r.index}`}>
                  <td className="py-2">{formatDate(r.date)}</td>
                  <td className="py-2">{r.description}</td>
                  <td className={`py-2 text-right font-mono tabular-nums ${r.amountP < 0 ? 'text-destructive' : 'text-green-700'}`}>
                    {r.amountP < 0 ? '-' : ''}{formatPounds(Math.abs(r.amountP) / 100)}
                  </td>
                  <td className="py-2 pl-2 text-xs text-muted-foreground">{r.reference ?? '—'}</td>
                  <td className="py-2 text-right">{renderActions(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  )
}

// ── Unmatched section with the four PM actions per row ──────────────────────
function UnmatchedSection({
  rows, onAction,
}: {
  rows:     ProcessedStatementRow[]
  onAction: (rowIndex: number, kind: 'create' | 'manual' | 'suspense' | 'reject') => void
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-1">
          <h4 className="font-medium">Unmatched rows</h4>
          <span className="text-xs text-muted-foreground">{rows.length} {rows.length === 1 ? 'row' : 'rows'}</span>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Statement rows the matching engine could not link to an unreconciled
          transaction. Spec §5.3: create a new transaction (typical for
          unrecorded receipts), match manually to an existing transaction,
          mark as suspense, or reject (data error / duplicate).
        </p>
        {rows.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">None.</div>
        ) : (
          <div className="space-y-2">
            {rows.map(r => (
              <div key={r.index}
                   className="border rounded-md p-3 flex items-start justify-between gap-3 flex-wrap"
                   data-testid={`unmatched-row-${r.index}`}>
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="text-sm font-medium">{r.description}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatDate(r.date)} · <span className={`font-mono ${r.amountP < 0 ? 'text-destructive' : 'text-green-700'}`}>
                      {r.amountP < 0 ? '-' : ''}{formatPounds(Math.abs(r.amountP) / 100)}
                    </span>
                    {r.reference && <> · ref {r.reference}</>}
                    {r.payee && <> · payee {r.payee}</>}
                  </div>
                </div>
                <div className="flex gap-1 flex-wrap">
                  <Button size="sm" variant="outline" onClick={() => onAction(r.index, 'create')}
                          data-testid={`action-create-${r.index}`}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Create new
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onAction(r.index, 'manual')}
                          data-testid={`action-manual-${r.index}`}>
                    <LinkIcon className="h-3.5 w-3.5 mr-1" /> Match manually
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onAction(r.index, 'suspense')}
                          data-testid={`action-suspense-${r.index}`}>
                    <Pause className="h-3.5 w-3.5 mr-1" /> Suspense
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onAction(r.index, 'reject')}
                          data-testid={`action-reject-${r.index}`}>
                    <Ban className="h-3.5 w-3.5 mr-1" /> Reject
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Action form — drives Create / Manual match / Suspense / Reject
// ════════════════════════════════════════════════════════════════════════════
function ActionForm({
  row, kind, account, firmId, periodId, importId, userId, unreconTxns,
  onClose, onApplied,
}: {
  row:          ProcessedStatementRow
  kind:         'create' | 'manual' | 'suspense' | 'reject'
  account:      BankAccount
  firmId:       string
  periodId:     string
  importId:     string
  userId:       string | null
  unreconTxns:  Transaction[]
  onClose:      () => void
  onApplied:    (patch: Partial<ProcessedStatementRow>) => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Per-kind state.
  const [description,   setDescription]   = useState(row.description)
  const [amountP,       setAmountP]       = useState<number | null>(row.amountP)
  const [transactionDate, setTransactionDate] = useState(row.date)
  const [payeePayer,    setPayeePayer]    = useState(row.payee ?? '')
  const [reference,     setReference]     = useState(row.reference ?? '')

  const [pickedTxnId,   setPickedTxnId]   = useState<string>('')

  const [reason,        setReason]        = useState('')
  const [targetDate,    setTargetDate]    = useState(todayISODate())

  async function handleApply() {
    setError(null)
    if (!userId) { setError('User session missing'); return }
    setSaving(true)
    try {
      switch (kind) {
        case 'create': {
          if (!description.trim() || amountP == null || amountP === 0) {
            throw new Error('Description and non-zero amount are required.')
          }
          const txnType = amountP > 0 ? 'receipt' : 'payment'
          const { data: txn, error } = await supabase.from('transactions').insert({
            firm_id:             firmId,
            property_id:         account.property_id,
            bank_account_id:     account.id,
            transaction_type:    txnType,
            transaction_date:    transactionDate,
            amount:              pToPounds(amountP),
            description:         description.trim(),
            payee_payer:         payeePayer || null,
            reference:           reference || null,
            reconciled:          true,
            reconciled_at:       new Date().toISOString(),
            reconciled_by:       userId,
            statement_import_id: importId,
            created_by:          userId,
          }).select('id').single()
          if (error || !txn) throw new Error(error?.message ?? 'Failed to create transaction')
          await recordAction({
            firmId, bankAccountId: account.id,
            reconciliationPeriodId: periodId, bankStatementImportId: importId,
            action: 'manual_match', actorId: userId,
            beforeState: { matched: false } as never,
            afterState: { matched: true, transaction_id: txn.id, statement_row_index: row.index, created_via: 'create_new' } as never,
            notes: `${RICS_3_7_NOTE} — created new transaction from unmatched statement row`,
          })
          await onApplied({
            matchStatus: 'matched', matchedTransactionId: txn.id,
          })
          break
        }
        case 'manual': {
          if (!pickedTxnId) throw new Error('Pick a transaction to match.')
          const { error } = await supabase.from('transactions').update({
            reconciled:          true,
            reconciled_at:       new Date().toISOString(),
            reconciled_by:       userId,
            statement_import_id: importId,
          }).eq('id', pickedTxnId)
          if (error) throw new Error(error.message)
          await recordAction({
            firmId, bankAccountId: account.id,
            reconciliationPeriodId: periodId, bankStatementImportId: importId,
            action: 'manual_match', actorId: userId,
            beforeState: { matched: false } as never,
            afterState: { matched: true, transaction_id: pickedTxnId, statement_row_index: row.index, created_via: 'manual_match' } as never,
            notes: `${RICS_3_7_NOTE} — manual match of unmatched statement row to existing transaction`,
          })
          await onApplied({
            matchStatus: 'matched', matchedTransactionId: pickedTxnId,
          })
          break
        }
        case 'suspense': {
          if (!reason.trim()) throw new Error('Reason is required for suspense.')
          const { data: si, error } = await supabase.from('suspense_items').insert({
            firm_id:                  firmId,
            bank_statement_import_id: importId,
            statement_row_index:      row.index,
            amount:                   pToPounds(row.amountP),
            statement_date:           row.date,
            description:              row.description,
            target_resolution_date:   targetDate,
            status:                   'open',
            resolution_notes:         reason.trim(),
          }).select('id').single()
          if (error || !si) throw new Error(error?.message ?? 'Failed to create suspense item')
          await recordAction({
            firmId, bankAccountId: account.id,
            reconciliationPeriodId: periodId, bankStatementImportId: importId,
            action: 'suspense', actorId: userId,
            beforeState: { row_status: 'unmatched' } as never,
            afterState: { row_status: 'suspense', suspense_item_id: si.id, target_resolution_date: targetDate } as never,
            notes: `${RICS_3_7_NOTE} — marked as suspense: ${reason.trim()}`,
          })
          await onApplied({
            matchStatus: 'suspense', suspenseItemId: si.id,
          })
          break
        }
        case 'reject': {
          if (!reason.trim()) throw new Error('Reason is required for rejection.')
          await recordAction({
            firmId, bankAccountId: account.id,
            reconciliationPeriodId: periodId, bankStatementImportId: importId,
            action: 'reject', actorId: userId,
            beforeState: { row_status: 'unmatched' } as never,
            afterState: { row_status: 'rejected' } as never,
            notes: `${RICS_3_7_NOTE} — statement row rejected: ${reason.trim()}`,
          })
          await onApplied({
            matchStatus: 'rejected', rejectionReason: reason.trim(),
          })
          break
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const title =
    kind === 'create' ? 'Create new transaction from statement row' :
    kind === 'manual' ? 'Match manually to an existing transaction' :
    kind === 'suspense' ? 'Mark as suspense (held pending investigation)' :
                          'Reject statement row'

  return (
    <Card className="mt-4 border-primary/40">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-medium">{title}</h4>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close action form">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {error && (
          <div className="mb-3 flex items-start gap-2 text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span data-testid="action-error">{error}</span>
          </div>
        )}

        {kind === 'create' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Description *">
              <Input value={description} onChange={e => setDescription(e.target.value)} data-testid="create-description" />
            </Field>
            <Field label="Date *">
              <Input type="date" value={transactionDate} onChange={e => setTransactionDate(e.target.value)} data-testid="create-date" />
            </Field>
            <Field label="Amount * (sign-bearing pence)">
              <MoneyInput value={amountP} onChange={setAmountP} allowNegative data-testid="create-amount" />
            </Field>
            <Field label="Payee / payer">
              <Input value={payeePayer} onChange={e => setPayeePayer(e.target.value)} />
            </Field>
            <Field label="Reference">
              <Input value={reference} onChange={e => setReference(e.target.value)} />
            </Field>
          </div>
        )}

        {kind === 'manual' && (
          <Field label="Pick an unreconciled transaction on this account">
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={pickedTxnId}
              onChange={e => setPickedTxnId(e.target.value)}
              data-testid="manual-pick-txn"
            >
              <option value="">Choose a transaction…</option>
              {unreconTxns.map(t => (
                <option key={t.id} value={t.id}>
                  {formatDate(t.transaction_date)} · {formatPounds(Math.abs(Number(t.amount)))} · {t.description}
                </option>
              ))}
            </select>
          </Field>
        )}

        {kind === 'suspense' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Reason *">
              <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is this in suspense?" data-testid="suspense-reason" />
            </Field>
            <Field label="Target resolution date">
              <Input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} data-testid="suspense-target-date" />
            </Field>
          </div>
        )}

        {kind === 'reject' && (
          <Field label="Reason *">
            <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is this row rejected? (e.g. duplicate, data error)" data-testid="reject-reason" />
          </Field>
        )}

        <div className="flex justify-end gap-2 pt-3">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleApply} disabled={saving} data-testid="action-submit">
            {saving ? 'Saving…' : 'Apply'}
          </Button>
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
