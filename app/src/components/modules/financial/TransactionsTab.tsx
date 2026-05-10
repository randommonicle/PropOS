/**
 * @file TransactionsTab.tsx
 * @description Per-property transactions list + create / edit / delete.
 * Seventh tab on PropertyDetailPage.
 *
 * Responsible for: full CRUD on `transactions` rows scoped to a single
 *                  property, with sign-aware amount entry, demand linking
 *                  with auto-status update, dual-auth gating against
 *                  `bank_accounts.requires_dual_auth` + `dual_auth_threshold`,
 *                  reconciled-lock and statement-import-lock.
 * NOT responsible for: bank reconciliation workflow, statement import,
 *                      payment authorisations second-signer flow (1f),
 *                      paired inter-account-transfer rows, multi-demand
 *                      payment allocation, contractor invoice matching.
 *
 * Regulatory rules (DECISIONS 2026-05-10 — transactions UX):
 *   1. Sign convention: schema stores positive = in, negative = out. The PM
 *      enters absolute amounts. Sign is derived from `transaction_type`:
 *      receipt → +, payment → flipped to − on save, journal → explicit via
 *      MoneyInput allowNegative=true.
 *   2. `bank_accounts.current_balance` is NEVER written from this UI. The
 *      `sync_bank_account_balance` trigger (00005:144-165) maintains it on
 *      every transactions INSERT / UPDATE / DELETE.
 *   3. Dual-auth gate (commit 1f live): a `payment` against an account with
 *      `requires_dual_auth=true` AND amount exceeding `dual_auth_threshold`
 *      no longer saves a transaction directly. Instead the form inserts a
 *      `payment_authorisations` row (status=pending) with the proposed
 *      transaction as a JSONB snapshot. A second user (admin or director, not
 *      the requester) authorises via the Payment authorisations tab; on
 *      authorise the transaction is created from the snapshot and the
 *      payment_authorisations row is linked. See PaymentAuthorisationsTab.
 *   4. Reconciled lock: `reconciled=true` rows open with all fields disabled
 *      and surface a regulatory note. Reconciliation lives on the per-property
 *      Reconciliation tab (1h.1 / 1h.2 / 1h.3 — ReconciliationTab,
 *      StatementImportModal, ReconciliationReviewModal,
 *      ReconciliationCompleteModal). Re-reconciliation flow (un-mark a
 *      reconciled transaction) is deferred — see DECISIONS forward entry.
 *   5. Statement-import lock: `statement_import_id IS NOT NULL` rows are
 *      similarly locked. Statement-imported transactions are part of an
 *      upstream audit chain (CSV / OFX / Open Banking) and immutable from UI.
 *   6. Delete policy: hard-delete only when `reconciled=false` AND
 *      `statement_import_id IS NULL`. Trigger auto-adjusts balance.
 *   7. Demand auto-status: setting `demand_id` on a `receipt` transaction
 *      auto-updates the linked demand based on the SUM of all receipts
 *      against that demand: ≥ demand amount → `paid`; otherwise → `part_paid`.
 *      Deletion of a receipt does NOT auto-revert the demand status; the PM
 *      updates manually. Full payment-allocation engine deferred.
 */
