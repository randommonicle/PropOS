/**
 * @file ReconciliationTab.tsx
 * @description Per-property reconciliation workspace. Ninth tab on
 * PropertyDetailPage. Spec §5.3 — Bank Reconciliation Engine.
 *
 * Responsible for: listing bank accounts on the property with their current
 *                  reconciliation status (last_reconciled_at + open
 *                  reconciliation_periods row); starting a new reconciliation
 *                  period (which routes into StatementImportModal); listing
 *                  completed historical periods with their carried-forward flag.
 * NOT responsible for: matching engine + review screen (lands in 1h.2 —
 *                      ReconciliationReviewModal); completion pre-flight +
 *                      £0.01 balance gate (lands in 1h.3 —
 *                      ReconciliationCompleteModal); suspense-item resolution
 *                      UI (deferred — see DECISIONS forward entry).
 *
 * UX rules (spec §5.3 + plan 1h):
 *   1. Per-property scope. Lists all bank_accounts on this property; each
 *      has its own reconciliation row. The partial unique index
 *      uq_recperiod_one_open_per_account (00025) means at most one open
 *      period per account at any time.
 *   2. "Start reconciliation" is disabled when an open period exists for the
 *      account. The button on a row with an open period flips to "Continue
 *      reconciliation" and routes to the next stage of that period.
 *   3. Period_start defaults to bank_accounts.last_reconciled_at + 1 day if
 *      set, otherwise the account's opened_date. Period_end defaults to today.
 *   4. Status badges:
 *        - "Reconciled to <date>" for the most-recent completed period
 *        - "In progress (statement uploaded)" when an open period has a
 *          linked bank_statement_imports row in 'processing' status
 *        - "In progress (statement pending)" when an open period has no
 *          import yet
 *
 * FORWARD: PROD-GATE — re-reconciliation flow (un-mark a reconciled
 * transaction, re-open a closed period) is not in this commit. Production
 * needs a controlled path for legitimate re-reconciliation under admin
 * approval. Anchor: plan 1h §Out of scope.
 */
