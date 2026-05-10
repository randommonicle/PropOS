/**
 * @file BankAccountsTab.tsx
 * @description Per-property bank accounts list + create/edit/delete. Rendered inside
 * PropertyDetailPage's "Bank accounts" tab.
 *
 * Responsible for: full CRUD on `bank_accounts` rows scoped to a single property,
 *                  including FK-safe deletion guarded by RICS Client Money Rule 4.7
 *                  and TPI Code §5 audit-retention requirements; PM-facing
 *                  dual-auth request flows for closure (1g) and RICS-designation
 *                  removal (1g.5).
 * NOT responsible for: reconciliation workflow, statement import (deferred Phase 3
 *                      pieces). Transactions are owned by TransactionsTab (1e).
 *
 * Regulatory rules baked in (see DECISIONS 2026-05-09 — bank account deletion policy
 * and 2026-05-10 — closure / 1g.5 dual-auth):
 *   1. `current_balance` is read-only in the UI. It is trigger-maintained by
 *      `sync_bank_account_balance` (migration 00005:144) — every INSERT/UPDATE/DELETE
 *      on `transactions` updates the linked account's balance to `SUM(amount)`.
 *   2. Hard-delete is permitted ONLY when the account has zero transactions
 *      (FK 23503 surfaces this), zero reconciliations (`last_reconciled_at IS NULL`),
 *      and no `closed_date` set. Any other state forces the PM to use Mark as Closed
 *      (`is_active = false` + `closed_date`).
 *   3. `sort_code_last4` and `account_number_last4` are exactly four digits. The full
 *      sort code and account number are NEVER stored — see schema 00005:14-17.
 *   4. `dual_auth_threshold` uses MoneyInput (integer pence canonical) and is the
 *      payment-authorisation threshold per spec §5.6.
 *   5. Closure (`is_active: true → false`) and RICS-designation removal
 *      (`rics_designated: true → false`) are dual-auth-gated for non-finance roles:
 *      the PM clicks **Request closure** / **Request designation removal**, which
 *      inserts a `payment_authorisations` row; an admin / director (not the
 *      requester) authorises via PaymentAuthorisationsTab. The protective
 *      direction (`rics_designated: false → true`) is a direct edit, not gated.
 */
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import {
  Card, CardContent, Button, Badge, Input,
} from '@/components/ui'
import { MoneyInput } from '@/components/shared/MoneyInput'
import { Plus, Pencil, Trash2, X, AlertTriangle, Lock, Send, ShieldOff } from 'lucide-react'
import { cn, formatDate, todayISODate } from '@/lib/utils'
import { formatPounds, poundsToP, pToPounds } from '@/lib/money'
import { isFinanceRole } from '@/lib/constants'
import type { Database } from '@/types/database'

type BankAccount = Database['public']['Tables']['bank_accounts']['Row']

const SELECT_CLASS = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm'

const ACCOUNT_TYPES: Array<{ value: string; label: string }> = [
  { value: 'service_charge',  label: 'Service charge' },
  { value: 'reserve_fund',    label: 'Reserve fund' },
  { value: 'major_works',     label: 'Major works' },
  { value: 'insurance',       label: 'Insurance' },
  { value: 'client_holding',  label: 'Client holding' },
  { value: 'other',           label: 'Other' },
]

const CURRENT_BALANCE_TOOLTIP =
  'Trigger-maintained on reconciliation completion (spec §5.6). The current balance ' +
  'updates automatically when transactions are reconciled and cannot be edited directly.'

const FINANCE_ROLE_TOOLTIP =
  'Closure and hard-deletion are restricted to admin and director roles. ' +
  'Property Managers should use the Request closure button to submit a ' +
  'closure request for an admin or director to authorise (RICS Client Money ' +
  'Rule 4.7 — segregation of duties).'

