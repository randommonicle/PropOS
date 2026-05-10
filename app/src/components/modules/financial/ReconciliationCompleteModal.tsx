/**
 * @file ReconciliationCompleteModal.tsx
 * @description Completion modal for a reconciliation period. Spec §5.3
 * "Reconciliation Completion Rules".
 *
 * Responsible for: running the completion pre-flight (unmatched_count==0,
 *                  every txn in period reconciled, £0.01 balance equality,
 *                  open suspense items in period); collecting the
 *                  carried-forward override + completion notes when suspense
 *                  items exist; writing the period.status=completed + audit
 *                  row + bank_accounts.last_reconciled_at + import.status
 *                  on submit.
 * NOT responsible for: re-opening a completed period (deferred — see
 *                      DECISIONS forward entry); the matching review itself
 *                      (1h.2); statement upload (1h.1).
 *
 * Pre-flight per spec §5.3:
 *   1. unmatched_count == 0 — every statement row has a final disposition.
 *   2. Every transactions row in [period_start, period_end] on this
 *      bank_account_id has reconciled = true.
 *   3. bank_accounts.current_balance == SUM(transactions.amount) within
 *      £0.01 — spec is explicit: "If they differ by more than £0.01 the
 *      system blocks completion and surfaces the discrepancy."
 *   4. If open suspense_items dated within the period exist, completion is
 *      permitted ONLY with explicit override + non-empty completion_notes.
 *      Sets period.suspense_carried_forward = true.
 *
 * FORWARD: PROD-GATE — atomic completion. The four writes (period update,
 * bank_accounts.last_reconciled_at update, import.status update, audit-log
 * insert) are non-atomic at PoC. Production must wrap in a single Edge
 * Function call inside BEGIN…COMMIT so a partial-failure can't leave the
 * period in a torn state. Anchor: DECISIONS 2026-05-10 — Production-grade
 * gate manifest item 7.
 *
 * FORWARD: PROD-GATE — period immutability post-completion is UI-only at
 * PoC. The DB needs a BEFORE-UPDATE trigger rejecting any mutation when
 * OLD.status='completed'. Anchor: Production-grade gate manifest item 4.
 */
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import {
  Card, CardContent, Button, Input,
} from '@/components/ui'
import { X, AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { poundsToP, formatPounds } from '@/lib/money'
import { recordAction } from '@/lib/reconciliation/auditLog'
import type { Database } from '@/types/database'

type BankAccount             = Database['public']['Tables']['bank_accounts']['Row']
type ReconciliationPeriod    = Database['public']['Tables']['reconciliation_periods']['Row']
type BankStatementImport     = Database['public']['Tables']['bank_statement_imports']['Row']
type SuspenseItem            = Database['public']['Tables']['suspense_items']['Row']

const RICS_3_7_NOTE = 'RICS Rule 3.7 evidence trail'
const BALANCE_TOLERANCE_P = 1  // 1p — i.e. >£0.01 mismatch blocks completion

interface PreFlight {
  unmatchedCount:       number
  unreconciledTxnCount: number
  balanceTriggerP:      number   // bank_accounts.current_balance in pence
  balanceComputedP:     number   // SUM(transactions.amount) in pence
  balanceMismatchP:     number   // = trigger - computed
  openSuspenseInPeriod: SuspenseItem[]
}

interface Props {
  firmId:    string
  account:   BankAccount
  period:    ReconciliationPeriod
  importRow: BankStatementImport
  onClose:   () => void
  onCompleted: () => void
}

export function ReconciliationCompleteModal({
  firmId, account, period, importRow, onClose, onCompleted,
}: Props) {
  const userId = useAuthStore(s => s.user?.id ?? null)

  const [preflight, setPreflight] = useState<PreFlight | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  // Carry-forward override state.
  const [carryForward, setCarryForward] = useState(false)
  const [completionNotes, setCompletionNotes] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        // Refresh import counts + bank balance + transactions in period +
        // open suspense items dated within the period.
        const [impRes, accRes, txnsRes, suspRes] = await Promise.all([
          supabase.from('bank_statement_imports').select('unmatched_count').eq('id', importRow.id).single(),
          supabase.from('bank_accounts').select('current_balance').eq('id', account.id).single(),
          supabase.from('transactions').select('amount, reconciled')
            .eq('bank_account_id', account.id)
            .gte('transaction_date', period.period_start)
            .lte('transaction_date', period.period_end),
          supabase.from('suspense_items').select('*')
            .eq('bank_statement_import_id', importRow.id)
            .eq('status', 'open')
            .gte('statement_date', period.period_start)
            .lte('statement_date', period.period_end),
        ])
        if (cancelled) return
        if (impRes.error || accRes.error || txnsRes.error || suspRes.error) {
          throw new Error(
            (impRes.error ?? accRes.error ?? txnsRes.error ?? suspRes.error)!.message
          )
        }
        // bank_accounts.current_balance is the trigger-maintained value. The
        // SUM-from-transactions computation below uses ALL transactions on
        // the account (not just in-period) because the trigger does likewise
        // — see migration 00005:144. The £0.01 check therefore tests trigger
        // integrity rather than period boundary issues.
        const { data: allTxns } = await supabase
          .from('transactions').select('amount')
          .eq('bank_account_id', account.id)
        const computedP = (allTxns ?? []).reduce(
          (sum, t) => sum + poundsToP(Number(t.amount)),
          0,
        )
        const triggerP = poundsToP(Number(accRes.data!.current_balance))
        const txnsInPeriod = txnsRes.data ?? []
        setPreflight({
          unmatchedCount:       impRes.data!.unmatched_count ?? 0,
          unreconciledTxnCount: txnsInPeriod.filter(t => !t.reconciled).length,
          balanceTriggerP:      triggerP,
          balanceComputedP:     computedP,
          balanceMismatchP:     triggerP - computedP,
          openSuspenseInPeriod: suspRes.data ?? [],
        })
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [account.id, importRow.id, period.period_start, period.period_end])

  const blockingChecks = preflight ? collectBlocks(preflight) : []
  const requiresCarryForward = (preflight?.openSuspenseInPeriod.length ?? 0) > 0
  const carryForwardComplete = !requiresCarryForward
    || (carryForward && completionNotes.trim().length > 0)
  const canSubmit = !loading && !saving && blockingChecks.length === 0 && carryForwardComplete

  async function handleSubmit() {
    setError(null)
    if (!preflight) return
    if (!userId) { setError('User session missing.'); return }
    if (!canSubmit) return
    setSaving(true)
    try {
      // 1. Update reconciliation_periods.
      const closingBalance = preflight.balanceTriggerP / 100
      const { error: perErr } = await supabase
        .from('reconciliation_periods')
        .update({
          status:                   'completed',
          completed_at:             new Date().toISOString(),
          completed_by:             userId,
          closing_balance_snapshot: closingBalance,
          suspense_carried_forward: requiresCarryForward,
          completion_notes:         requiresCarryForward ? completionNotes.trim() : null,
        })
        .eq('id', period.id)
      if (perErr) throw new Error(perErr.message)

      // 2. Update bank_accounts.last_reconciled_at.
      const { error: accErr } = await supabase
        .from('bank_accounts')
        .update({ last_reconciled_at: new Date().toISOString() })
        .eq('id', account.id)
      if (accErr) throw new Error(accErr.message)

      // 3. Import status final.
      const { error: impErr } = await supabase
        .from('bank_statement_imports')
        .update({ status: 'complete' })
        .eq('id', importRow.id)
      if (impErr) throw new Error(impErr.message)

      // 4. Audit log: completion event. RICS Rule 3.7 evidence trail
      // load-bearing — if this row is missing, the regulatory artefact for the
      // completion event is gone. Steps 1-3 have already committed by this
      // point (period flipped to 'completed', bank account stamped,
      // import status finalised). Wrap separately so a failure here surfaces
      // a manual-repair SQL hint instead of the generic catch below (audit
      // Tier-1 B-5).
      try {
        await recordAction({
          firmId,
          bankAccountId:           account.id,
          reconciliationPeriodId:  period.id,
          bankStatementImportId:   importRow.id,
          action:                  'completion',
          actorId:                 userId,
          beforeState: {
            period_status: 'open',
          } as never,
          afterState: {
            period_status:            'completed',
            closing_balance_snapshot: closingBalance,
            suspense_carried_forward: requiresCarryForward,
            carried_forward_count:    preflight.openSuspenseInPeriod.length,
          } as never,
          notes: requiresCarryForward
            ? `${RICS_3_7_NOTE} — completion with ${preflight.openSuspenseInPeriod.length} suspense item(s) carried forward: ${completionNotes.trim()}`
            : `${RICS_3_7_NOTE} — period completed (no carried-forward suspense)`,
        })
      } catch (auditErr) {
        const msg = auditErr instanceof Error ? auditErr.message : String(auditErr)
        setError(
          `Reconciliation completion committed (period ${period.id} now 'completed', bank account ` +
          `stamped, statement import finalised) BUT the reconciliation_audit_log row failed to write: ` +
          `${msg}. RICS Rule 3.7 evidence trail requires this row — manual repair via SQL: ` +
          `INSERT INTO reconciliation_audit_log (firm_id, bank_account_id, reconciliation_period_id, ` +
          `bank_statement_import_id, action, actor_id, before_state, after_state, notes) VALUES ` +
          `('${firmId}', '${account.id}', '${period.id}', '${importRow.id}', 'completion', '${userId}', ` +
          `'{"period_status":"open"}'::jsonb, '{"period_status":"completed"}'::jsonb, ` +
          `'${RICS_3_7_NOTE} — period completed (manual repair after audit-log write failed)').`,
        )
        return
      }

      onCompleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4"
      role="dialog" aria-modal="true" aria-label="Mark reconciliation complete"
    >
      <Card className="w-full max-w-2xl my-8">
        <CardContent className="p-6">
          <header className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-700" />
                Mark reconciliation complete
              </h3>
              <p className="text-xs text-muted-foreground">
                {account.account_name} · Period {formatDate(period.period_start)} → {formatDate(period.period_end)}.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close completion modal">
              <X className="h-4 w-4" />
            </Button>
          </header>

          {loading && (
            <div className="text-sm text-muted-foreground">Running pre-flight checks…</div>
          )}

          {error && (
            <div className="mb-3 flex items-start gap-2 text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span data-testid="complete-error">{error}</span>
            </div>
          )}

          {preflight && (
            <div className="space-y-3">
              <PreFlightLine
                ok={preflight.unmatchedCount === 0}
                okLabel={`No unmatched statement rows.`}
                blockLabel={`${preflight.unmatchedCount} statement row(s) still unmatched. Resolve them in the review screen first.`}
                testid="pf-unmatched"
              />
              <PreFlightLine
                ok={preflight.unreconciledTxnCount === 0}
                okLabel={`All transactions in this period are reconciled.`}
                blockLabel={`${preflight.unreconciledTxnCount} transaction(s) in [${period.period_start}, ${period.period_end}] are not yet reconciled.`}
                testid="pf-unreconciled"
              />
              <PreFlightLine
                ok={Math.abs(preflight.balanceMismatchP) <= BALANCE_TOLERANCE_P}
                okLabel={`Bank balance ${formatPounds(preflight.balanceTriggerP / 100)} matches sum of transactions.`}
                blockLabel={
                  `Discrepancy of ${formatPounds(Math.abs(preflight.balanceMismatchP) / 100)} between ` +
                  `bank_accounts.current_balance (${formatPounds(preflight.balanceTriggerP / 100)}) and ` +
                  `SUM(transactions.amount) (${formatPounds(preflight.balanceComputedP / 100)}). ` +
                  `Spec §5.3 blocks completion when divergence exceeds £0.01.`
                }
                testid="pf-balance"
              />

              {requiresCarryForward && (
                <Card className="border-amber-300 bg-amber-50/40">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-amber-900">
                      <ShieldAlert className="h-4 w-4" />
                      {preflight.openSuspenseInPeriod.length} open suspense item(s) dated within this period
                    </div>
                    <div className="text-xs text-amber-900">
                      You can complete the period by carrying these forward, but the
                      reconciliation_periods row will be flagged
                      <code className="mx-1 px-1 py-0.5 bg-amber-200/50 rounded">suspense_carried_forward = true</code>
                      and surface in the financial summary report.
                    </div>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={carryForward}
                        onChange={e => setCarryForward(e.target.checked)}
                        data-testid="carry-forward-checkbox"
                        className="mt-0.5"
                      />
                      <span>I understand suspense items will be carried forward and surface in the financial summary report.</span>
                    </label>
                    <div className="space-y-1">
                      <label htmlFor="completion-notes" className="text-xs font-medium">
                        Completion notes * (required for carried-forward completion)
                      </label>
                      <Input
                        id="completion-notes"
                        value={completionNotes}
                        onChange={e => setCompletionNotes(e.target.value)}
                        placeholder="Why are these suspense items being carried forward?"
                        data-testid="completion-notes"
                      />
                    </div>
                  </CardContent>
                </Card>
              )}

              {blockingChecks.length === 0 && carryForwardComplete && (
                <div className="text-sm text-green-700">
                  All pre-flight checks passed. On submit:
                  <ul className="list-disc ml-5 text-xs mt-1 space-y-0.5">
                    <li>Period status → completed (closing balance {formatPounds(preflight.balanceTriggerP / 100)})</li>
                    <li>bank_accounts.last_reconciled_at = now</li>
                    <li>bank_statement_imports.status → complete</li>
                    <li>reconciliation_audit_log row written (RICS Rule 3.7)</li>
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              disabled={!canSubmit}
              data-testid="complete-submit"
            >
              {saving ? 'Completing…' : 'Mark complete'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function collectBlocks(p: PreFlight): string[] {
  const blocks: string[] = []
  if (p.unmatchedCount > 0) blocks.push(`unmatched=${p.unmatchedCount}`)
  if (p.unreconciledTxnCount > 0) blocks.push(`unreconciled=${p.unreconciledTxnCount}`)
  if (Math.abs(p.balanceMismatchP) > BALANCE_TOLERANCE_P) blocks.push(`balance=${p.balanceMismatchP}`)
  return blocks
}

function PreFlightLine({
  ok, okLabel, blockLabel, testid,
}: {
  ok: boolean
  okLabel: string
  blockLabel: string
  testid: string
}) {
  return (
    <div
      className={`flex items-start gap-2 text-sm rounded-md px-3 py-2 border ${
        ok
          ? 'border-green-300 bg-green-50/40 text-green-900'
          : 'border-destructive/40 bg-destructive/5 text-destructive'
      }`}
      data-testid={testid}
      data-ok={ok ? 'true' : 'false'}
    >
      {ok
        ? <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
        : <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />}
      <span>{ok ? okLabel : blockLabel}</span>
    </div>
  )
}