import { useEffect, useState, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import {
  Card, CardContent, Button, Badge,
} from '@/components/ui'
import { Upload, Play, AlertTriangle, X, CheckCircle2, Clock, Flag } from 'lucide-react'
import { formatDate, todayISODate } from '@/lib/utils'
import { formatPounds } from '@/lib/money'
import { StatementImportModal } from './StatementImportModal'
import { ReconciliationReviewModal } from './ReconciliationReviewModal'
import { ReconciliationCompleteModal } from './ReconciliationCompleteModal'
import type { Database } from '@/types/database'

type BankAccount             = Database['public']['Tables']['bank_accounts']['Row']
type ReconciliationPeriod    = Database['public']['Tables']['reconciliation_periods']['Row']
type BankStatementImport     = Database['public']['Tables']['bank_statement_imports']['Row']

interface AccountReconState {
  account:              BankAccount
  openPeriod:           ReconciliationPeriod | null
  openPeriodImport:     BankStatementImport | null
  lastCompletedPeriod:  ReconciliationPeriod | null
  completedPeriods:     ReconciliationPeriod[]
}

export function ReconciliationTab({
  firmId,
  propertyId,
}: {
  firmId: string
  propertyId: string
}) {
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [periods,  setPeriods]  = useState<ReconciliationPeriod[]>([])
  const [imports,  setImports]  = useState<BankStatementImport[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  /** When set: the account whose Start / Continue reconciliation button was
   *  clicked. The active modal is dispatched by state — if the account's open
   *  period already has a linked bank_statement_import, we open the review
   *  modal; otherwise the import modal. */
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null)
  /** Separate state for the completion modal — driven by the per-row "Mark
   *  complete" button on rows where the import is in 'matched' or beyond. */
  const [completingAccountId, setCompletingAccountId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data: accountsData, error: accErr } = await supabase
      .from('bank_accounts').select('*')
      .eq('property_id', propertyId).order('account_name')
    if (accErr) { setError(accErr.message); setLoading(false); return }
    const accountIds = (accountsData ?? []).map(a => a.id)

    const periodsP = accountIds.length
      ? supabase.from('reconciliation_periods').select('*')
          .in('bank_account_id', accountIds).order('period_end', { ascending: false })
      : Promise.resolve({ data: [] as ReconciliationPeriod[], error: null })
    const importsP = accountIds.length
      ? supabase.from('bank_statement_imports').select('*')
          .in('bank_account_id', accountIds).order('created_at', { ascending: false })
      : Promise.resolve({ data: [] as BankStatementImport[], error: null })

    const [periodsRes, importsRes] = await Promise.all([periodsP, importsP])
    setAccounts(accountsData ?? [])
    setPeriods(periodsRes.data ?? [])
    setImports(importsRes.data ?? [])
    setLoading(false)
  }, [propertyId])

  useEffect(() => { load() }, [load])

  /** Pre-aggregated per-account state. */
  const accountStates: AccountReconState[] = useMemo(() => {
    return accounts.map(account => {
      const accountPeriods = periods.filter(p => p.bank_account_id === account.id)
      const openPeriod = accountPeriods.find(p => p.status === 'open') ?? null
      const completedPeriods = accountPeriods.filter(p => p.status === 'completed')
      const openPeriodImport = openPeriod?.bank_statement_import_id
        ? imports.find(i => i.id === openPeriod.bank_statement_import_id) ?? null
        : null
      return {
        account,
        openPeriod,
        openPeriodImport,
        lastCompletedPeriod: completedPeriods[0] ?? null,
        completedPeriods,
      }
    })
  }, [accounts, periods, imports])

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading reconciliation…</div>
  }

  return (
    <section aria-label="Reconciliation">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h2 className="font-semibold">Reconciliation ({accounts.length} {accounts.length === 1 ? 'account' : 'accounts'})</h2>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {accounts.length === 0 ? (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">
          No bank accounts on this property yet. Add one in the Bank accounts tab to start reconciling.
        </CardContent></Card>
      ) : (
        <div className="space-y-3">
          {accountStates.map(state => (
            <AccountReconciliationCard
              key={state.account.id}
              state={state}
              onStart={() => setActiveAccountId(state.account.id)}
              onComplete={() => setCompletingAccountId(state.account.id)}
            />
          ))}
        </div>
      )}

      {activeAccountId && (() => {
        const state = accountStates.find(s => s.account.id === activeAccountId)
        if (!state) return null
        // Dispatch by state: if openPeriod has an import already, route to
        // the review modal (1h.2). Otherwise the import modal (1h.1).
        if (state.openPeriod && state.openPeriodImport) {
          return (
            <ReconciliationReviewModal
              firmId={firmId}
              account={state.account}
              period={state.openPeriod}
              importRow={state.openPeriodImport}
              onClose={() => { setActiveAccountId(null); load() }}
            />
          )
        }
        const acc = state.account
        const defaultPeriodStart = (() => {
          const last = acc.last_reconciled_at
          if (last) {
            const d = new Date(last)
            d.setUTCDate(d.getUTCDate() + 1)
            return d.toISOString().slice(0, 10)
          }
          return acc.opened_date ?? todayISODate()
        })()
        return (
          <StatementImportModal
            firmId={firmId}
            account={acc}
            openPeriod={state.openPeriod}
            openPeriodImport={state.openPeriodImport}
            defaultPeriodStart={defaultPeriodStart}
            onClose={() => setActiveAccountId(null)}
            onSaved={() => { setActiveAccountId(null); load() }}
          />
        )
      })()}

      {completingAccountId && (() => {
        const state = accountStates.find(s => s.account.id === completingAccountId)
        if (!state || !state.openPeriod || !state.openPeriodImport) return null
        return (
          <ReconciliationCompleteModal
            firmId={firmId}
            account={state.account}
            period={state.openPeriod}
            importRow={state.openPeriodImport}
            onClose={() => setCompletingAccountId(null)}
            onCompleted={() => { setCompletingAccountId(null); load() }}
          />
        )
      })()}
    </section>
  )
}