import { useEffect, useState, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import {
  Card, CardContent, Button, Badge, Input,
} from '@/components/ui'
import { MoneyInput } from '@/components/shared/MoneyInput'
import { Plus, Pencil, Trash2, X, AlertTriangle, Lock } from 'lucide-react'
import { cn, formatDate, slugToTitle, todayISODate } from '@/lib/utils'
import { poundsToP, pToPounds, formatPounds } from '@/lib/money'
import {
  DEMAND_OPEN_STATUSES,
  TRANSACTION_TYPES, type TransactionType,
} from '@/lib/constants'
import type { Database } from '@/types/database'

type Transaction         = Database['public']['Tables']['transactions']['Row']
type BankAccount         = Database['public']['Tables']['bank_accounts']['Row']
type Demand              = Database['public']['Tables']['demands']['Row']
type Unit                = Database['public']['Tables']['units']['Row']
type Leaseholder         = Database['public']['Tables']['leaseholders']['Row']

const SELECT_CLASS = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60'

/** Types surfaced in the form selector. `inter_account_transfer` is in the
 *  schema but deferred — paired-row creation requires its own commit. */
const TYPE_OPTIONS: Array<{ value: TransactionType; label: string }> =
  TRANSACTION_TYPES
    .filter(t => t !== 'inter_account_transfer')
    .map(value => ({ value, label: slugToTitle(value) }))

const TYPE_BADGE_VARIANT: Record<TransactionType, 'green' | 'amber' | 'secondary'> = {
  receipt:                 'green',
  payment:                 'amber',
  journal:                 'secondary',
  inter_account_transfer:  'secondary',
}

const RECONCILED_LOCK_TOOLTIP =
  'Reconciled transactions cannot be edited or deleted. Audit-history retention ' +
  '(RICS Client Money Rule 4.7 / TPI §5) requires reconciled rows to remain. The ' +
  'only path to undo a reconciliation is the bank reconciliation workflow.'

const STATEMENT_IMPORT_LOCK_TOOLTIP =
  'This transaction was imported from a bank statement and is part of an upstream ' +
  'audit chain. It cannot be edited or deleted from the UI. Adjustments must be ' +
  'made via a corresponding journal transaction so the audit chain is preserved.'

const DUAL_AUTH_REQUEST_CONFIRMATION =
  'Payment authorisation request created. An admin or director (not the ' +
  'requester) must authorise it before the transaction is recorded. View ' +
  'and authorise under the Payment authorisations tab.'

export function TransactionsTab({
  firmId,
  propertyId,
}: {
  firmId: string
  propertyId: string
}) {
  const userId = useAuthStore(s => s.user?.id ?? null)

  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [accounts,     setAccounts]     = useState<BankAccount[]>([])
  const [demands,      setDemands]      = useState<Demand[]>([])
  const [units,        setUnits]        = useState<Unit[]>([])
  const [leaseholders, setLeaseholders] = useState<Leaseholder[]>([])
  const [loading,      setLoading]      = useState(true)

  /** Filter list by bank account. '' = all. */
  const [accountFilter, setAccountFilter] = useState<string>('')

  const [showForm,    setShowForm]    = useState(false)
  const [editing,     setEditing]     = useState<Transaction | null>(null)
  const [deletingId,  setDeletingId]  = useState<string | null>(null)
  const [deleteErr,   setDeleteErr]   = useState<string | null>(null)
  const [requestNotice, setRequestNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [txnRes, accRes, demRes, unitsRes, lhRes] = await Promise.all([
      supabase.from('transactions').select('*')
        .eq('property_id', propertyId).order('transaction_date', { ascending: false }),
      supabase.from('bank_accounts').select('*')
        .eq('property_id', propertyId).order('account_name'),
      supabase.from('demands').select('*')
        .eq('property_id', propertyId).order('created_at', { ascending: false }),
      supabase.from('units').select('*')
        .eq('property_id', propertyId).order('unit_ref'),
      supabase.from('leaseholders').select('*')
        .eq('property_id', propertyId).order('full_name'),
    ])
    setTransactions(txnRes.data ?? [])
    setAccounts(accRes.data ?? [])
    setDemands(demRes.data ?? [])
    setUnits(unitsRes.data ?? [])
    setLeaseholders(lhRes.data ?? [])
    setLoading(false)
  }, [propertyId])

  useEffect(() => { load() }, [load])

  const accountMap     = useMemo(() => new Map(accounts.map(a => [a.id, a.account_name])), [accounts])
  const unitMap        = useMemo(() => new Map(units.map(u => [u.id, u.unit_ref])), [units])
  const leaseholderMap = useMemo(() => new Map(leaseholders.map(lh => [lh.id, lh.full_name])), [leaseholders])
  const demandMap      = useMemo(() => new Map(demands.map(d => [d.id, d])), [demands])

  const visible = useMemo(
    () => accountFilter
      ? transactions.filter(t => t.bank_account_id === accountFilter)
      : transactions,
    [transactions, accountFilter],
  )

  async function handleDelete(txn: Transaction) {
    setDeleteErr(null)

    // Reconciled lock — even if the row UI hid the button, defence in depth.
    if (txn.reconciled) {
      setDeleteErr(
        'Cannot delete — this transaction has been reconciled. Per RICS Client ' +
        'Money Rule 4.7 and TPI Code §5, reconciled rows must be retained for ' +
        'audit. Adjustments must be made via a journal transaction.'
      )
      return
    }
    // Statement-import lock — same logic for the upstream audit chain.
    if (txn.statement_import_id) {
      setDeleteErr(
        'Cannot delete — this transaction was imported from a bank statement ' +
        'and is part of the upstream audit chain. Adjustments must be made via ' +
        'a corresponding journal transaction.'
      )
      return
    }

    const { error } = await supabase.from('transactions').delete().eq('id', txn.id)
    if (error) {
      setDeleteErr(
        error.code === '23503'
          ? 'Cannot delete — this transaction has linked records (e.g. payment ' +
            'authorisations). Resolve those references first.'
          : error.message
      )
      return
    }
    setDeletingId(null)
    load()
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading transactions…</div>
  }

  return (
    <section aria-label="Transactions">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h2 className="font-semibold">Transactions ({visible.length})</h2>
        <div className="flex items-center gap-3">
          <label className="text-sm text-muted-foreground flex items-center gap-2">
            Account
            <select
              className={SELECT_CLASS + ' min-w-[14rem]'}
              value={accountFilter}
              onChange={e => setAccountFilter(e.target.value)}
              aria-label="Filter by bank account"
            >
              <option value="">All accounts</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.account_name}</option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            onClick={() => { setEditing(null); setShowForm(true) }}
            disabled={accounts.length === 0}
            title={accounts.length === 0 ? 'Add a bank account first.' : undefined}
          >
            <Plus className="h-4 w-4 mr-1" /> Add transaction
          </Button>
        </div>
      </div>

      {showForm && (
        <TransactionForm
          firmId={firmId}
          propertyId={propertyId}
          userId={userId}
          accounts={accounts}
          demands={demands}
          unitMap={unitMap}
          leaseholderMap={leaseholderMap}
          initial={editing}
          defaultAccountId={accountFilter || undefined}
          onSaved={({ notice } = {}) => {
            setShowForm(false); setEditing(null)
            if (notice) setRequestNotice(notice)
            load()
          }}
          onCancel={() => { setShowForm(false); setEditing(null) }}
        />
      )}

      {requestNotice && (
        <div className="mb-3 flex items-start gap-2 text-sm border border-amber-300 bg-amber-50 text-amber-900 rounded-md px-3 py-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1" data-testid="dual-auth-request-notice">{requestNotice}</span>
          <button onClick={() => setRequestNotice(null)} aria-label="Dismiss notice">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {deleteErr && (
        <div className="mb-3 flex items-start gap-2 text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{deleteErr}</span>
          <button onClick={() => setDeleteErr(null)} aria-label="Dismiss error">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Date</th>
              <th className="text-left px-4 py-2 font-medium">Type</th>
              <th className="text-left px-4 py-2 font-medium">Account</th>
              <th className="text-left px-4 py-2 font-medium">Description</th>
              <th className="text-left px-4 py-2 font-medium">Payee / payer</th>
              <th className="text-right px-4 py-2 font-medium">Amount</th>
              <th className="text-left px-4 py-2 font-medium">Demand</th>
              <th className="text-left px-4 py-2 font-medium">Reconciled</th>
              <th className="text-left px-4 py-2 font-medium">Source</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                  No transactions recorded yet.
                </td>
              </tr>
            ) : (
              visible.map(t => (
                <TransactionRow
                  key={t.id}
                  txn={t}
                  accountName={accountMap.get(t.bank_account_id) ?? '—'}
                  demandSummary={summariseDemand(t.demand_id, demandMap, unitMap, leaseholderMap)}
                  isDeleting={deletingId === t.id}
                  onEdit={() => { setEditing(t); setShowForm(true); setDeleteErr(null) }}
                  onAskDelete={() => { setDeletingId(t.id); setDeleteErr(null) }}
                  onConfirmDelete={() => handleDelete(t)}
                  onCancelDelete={() => setDeletingId(null)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ── Single row ────────────────────────────────────────────────────────────────
function TransactionRow({
  txn, accountName, demandSummary, isDeleting,
  onEdit, onAskDelete, onConfirmDelete, onCancelDelete,
}: {
  txn: Transaction
  accountName: string
  demandSummary: string
  isDeleting: boolean
  onEdit: () => void
  onAskDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  const type = txn.transaction_type as TransactionType
  const amountNum = Number(txn.amount)
  const locked = txn.reconciled || !!txn.statement_import_id
  const rowLabel = `${formatDate(txn.transaction_date)} ${slugToTitle(type)} ${formatPounds(Math.abs(amountNum))}`
  const sourceLabel = txn.statement_import_id
    ? 'Statement import'
    : 'Manual entry'
  return (
    <>
      <tr className={cn('border-t hover:bg-muted/30', locked && 'opacity-80')}>
        <td className="px-4 py-2">{formatDate(txn.transaction_date)}</td>
        <td className="px-4 py-2">
          <Badge variant={TYPE_BADGE_VARIANT[type] ?? 'secondary'}>
            {slugToTitle(type)}
          </Badge>
        </td>
        <td className="px-4 py-2">{accountName}</td>
        <td className="px-4 py-2">{txn.description}</td>
        <td className="px-4 py-2 text-muted-foreground">{txn.payee_payer ?? '—'}</td>
        <td
          className={cn(
            'px-4 py-2 text-right font-mono tabular-nums',
            amountNum < 0 ? 'text-destructive' : amountNum > 0 ? 'text-green-700' : '',
          )}
        >
          {amountNum < 0 ? '-' : ''}{formatPounds(Math.abs(amountNum))}
        </td>
        <td className="px-4 py-2 text-xs text-muted-foreground">{demandSummary}</td>
        <td className="px-4 py-2">
          <Badge variant={txn.reconciled ? 'green' : 'secondary'}>
            {txn.reconciled ? 'Yes' : 'No'}
          </Badge>
        </td>
        <td className="px-4 py-2 text-xs text-muted-foreground">{sourceLabel}</td>
        <td className="px-4 py-2">
          <div className="flex gap-1 justify-end">
            <Button
              variant="ghost" size="sm"
              onClick={onEdit}
              aria-label={`Edit ${rowLabel}`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost" size="sm"
              className="text-destructive hover:text-destructive"
              onClick={onAskDelete}
              disabled={locked}
              title={
                txn.reconciled ? RECONCILED_LOCK_TOOLTIP
                  : txn.statement_import_id ? STATEMENT_IMPORT_LOCK_TOOLTIP
                  : undefined
              }
              aria-label={`Delete ${rowLabel}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </td>
      </tr>
      {isDeleting && (
        <tr className="border-t bg-destructive/5">
          <td colSpan={10} className="px-4 py-3">
            <div className="flex items-center gap-3 text-sm flex-wrap">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
              <span>
                Delete the <strong>{formatDate(txn.transaction_date)}</strong> {slugToTitle(type)} of{' '}
                <strong>{formatPounds(Math.abs(amountNum))}</strong>?
                The bank account balance will be auto-adjusted by the database trigger.
              </span>
              <Button size="sm" variant="destructive" onClick={onConfirmDelete}>
                Confirm delete
              </Button>
              <Button size="sm" variant="outline" onClick={onCancelDelete}>
                Cancel
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// TransactionForm — create and edit
// ════════════════════════════════════════════════════════════════════════════
function TransactionForm({
  firmId, propertyId, userId, accounts, demands, unitMap, leaseholderMap,
  initial, defaultAccountId, onSaved, onCancel,
}: {
  firmId: string
  propertyId: string
  userId: string | null
  accounts: BankAccount[]
  demands: Demand[]
  unitMap: Map<string, string>
  leaseholderMap: Map<string, string>
  initial: Transaction | null
  defaultAccountId?: string
  onSaved: (result?: { notice?: string }) => void
  onCancel: () => void
}) {
  const initialType = (initial?.transaction_type as TransactionType | undefined) ?? 'receipt'
  const isLockedReconciled = !!initial?.reconciled
  const isLockedImport     = !!initial?.statement_import_id
  const isLocked           = isLockedReconciled || isLockedImport
  const allowNegativeAmount = initialType === 'journal' || (!initial && false)

  /** For create, the entered absolute amount in pence. For edit, we display the
   *  signed value when type=journal and the absolute value otherwise. */
  const initialAmountP = initial?.amount != null
    ? poundsToP(Number(initial.amount))
    : null

  const [values, setValues] = useState({
    bank_account_id:  initial?.bank_account_id ?? defaultAccountId ?? (accounts[0]?.id ?? ''),
    transaction_type: initialType,
    transaction_date: initial?.transaction_date ?? todayISODate(),
    amount_p:         initialType === 'journal'
                        ? initialAmountP
                        : (initialAmountP != null ? Math.abs(initialAmountP) : null),
    description:      initial?.description ?? '',
    payee_payer:      initial?.payee_payer ?? '',
    reference:        initial?.reference ?? '',
    demand_id:        initial?.demand_id ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  function set<K extends keyof typeof values>(field: K, value: (typeof values)[K]) {
    setValues(v => ({ ...v, [field]: value }))
  }

  // Open demands available for receipt linking — same property, unpaid status.
  const openDemandOptions = useMemo(
    () => demands.filter(d => DEMAND_OPEN_STATUSES.includes(d.status as never)),
    [demands],
  )

  // If type changes away from receipt, clear demand_id.
  useEffect(() => {
    if (values.transaction_type !== 'receipt' && values.demand_id) {
      setValues(v => ({ ...v, demand_id: '' }))
    }
  }, [values.transaction_type, values.demand_id])

  function selectedAccount(): BankAccount | undefined {
    return accounts.find(a => a.id === values.bank_account_id)
  }

  function validate(): string | null {
    if (!values.bank_account_id) return 'Bank account is required.'
    if (!values.transaction_date) return 'Transaction date is required.'
    if (!values.description.trim()) return 'Description is required.'
    if (values.amount_p == null) return 'Amount is required.'

    if (values.transaction_type === 'receipt' || values.transaction_type === 'payment') {
      if (values.amount_p <= 0) return 'Amount must be greater than zero.'
    } else if (values.transaction_type === 'journal') {
      if (values.amount_p === 0) return 'Journal amount cannot be zero.'
    }
    return null
  }

  /** Whether this payment must be routed through the authorisation request flow. */
  function requiresDualAuth(): boolean {
    if (values.transaction_type !== 'payment') return false
    const acc = selectedAccount()
    if (!acc?.requires_dual_auth) return false
    const thresholdP = acc.dual_auth_threshold != null
      ? poundsToP(Number(acc.dual_auth_threshold))
      : 0
    return (values.amount_p ?? 0) > thresholdP
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (isLocked) { onCancel(); return }
    const v = validate()
    if (v) { setError(v); return }
    setSaving(true)

    // Sign convention. Schema stores positive = in, negative = out.
    const enteredP = values.amount_p ?? 0
    const signedP =
      values.transaction_type === 'payment' ? -Math.abs(enteredP)
      : values.transaction_type === 'receipt' ? Math.abs(enteredP)
      : enteredP // journal: as entered (allowNegative)
    const signedAmount = pToPounds(signedP)

    // Dual-auth: payment over threshold on a dual-auth account routes through
    // the authorisation request flow instead of inserting a transaction.
    if (!initial && requiresDualAuth()) {
      const proposed = {
        bank_account_id:  values.bank_account_id,
        amount:           signedAmount,
        transaction_date: values.transaction_date,
        description:      values.description.trim(),
        payee_payer:      values.payee_payer || null,
        reference:        values.reference || null,
        demand_id:        values.demand_id || null,
      }
      if (!userId) {
        setError('Cannot create authorisation request — user session missing.')
        setSaving(false)
        return
      }
      const { error: paErr } = await supabase.from('payment_authorisations').insert({
        firm_id:      firmId,
        requested_by: userId,
        status:       'pending',
        proposed,
      })
      if (paErr) { setError(paErr.message); setSaving(false); return }
      onSaved({ notice: DUAL_AUTH_REQUEST_CONFIRMATION })
      return
    }

    const payload = {
      firm_id:          firmId,
      property_id:      propertyId,
      bank_account_id:  values.bank_account_id,
      transaction_type: values.transaction_type,
      transaction_date: values.transaction_date,
      amount:           signedAmount,
      description:      values.description.trim(),
      payee_payer:      values.payee_payer || null,
      reference:        values.reference || null,
      demand_id:        values.transaction_type === 'receipt'
                          ? (values.demand_id || null)
                          : null,
      created_by:       initial ? undefined : userId,
    }

    let err: { message: string } | null = null
    let savedDemandId: string | null = null
    if (initial) {
      ;({ error: err } = await supabase.from('transactions').update(payload).eq('id', initial.id))
      savedDemandId = (payload.demand_id as string | null) ?? null
    } else {
      const { error: insertErr, data: inserted } = await supabase
        .from('transactions').insert(payload).select('demand_id').single()
      err = insertErr
      savedDemandId = (inserted?.demand_id as string | null) ?? null
    }

    if (err) { setError(err.message); setSaving(false); return }

    // Demand auto-status update for receipt links. Sum all receipts against
    // the demand and transition based on the total vs the demand amount.
    if (savedDemandId && values.transaction_type === 'receipt') {
      await applyDemandReceiptStatus(savedDemandId)
    }

    onSaved()
  }

  const acc = selectedAccount()
  const dualAuthLabel = acc?.requires_dual_auth
    ? `Dual auth required ≥ ${formatPounds(Number(acc.dual_auth_threshold ?? 0))}`
    : null

  return (
    <Card className="mb-4 max-w-3xl">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{initial ? 'Edit transaction' : 'New transaction'}</h3>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>

        {isLocked && (
          <div
            className="mb-4 flex items-start gap-2 text-sm border rounded-md px-3 py-2 bg-muted/40"
            role="note"
          >
            <Lock className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">
              {isLockedReconciled ? RECONCILED_LOCK_TOOLTIP : STATEMENT_IMPORT_LOCK_TOOLTIP}
            </span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label htmlFor="txn-account" className="text-sm font-medium">Bank account *</label>
            <select
              id="txn-account"
              required
              disabled={isLocked}
              className={SELECT_CLASS}
              value={values.bank_account_id}
              onChange={e => set('bank_account_id', e.target.value)}
            >
              <option value="">Select account…</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.account_name}</option>
              ))}
            </select>
            {dualAuthLabel && (
              <p className="text-xs text-muted-foreground">{dualAuthLabel}</p>
            )}
          </div>
          <div className="space-y-1">
            <label htmlFor="txn-type" className="text-sm font-medium">Type *</label>
            <select
              id="txn-type"
              required
              disabled={isLocked}
              className={SELECT_CLASS}
              value={values.transaction_type}
              onChange={e => set('transaction_type', e.target.value as TransactionType)}
            >
              {TYPE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="txn-date" className="text-sm font-medium">Transaction date *</label>
            <Input
              id="txn-date"
              type="date"
              required
              disabled={isLocked}
              value={values.transaction_date}
              onChange={e => set('transaction_date', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="txn-amount" className="text-sm font-medium">
              Amount *
              {values.transaction_type === 'payment' && (
                <span className="text-xs text-muted-foreground ml-2">(saved as negative)</span>
              )}
              {values.transaction_type === 'journal' && (
                <span className="text-xs text-muted-foreground ml-2">(sign explicit)</span>
              )}
            </label>
            <MoneyInput
              id="txn-amount"
              disabled={isLocked}
              allowNegative={allowNegativeAmount || values.transaction_type === 'journal'}
              value={values.amount_p}
              onChange={p => set('amount_p', p)}
              placeholder="0.00"
            />
          </div>

          <div className="col-span-2 space-y-1">
            <label htmlFor="txn-desc" className="text-sm font-medium">Description *</label>
            <Input
              id="txn-desc"
              required
              disabled={isLocked}
              placeholder="e.g. Service charge receipt — Flat 4 — Q2 2026"
              value={values.description}
              onChange={e => set('description', e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="txn-payee" className="text-sm font-medium">Payee / payer</label>
            <Input
              id="txn-payee"
              disabled={isLocked}
              placeholder="e.g. Jane Smith"
              value={values.payee_payer}
              onChange={e => set('payee_payer', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="txn-ref" className="text-sm font-medium">Reference</label>
            <Input
              id="txn-ref"
              disabled={isLocked}
              placeholder="e.g. cheque or transaction ID"
              value={values.reference}
              onChange={e => set('reference', e.target.value)}
            />
          </div>

          {/* Demand link — only for receipts */}
          {values.transaction_type === 'receipt' && (
            <div className="col-span-2 space-y-1">
              <label htmlFor="txn-demand" className="text-sm font-medium">
                Link to demand (optional)
              </label>
              <select
                id="txn-demand"
                disabled={isLocked}
                className={SELECT_CLASS}
                value={values.demand_id}
                onChange={e => set('demand_id', e.target.value)}
              >
                <option value="">Not linked</option>
                {openDemandOptions.map(d => (
                  <option key={d.id} value={d.id}>
                    {summariseDemandOption(d, unitMap, leaseholderMap)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Linking a receipt auto-updates the demand status: paid if the
                cumulative receipts cover the demand amount, otherwise part paid.
              </p>
            </div>
          )}

          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <div className="col-span-2 flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving || isLocked}>
              {saving ? 'Saving…' : initial ? 'Update transaction' : 'Save transaction'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────────

function summariseDemand(
  demandId: string | null,
  demandMap: Map<string, Demand>,
  unitMap: Map<string, string>,
  leaseholderMap: Map<string, string>,
): string {
  if (!demandId) return '—'
  const d = demandMap.get(demandId)
  if (!d) return '—'
  const unit = unitMap.get(d.unit_id) ?? '—'
  const lh = leaseholderMap.get(d.leaseholder_id) ?? '—'
  return `${unit} · ${lh}`
}

function summariseDemandOption(
  d: Demand,
  unitMap: Map<string, string>,
  leaseholderMap: Map<string, string>,
): string {
  const unit = unitMap.get(d.unit_id) ?? '—'
  const lh = leaseholderMap.get(d.leaseholder_id) ?? '—'
  const issued = d.issued_date ? formatDate(d.issued_date) : 'unissued'
  return `${unit} — ${lh} — ${formatPounds(d.amount)} (${slugToTitle(d.status)}, ${issued})`
}

/**
 * After saving a receipt linked to a demand, recompute the demand's payment
 * status from the SUM of all receipts against it. paid if covered, else
 * part_paid. Forward-only: never reverts a paid demand back. The s.21B guard
 * in DemandsTab does NOT need to be re-checked here because the demand is
 * already issued (precondition of being linkable).
 */
async function applyDemandReceiptStatus(demandId: string): Promise<void> {
  const { data: dem } = await supabase
    .from('demands').select('amount, status').eq('id', demandId).single()
  if (!dem) return
  const { data: receipts } = await supabase
    .from('transactions')
    .select('amount')
    .eq('demand_id', demandId)
    .eq('transaction_type', 'receipt')
  const totalReceiptsP = (receipts ?? []).reduce(
    (sum, r) => sum + poundsToP(Number(r.amount)),
    0,
  )
  const demandP = poundsToP(Number(dem.amount))
  const nextStatus = totalReceiptsP >= demandP ? 'paid' : 'part_paid'

  if (dem.status !== nextStatus) {
    await supabase.from('demands').update({ status: nextStatus }).eq('id', demandId)
  }
}