export function BankAccountsTab({
  firmId,
  propertyId,
}: {
  firmId: string
  propertyId: string
}) {
  const userId = useAuthStore(s => s.user?.id ?? null)
  const role = useAuthStore(s => s.firmContext?.role ?? null)
  const canManageClosure = isFinanceRole(role)

  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [loading,  setLoading]  = useState(true)

  const [showForm,    setShowForm]    = useState(false)
  const [editing,     setEditing]     = useState<BankAccount | null>(null)
  const [deletingId,  setDeletingId]  = useState<string | null>(null)
  const [deleteErr,   setDeleteErr]   = useState<string | null>(null)
  const [requestingClosureId, setRequestingClosureId] = useState<string | null>(null)
  const [closureNotice, setClosureNotice] = useState<string | null>(null)
  const [closureErr, setClosureErr] = useState<string | null>(null)
  const [requestingRicsToggleId, setRequestingRicsToggleId] = useState<string | null>(null)
  const [ricsToggleNotice, setRicsToggleNotice] = useState<string | null>(null)
  const [ricsToggleErr, setRicsToggleErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('bank_accounts')
      .select('*')
      .eq('property_id', propertyId)
      .order('account_name')
    setAccounts(data ?? [])
    setLoading(false)
  }, [propertyId])

  useEffect(() => { load() }, [load])

  async function handleDelete(account: BankAccount) {
    setDeleteErr(null)

    // Defence in depth: the Delete button is disabled for non-finance roles, but
    // we re-check here in case the disabled state is bypassed (DevTools, scripts,
    // future code paths). Server-side enforcement is deferred to the financial-rules
    // Edge Function — see DECISIONS 2026-05-09.
    if (!canManageClosure) {
      setDeleteErr(FINANCE_ROLE_TOOLTIP)
      setDeletingId(null)
      return
    }

    // RICS Client Money Rule 4.7 + TPI §5: a reconciled or closed account must
    // never be hard-deleted. The PM-facing path is Mark as Closed (is_active=false).
    if (account.last_reconciled_at) {
      setDeleteErr(
        'Cannot delete — this account has been reconciled. Per RICS Client Money ' +
        'Rule 4.7 and TPI Code §5, the audit trail must be preserved. Edit the ' +
        'account and untick "Active" to mark it as closed instead.'
      )
      return
    }
    if (account.closed_date) {
      setDeleteErr(
        'Cannot delete — this account has been closed and the closure date is on record. ' +
        'Closed-account history must be retained for audit (RICS Client Money Rule 4.7).'
      )
      return
    }

    const { error } = await supabase.from('bank_accounts').delete().eq('id', account.id)
    if (error) {
      // 23503: foreign key violation (transactions / payment_authorisations / etc.)
      setDeleteErr(
        error.code === '23503'
          ? 'Cannot delete — this account has linked transactions or payment ' +
            'authorisations. Per RICS Client Money rules and TPI requirements, ' +
            'financial audit history cannot be deleted. Edit the account and ' +
            'untick "Active" to mark it as closed instead.'
          : error.message
      )
      return
    }
    setDeletingId(null)
    load()
  }

  /**
   * Insert a payment_authorisations row with action_type='close_bank_account'
   * to request that an admin / director authorise closing this account. The
   * PM does not toggle is_active themselves — that happens on authorise via
   * PaymentAuthorisationsTab. See DECISIONS 2026-05-10 — closure dual-auth.
   */
  async function handleRequestClosure(account: BankAccount) {
    setClosureErr(null)
    if (!userId) { setClosureErr('User session missing.'); return }
    const { error } = await supabase.from('payment_authorisations').insert({
      firm_id: firmId,
      requested_by: userId,
      status: 'pending',
      action_type: 'close_bank_account',
      proposed: {
        bank_account_id: account.id,
        closed_date: todayISODate(),
      },
    })
    if (error) { setClosureErr(error.message); return }
    setRequestingClosureId(null)
    setClosureNotice(
      `Closure request created for "${account.account_name}". An admin or ` +
      'director must authorise it under Payment authorisations before the ' +
      'account is marked closed.'
    )
  }

  /**
   * Insert a payment_authorisations row with action_type='toggle_rics_designation'
   * to request that an admin / director authorise removing the RICS-designated
   * client-account flag. Direction-gated: only true→false flows through this
   * path (the protective false→true direction is a direct edit). On authorise
   * the application updates bank_accounts.rics_designated. RICS Client Money
   * Rule 4.7 — segregation of duties on a high-stakes designation change.
   * See DECISIONS 2026-05-10 1g.5.
   */
  async function handleRequestRicsToggle(account: BankAccount) {
    setRicsToggleErr(null)
    if (!userId) { setRicsToggleErr('User session missing.'); return }
    const { error } = await supabase.from('payment_authorisations').insert({
      firm_id: firmId,
      requested_by: userId,
      status: 'pending',
      action_type: 'toggle_rics_designation',
      proposed: {
        bank_account_id: account.id,
        new_value: false,
      },
    })
    if (error) { setRicsToggleErr(error.message); return }
    setRequestingRicsToggleId(null)
    setRicsToggleNotice(
      `RICS-designation removal request created for "${account.account_name}". ` +
      'An admin or director must authorise it under Payment authorisations ' +
      'before the designation is removed (RICS Client Money Rule 4.7).'
    )
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading bank accounts…</div>
  }

  return (
    <section aria-label="Bank accounts">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">Bank accounts ({accounts.length})</h2>
        <Button size="sm" onClick={() => { setEditing(null); setShowForm(true) }}>
          <Plus className="h-4 w-4 mr-1" /> Add bank account
        </Button>
      </div>

      {showForm && (
        <BankAccountForm
          firmId={firmId}
          propertyId={propertyId}
          initial={editing}
          canManageClosure={canManageClosure}
          onSaved={() => { setShowForm(false); setEditing(null); load() }}
          onCancel={() => { setShowForm(false); setEditing(null) }}
        />
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

      {closureErr && (
        <div className="mb-3 flex items-start gap-2 text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{closureErr}</span>
          <button onClick={() => setClosureErr(null)} aria-label="Dismiss error">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {closureNotice && (
        <div className="mb-3 flex items-start gap-2 text-sm border border-amber-300 bg-amber-50 text-amber-900 rounded-md px-3 py-2">
          <Send className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1" data-testid="closure-request-notice">{closureNotice}</span>
          <button onClick={() => setClosureNotice(null)} aria-label="Dismiss notice">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {ricsToggleErr && (
        <div className="mb-3 flex items-start gap-2 text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{ricsToggleErr}</span>
          <button onClick={() => setRicsToggleErr(null)} aria-label="Dismiss error">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {ricsToggleNotice && (
        <div className="mb-3 flex items-start gap-2 text-sm border border-amber-300 bg-amber-50 text-amber-900 rounded-md px-3 py-2">
          <ShieldOff className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1" data-testid="rics-toggle-request-notice">{ricsToggleNotice}</span>
          <button onClick={() => setRicsToggleNotice(null)} aria-label="Dismiss notice">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Name</th>
              <th className="text-left px-4 py-2 font-medium">Type</th>
              <th className="text-left px-4 py-2 font-medium">Bank</th>
              <th className="text-left px-4 py-2 font-medium">Sort / Account</th>
              <th className="text-left px-4 py-2 font-medium">Balance</th>
              <th className="text-left px-4 py-2 font-medium">Dual auth</th>
              <th className="text-left px-4 py-2 font-medium">RICS</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                  No bank accounts added yet.
                </td>
              </tr>
            ) : (
              accounts.map(a => (
                <BankAccountRow
                  key={a.id}
                  account={a}
                  canManageClosure={canManageClosure}
                  isDeleting={deletingId === a.id}
                  isRequestingClosure={requestingClosureId === a.id}
                  isRequestingRicsToggle={requestingRicsToggleId === a.id}
                  onEdit={() => { setEditing(a); setShowForm(true); setDeleteErr(null) }}
                  onAskDelete={() => { setDeletingId(a.id); setDeleteErr(null) }}
                  onConfirmDelete={() => handleDelete(a)}
                  onCancelDelete={() => setDeletingId(null)}
                  onAskRequestClosure={() => {
                    setRequestingClosureId(a.id); setClosureErr(null); setClosureNotice(null)
                  }}
                  onConfirmRequestClosure={() => handleRequestClosure(a)}
                  onCancelRequestClosure={() => setRequestingClosureId(null)}
                  onAskRequestRicsToggle={() => {
                    setRequestingRicsToggleId(a.id); setRicsToggleErr(null); setRicsToggleNotice(null)
                  }}
                  onConfirmRequestRicsToggle={() => handleRequestRicsToggle(a)}
                  onCancelRequestRicsToggle={() => setRequestingRicsToggleId(null)}
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
function BankAccountRow({
  account, canManageClosure, isDeleting, isRequestingClosure, isRequestingRicsToggle,
  onEdit, onAskDelete, onConfirmDelete, onCancelDelete,
  onAskRequestClosure, onConfirmRequestClosure, onCancelRequestClosure,
  onAskRequestRicsToggle, onConfirmRequestRicsToggle, onCancelRequestRicsToggle,
}: {
  account: BankAccount
  canManageClosure: boolean
  isDeleting: boolean
  isRequestingClosure: boolean
  isRequestingRicsToggle: boolean
  onEdit: () => void
  onAskDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
  onAskRequestClosure: () => void
  onConfirmRequestClosure: () => void
  onCancelRequestClosure: () => void
  onAskRequestRicsToggle: () => void
  onConfirmRequestRicsToggle: () => void
  onCancelRequestRicsToggle: () => void
}) {
  const showRequestClosure = !canManageClosure && account.is_active
  // Direction-gated: only true→false is dual-auth-gated (DECISIONS 2026-05-10 1g.5).
  // false→true happens via the form (protective direction; no request needed).
  const showRequestRicsToggle = !canManageClosure && account.rics_designated
  const sortShown = account.sort_code_last4 ? `••${account.sort_code_last4}` : '—'
  const acctShown = account.account_number_last4 ? `••${account.account_number_last4}` : '—'
  return (
    <>
      <tr className={cn('border-t hover:bg-muted/30', !account.is_active && 'opacity-60')}>
        <td className="px-4 py-2 font-medium">{account.account_name}</td>
        <td className="px-4 py-2 capitalize">{account.account_type.replace(/_/g, ' ')}</td>
        <td className="px-4 py-2">{account.bank_name ?? '—'}</td>
        <td className="px-4 py-2 font-mono text-xs">{sortShown} / {acctShown}</td>
        <td className="px-4 py-2">{formatPounds(account.current_balance)}</td>
        <td className="px-4 py-2">
          {account.requires_dual_auth ? (
            <Badge variant="green">
              {account.dual_auth_threshold && Number(account.dual_auth_threshold) > 0
                ? `≥ ${formatPounds(account.dual_auth_threshold)}`
                : 'All'}
            </Badge>
          ) : (
            <Badge variant="secondary">Off</Badge>
          )}
        </td>
        <td className="px-4 py-2">
          <Badge variant={account.rics_designated ? 'green' : 'secondary'}>
            {account.rics_designated ? 'Designated' : 'No'}
          </Badge>
        </td>
        <td className="px-4 py-2">
          <Badge variant={account.is_active ? 'green' : 'secondary'}>
            {account.is_active ? 'Active' : `Closed${account.closed_date ? ' ' + formatDate(account.closed_date) : ''}`}
          </Badge>
        </td>
        <td className="px-4 py-2">
          <div className="flex gap-1 justify-end items-center">
            <Button
              variant="ghost" size="sm"
              onClick={onEdit}
              aria-label={`Edit ${account.account_name}`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            {showRequestClosure && (
              <Button
                variant="ghost" size="sm"
                className="text-amber-700 hover:text-amber-800"
                onClick={onAskRequestClosure}
                aria-label={`Request closure ${account.account_name}`}
                title="Request closure — an admin or director must authorise it"
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            )}
            {showRequestRicsToggle && (
              <Button
                variant="ghost" size="sm"
                className="text-amber-700 hover:text-amber-800"
                onClick={onAskRequestRicsToggle}
                aria-label={`Request designation removal ${account.account_name}`}
                title="Request RICS-designation removal — an admin or director must authorise it (RICS Client Money Rule 4.7)"
              >
                <ShieldOff className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              variant="ghost" size="sm"
              className="text-destructive hover:text-destructive"
              onClick={onAskDelete}
              aria-label={`Delete ${account.account_name}`}
              disabled={!canManageClosure}
              title={canManageClosure ? undefined : FINANCE_ROLE_TOOLTIP}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </td>
      </tr>
      {isRequestingClosure && (
        <tr className="border-t bg-amber-50">
          <td colSpan={9} className="px-4 py-3">
            <div className="flex items-center gap-3 text-sm flex-wrap">
              <Send className="h-4 w-4 text-amber-700 flex-shrink-0" />
              <span>
                Request closure of <strong>{account.account_name}</strong>?
                An admin or director (not you) must authorise it before the
                account is marked closed.
              </span>
              <Button size="sm" onClick={onConfirmRequestClosure}>
                Confirm request
              </Button>
              <Button size="sm" variant="outline" onClick={onCancelRequestClosure}>
                Cancel
              </Button>
            </div>
          </td>
        </tr>
      )}
      {isRequestingRicsToggle && (
        <tr className="border-t bg-amber-50">
          <td colSpan={9} className="px-4 py-3">
            <div className="flex items-center gap-3 text-sm flex-wrap">
              <ShieldOff className="h-4 w-4 text-amber-700 flex-shrink-0" />
              <span>
                Remove RICS-designated client-account flag on{' '}
                <strong>{account.account_name}</strong>? Per RICS Client Money
                Rule 4.7 this is segregated — an admin or director (not you)
                must authorise it.
              </span>
              <Button size="sm" onClick={onConfirmRequestRicsToggle}>
                Confirm request
              </Button>
              <Button size="sm" variant="outline" onClick={onCancelRequestRicsToggle}>
                Cancel
              </Button>
            </div>
          </td>
        </tr>
      )}
      {isDeleting && (
        <tr className="border-t bg-destructive/5">
          <td colSpan={9} className="px-4 py-3">
            <div className="flex items-center gap-3 text-sm flex-wrap">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
              <span>
                Delete <strong>{account.account_name}</strong>? Audit history
                cannot be recovered. If this account ever held client money, mark it
                as closed instead.
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
// BankAccountForm — create and edit
// ════════════════════════════════════════════════════════════════════════════
function BankAccountForm({
  firmId, propertyId, initial, canManageClosure, onSaved, onCancel,
}: {
  firmId: string
  propertyId: string
  initial: BankAccount | null
  canManageClosure: boolean
  onSaved: () => void
  onCancel: () => void
}) {
  // Canonical pence values for money fields. Convert pounds (DB) ↔ pence (UI) at the boundary.
  const [values, setValues] = useState({
    account_name:         initial?.account_name ?? '',
    account_type:         initial?.account_type ?? 'service_charge',
    bank_name:            initial?.bank_name ?? '',
    sort_code_last4:      initial?.sort_code_last4 ?? '',
    account_number_last4: initial?.account_number_last4 ?? '',
    is_active:            initial?.is_active ?? true,
    opened_date:          initial?.opened_date ?? '',
    closed_date:          initial?.closed_date ?? '',
    requires_dual_auth:   initial?.requires_dual_auth ?? true,
    dual_auth_threshold_p: initial?.dual_auth_threshold != null
      ? poundsToP(Number(initial.dual_auth_threshold))
      : 0,
    current_balance_p: initial?.current_balance != null
      ? poundsToP(Number(initial.current_balance))
      : 0,
    rics_designated:      initial?.rics_designated ?? false,
    notes:                initial?.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  function set<K extends keyof typeof values>(field: K, value: (typeof values)[K]) {
    setValues(v => ({ ...v, [field]: value }))
  }

  function validate(): string | null {
    if (!values.account_name.trim()) return 'Account name is required.'
    if (values.sort_code_last4 && !/^\d{4}$/.test(values.sort_code_last4)) {
      return 'Sort code last 4 must be exactly four digits.'
    }
    if (values.account_number_last4 && !/^\d{4}$/.test(values.account_number_last4)) {
      return 'Account number last 4 must be exactly four digits.'
    }
    if ((values.dual_auth_threshold_p ?? 0) < 0) {
      return 'Dual-auth threshold cannot be negative.'
    }
    return null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const v = validate()
    if (v) { setError(v); return }
    setSaving(true)

    // is_active false implies a closed_date — auto-stamp today if not supplied.
    const closed = !values.is_active
      ? (values.closed_date || todayISODate())
      : null

    const payload = {
      firm_id:              firmId,
      property_id:          propertyId,
      account_name:         values.account_name.trim(),
      account_type:         values.account_type,
      bank_name:            values.bank_name || null,
      sort_code_last4:      values.sort_code_last4 || null,
      account_number_last4: values.account_number_last4 || null,
      is_active:            values.is_active,
      opened_date:          values.opened_date || null,
      closed_date:          closed,
      requires_dual_auth:   values.requires_dual_auth,
      dual_auth_threshold:  pToPounds(values.dual_auth_threshold_p ?? 0),
      // current_balance is intentionally NOT in the payload — trigger-maintained.
      rics_designated:      values.rics_designated,
      notes:                values.notes || null,
    }

    let err: { message: string } | null = null
    if (initial) {
      ;({ error: err } = await supabase.from('bank_accounts').update(payload).eq('id', initial.id))
    } else {
      ;({ error: err } = await supabase.from('bank_accounts').insert(payload))
    }

    if (err) { setError(err.message); setSaving(false) }
    else onSaved()
  }

  return (
    <Card className="mb-4 max-w-3xl">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{initial ? 'Edit bank account' : 'New bank account'}</h3>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>

        {!canManageClosure && initial && (
          <div
            className="mb-4 flex items-start gap-2 text-sm border rounded-md px-3 py-2 bg-muted/40"
            role="note"
          >
            <Lock className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">{FINANCE_ROLE_TOOLTIP}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          {/* Identity */}
          <div className="space-y-1">
            <label htmlFor="ba-name" className="text-sm font-medium">Account name *</label>
            <Input
              id="ba-name"
              required
              placeholder="e.g. 12 Acacia Avenue Service Charge"
              value={values.account_name}
              onChange={e => set('account_name', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="ba-type" className="text-sm font-medium">Account type *</label>
            <select
              id="ba-type"
              required
              className={SELECT_CLASS}
              value={values.account_type}
              onChange={e => set('account_type', e.target.value)}
            >
              {ACCOUNT_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          <div className="col-span-2 space-y-1">
            <label htmlFor="ba-bank" className="text-sm font-medium">Bank name</label>
            <Input
              id="ba-bank"
              placeholder="e.g. Barclays, Lloyds, NatWest"
              value={values.bank_name}
              onChange={e => set('bank_name', e.target.value)}
            />
          </div>

          {/* Last-4 fields — never store full numbers */}
          <div className="space-y-1">
            <label htmlFor="ba-sort" className="text-sm font-medium">Sort code (last 4)</label>
            <Input
              id="ba-sort"
              placeholder="1234"
              inputMode="numeric"
              maxLength={4}
              pattern="\d{4}"
              value={values.sort_code_last4}
              onChange={e => set('sort_code_last4', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="ba-acct" className="text-sm font-medium">Account number (last 4)</label>
            <Input
              id="ba-acct"
              placeholder="5678"
              inputMode="numeric"
              maxLength={4}
              pattern="\d{4}"
              value={values.account_number_last4}
              onChange={e => set('account_number_last4', e.target.value)}
            />
          </div>

          {/* Dates */}
          <div className="space-y-1">
            <label htmlFor="ba-open" className="text-sm font-medium">Opened date</label>
            <Input
              id="ba-open"
              type="date"
              value={values.opened_date}
              onChange={e => set('opened_date', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="ba-close" className="text-sm font-medium">Closed date</label>
            <Input
              id="ba-close"
              type="date"
              disabled={values.is_active || !canManageClosure}
              title={!canManageClosure ? FINANCE_ROLE_TOOLTIP : undefined}
              value={values.closed_date}
              onChange={e => set('closed_date', e.target.value)}
            />
          </div>

          {/* Dual auth */}
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={values.requires_dual_auth}
                onChange={e => set('requires_dual_auth', e.target.checked)}
                className="h-4 w-4"
              />
              Requires dual authorisation
            </label>
          </div>
          <div className="space-y-1">
            <label htmlFor="ba-threshold" className="text-sm font-medium">
              Dual-auth threshold
            </label>
            <MoneyInput
              id="ba-threshold"
              disabled={!values.requires_dual_auth}
              value={values.dual_auth_threshold_p}
              onChange={p => set('dual_auth_threshold_p', p ?? 0)}
              placeholder="0.00"
            />
          </div>

          {/* Current balance — display only, edit mode only */}
          {initial && (
            <div className="space-y-1 col-span-2">
              <label htmlFor="ba-balance" className="text-sm font-medium flex items-center gap-1.5">
                Current balance
                <Lock className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
              </label>
              <MoneyInput
                id="ba-balance"
                disabled
                allowNegative
                value={values.current_balance_p}
                onChange={() => { /* read-only */ }}
                title={CURRENT_BALANCE_TOOLTIP}
                aria-describedby="ba-balance-help"
              />
              <p id="ba-balance-help" className="text-xs text-muted-foreground">
                {CURRENT_BALANCE_TOOLTIP}
              </p>
            </div>
          )}

          {/* Flags */}
          <div className="col-span-2 grid grid-cols-2 gap-2 pt-1">
            <label
              className={cn(
                'flex items-center gap-2 text-sm',
                canManageClosure ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
              )}
              title={!canManageClosure ? FINANCE_ROLE_TOOLTIP : undefined}
            >
              <input
                type="checkbox"
                checked={values.is_active}
                disabled={!canManageClosure}
                onChange={e => set('is_active', e.target.checked)}
                className="h-4 w-4"
              />
              Active
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={values.rics_designated}
                onChange={e => set('rics_designated', e.target.checked)}
                className="h-4 w-4"
              />
              RICS-designated client account
            </label>
          </div>

          {/* Notes */}
          <div className="col-span-2 space-y-1">
            <label htmlFor="ba-notes" className="text-sm font-medium">Notes</label>
            <Input
              id="ba-notes"
              value={values.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Any additional notes…"
            />
          </div>

          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <div className="col-span-2 flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : initial ? 'Update bank account' : 'Save bank account'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