// ── Single account row ──────────────────────────────────────────────────────
function AccountReconciliationCard({
  state, onStart, onComplete,
}: {
  state: AccountReconState
  onStart: () => void
  onComplete: () => void
}) {
  const { account, openPeriod, openPeriodImport, lastCompletedPeriod, completedPeriods } = state
  const canComplete = !!openPeriod && !!openPeriodImport
    && (openPeriodImport.status === 'matched' || openPeriodImport.status === 'complete')

  const reconciledLabel = account.last_reconciled_at
    ? `Reconciled to ${formatDate(account.last_reconciled_at)}`
    : 'Never reconciled'

  const balanceLabel = formatPounds(Number(account.current_balance ?? 0))

  // Status badge for the row.
  let statusBadge: React.ReactNode
  if (openPeriod) {
    const importStatus = openPeriodImport?.status ?? 'pending'
    const label =
      importStatus === 'processing' ? 'Statement uploaded' :
      importStatus === 'matched'    ? 'Matching complete' :
      importStatus === 'complete'   ? 'Ready to complete' :
                                      'Statement pending'
    statusBadge = (
      <Badge variant="amber" data-testid={`recon-status-${account.id}`}>
        <Clock className="h-3 w-3 mr-1" /> In progress · {label}
      </Badge>
    )
  } else if (lastCompletedPeriod) {
    statusBadge = (
      <Badge variant="green" data-testid={`recon-status-${account.id}`}>
        <CheckCircle2 className="h-3 w-3 mr-1" /> {reconciledLabel}
      </Badge>
    )
  } else {
    statusBadge = (
      <Badge variant="secondary" data-testid={`recon-status-${account.id}`}>
        Never reconciled
      </Badge>
    )
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="space-y-1">
            <div className="font-medium">{account.account_name}</div>
            <div className="text-xs text-muted-foreground">
              Current balance: <span className="font-mono tabular-nums">{balanceLabel}</span>
              {' · '}
              {reconciledLabel}
            </div>
            <div>{statusBadge}</div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              onClick={onStart}
              data-testid={`recon-start-${account.id}`}
              aria-label={openPeriod
                ? `Continue reconciliation for ${account.account_name}`
                : `Start reconciliation for ${account.account_name}`}
            >
              {openPeriod ? <Play className="h-4 w-4 mr-1" /> : <Upload className="h-4 w-4 mr-1" />}
              {openPeriod ? 'Continue reconciliation' : 'Start reconciliation'}
            </Button>
            {canComplete && (
              <Button
                size="sm"
                variant="outline"
                onClick={onComplete}
                data-testid={`recon-complete-${account.id}`}
                aria-label={`Mark reconciliation complete for ${account.account_name}`}
              >
                <Flag className="h-4 w-4 mr-1" /> Mark complete
              </Button>
            )}
          </div>
        </div>

        {openPeriod && (
          <div className="mt-3 text-xs text-muted-foreground border-t pt-3">
            Open period: {formatDate(openPeriod.period_start)} → {formatDate(openPeriod.period_end)}.
            {openPeriodImport
              ? ` Statement uploaded: ${openPeriodImport.filename ?? 'unnamed'} (${openPeriodImport.row_count ?? 0} rows).`
              : ' No statement uploaded yet.'}
          </div>
        )}

        {completedPeriods.length > 0 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              {completedPeriods.length} completed {completedPeriods.length === 1 ? 'period' : 'periods'}
            </summary>
            <ul className="mt-2 space-y-1">
              {completedPeriods.map(p => (
                <li key={p.id} className="flex items-center gap-2">
                  <CheckCircle2 className="h-3 w-3 text-green-700 flex-shrink-0" />
                  <span>
                    {formatDate(p.period_start)} → {formatDate(p.period_end)}
                    {p.suspense_carried_forward && (
                      <Badge variant="amber" className="ml-2">Suspense carried forward</Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  )
}
