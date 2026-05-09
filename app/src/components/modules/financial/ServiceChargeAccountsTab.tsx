/**
 * @file ServiceChargeAccountsTab.tsx
 * @description Per-property service charge accounts list + create/edit/delete.
 * Rendered inside PropertyDetailPage's "Service charge accounts" tab.
 *
 * Responsible for: full CRUD on `service_charge_accounts` rows scoped to a single
 *                  property, including the draft → active → reconciling → finalised
 *                  status state machine and FK-safe deletion.
 * NOT responsible for: budget_line_items CRUD (separate tab in a later commit),
 *                      demands (later commit), reconciliation engine (Phase 3 finale).
 *
 * Status state machine (DECISIONS 2026-05-09 — SCA UX + delete policy):
 *   draft → active → reconciling → finalised. No reversion from `finalised`.
 *   On the moment of transition to `finalised`, the client stamps `finalised_at`
 *   and `finalised_by` (current user id). Server-side enforcement is deferred to
 *   the financial-rules Edge Function in a later commit; the client guard is
 *   sufficient for 1c because RLS already restricts writes to firm admins / PMs.
 *
 * Delete policy (mirrors bank-accounts, RICS Client Money + TPI audit retention):
 *   Hard-delete is permitted ONLY when status='draft' AND no FK references exist
 *   (budget_line_items / demands). Any other state forces the PM to keep the row.
 */
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import {
  Card, CardContent, Button, Badge, Input,
} from '@/components/ui'
import { MoneyInput } from '@/components/shared/MoneyInput'
import { Plus, Pencil, Trash2, X, AlertTriangle, Lock } from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import { poundsToP, pToPounds, formatPounds } from '@/lib/money'
import type { Database } from '@/types/database'

type ServiceChargeAccount = Database['public']['Tables']['service_charge_accounts']['Row']

const SELECT_CLASS = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60'

type SCAStatus = 'draft' | 'active' | 'reconciling' | 'finalised'

const STATUS_OPTIONS: Array<{ value: SCAStatus; label: string }> = [
  { value: 'draft',       label: 'Draft' },
  { value: 'active',      label: 'Active' },
  { value: 'reconciling', label: 'Reconciling' },
  { value: 'finalised',   label: 'Finalised' },
]

const STATUS_BADGE_VARIANT: Record<SCAStatus, 'secondary' | 'amber' | 'green'> = {
  draft:       'secondary',
  active:      'green',
  reconciling: 'amber',
  finalised:   'green',
}

const FINALISED_LOCK_TOOLTIP =
  'Finalised accounts cannot be reverted (DECISIONS 2026-05-09). Only the notes ' +
  'field is editable on a finalised account; year dates, budget total, and status ' +
  'are locked to preserve the closing record.'

export function ServiceChargeAccountsTab({
  firmId,
  propertyId,
}: {
  firmId: string
  propertyId: string
}) {
  const [accounts, setAccounts] = useState<ServiceChargeAccount[]>([])
  const [loading,  setLoading]  = useState(true)

  const [showForm,    setShowForm]    = useState(false)
  const [editing,     setEditing]     = useState<ServiceChargeAccount | null>(null)
  const [deletingId,  setDeletingId]  = useState<string | null>(null)
  const [deleteErr,   setDeleteErr]   = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('service_charge_accounts')
      .select('*')
      .eq('property_id', propertyId)
      .order('account_year_start', { ascending: false })
    setAccounts(data ?? [])
    setLoading(false)
  }, [propertyId])

  useEffect(() => { load() }, [load])

  async function handleDelete(account: ServiceChargeAccount) {
    setDeleteErr(null)

    // Audit-history retention: only `draft` accounts may be hard-deleted. Any later
    // status implies budget / charge / reconciliation activity that must be preserved.
    if (account.status !== 'draft') {
      setDeleteErr(
        `Cannot delete — status is "${account.status}". Per RICS Client Money ` +
        'Rule 4.7 and TPI Code §5, only draft accounts may be hard-deleted. ' +
        'Active / reconciling / finalised accounts must be retained for audit.'
      )
      return
    }

    const { error } = await supabase.from('service_charge_accounts').delete().eq('id', account.id)
    if (error) {
      // 23503: FK violation (budget_line_items / demands reference this account).
      setDeleteErr(
        error.code === '23503'
          ? 'Cannot delete — this account has linked budget line items or demands. ' +
            'Audit-history retention requirements (RICS Rule 4.7 / TPI §5) prevent ' +
            'removal. Remove the linked records first if they are also draft, or ' +
            'leave the account in place.'
          : error.message
      )
      return
    }
    setDeletingId(null)
    load()
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading service charge accounts…</div>
  }

  return (
    <section aria-label="Service charge accounts">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">Service charge accounts ({accounts.length})</h2>
        <Button size="sm" onClick={() => { setEditing(null); setShowForm(true) }}>
          <Plus className="h-4 w-4 mr-1" /> Add service charge account
        </Button>
      </div>

      {showForm && (
        <ServiceChargeAccountForm
          firmId={firmId}
          propertyId={propertyId}
          initial={editing}
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

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Year</th>
              <th className="text-left px-4 py-2 font-medium">Period</th>
              <th className="text-left px-4 py-2 font-medium">Budget total</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="text-left px-4 py-2 font-medium">Finalised</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No service charge accounts created yet.
                </td>
              </tr>
            ) : (
              accounts.map(a => (
                <ServiceChargeAccountRow
                  key={a.id}
                  account={a}
                  isDeleting={deletingId === a.id}
                  onEdit={() => { setEditing(a); setShowForm(true); setDeleteErr(null) }}
                  onAskDelete={() => { setDeletingId(a.id); setDeleteErr(null) }}
                  onConfirmDelete={() => handleDelete(a)}
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
function ServiceChargeAccountRow({
  account, isDeleting, onEdit, onAskDelete, onConfirmDelete, onCancelDelete,
}: {
  account: ServiceChargeAccount
  isDeleting: boolean
  onEdit: () => void
  onAskDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  const status = account.status as SCAStatus
  const yearLabel = formatYearLabel(account.account_year_start, account.account_year_end)
  const rowLabel = `${yearLabel} service charge account`
  return (
    <>
      <tr className={cn('border-t hover:bg-muted/30', status === 'finalised' && 'opacity-80')}>
        <td className="px-4 py-2 font-medium">{yearLabel}</td>
        <td className="px-4 py-2 text-muted-foreground">
          {formatDate(account.account_year_start)} → {formatDate(account.account_year_end)}
        </td>
        <td className="px-4 py-2">
          {account.budget_total != null ? formatPounds(account.budget_total) : '—'}
        </td>
        <td className="px-4 py-2">
          <Badge variant={STATUS_BADGE_VARIANT[status] ?? 'secondary'}>
            {capitalise(status)}
          </Badge>
        </td>
        <td className="px-4 py-2 text-xs text-muted-foreground">
          {account.finalised_at ? formatDate(account.finalised_at) : '—'}
        </td>
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
              aria-label={`Delete ${rowLabel}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </td>
      </tr>
      {isDeleting && (
        <tr className="border-t bg-destructive/5">
          <td colSpan={6} className="px-4 py-3">
            <div className="flex items-center gap-3 text-sm flex-wrap">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
              <span>
                Delete the <strong>{yearLabel}</strong> service charge account?
                Only draft accounts can be removed; once an account is active or
                later, it must be retained for audit.
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
// ServiceChargeAccountForm — create and edit
// ════════════════════════════════════════════════════════════════════════════
function ServiceChargeAccountForm({
  firmId, propertyId, initial, onSaved, onCancel,
}: {
  firmId: string
  propertyId: string
  initial: ServiceChargeAccount | null
  onSaved: () => void
  onCancel: () => void
}) {
  const userId = useAuthStore(s => s.user?.id ?? null)
  const initialStatus = (initial?.status as SCAStatus | undefined) ?? 'draft'
  const isLockedFinalised = initialStatus === 'finalised'

  const [values, setValues] = useState({
    account_year_start: initial?.account_year_start ?? '',
    account_year_end:   initial?.account_year_end ?? '',
    budget_total_p:     initial?.budget_total != null
                          ? poundsToP(Number(initial.budget_total))
                          : null as number | null,
    status:             initialStatus,
    notes:              initial?.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  function set<K extends keyof typeof values>(field: K, value: (typeof values)[K]) {
    setValues(v => ({ ...v, [field]: value }))
  }

  function validate(): string | null {
    if (!values.account_year_start) return 'Year start is required.'
    if (!values.account_year_end)   return 'Year end is required.'
    if (values.account_year_end <= values.account_year_start) {
      return 'Year end must be after year start.'
    }
    if ((values.budget_total_p ?? 0) < 0) {
      return 'Budget total cannot be negative.'
    }
    return null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const v = validate()
    if (v) { setError(v); return }
    setSaving(true)

    // Stamp finalised_at / finalised_by at the moment of transition to finalised.
    // If the account was already finalised, preserve the existing stamps.
    const transitioningToFinalised =
      values.status === 'finalised' && initial?.status !== 'finalised'

    const finalised_at = transitioningToFinalised
      ? new Date().toISOString()
      : (initial?.finalised_at ?? null)
    const finalised_by = transitioningToFinalised
      ? userId
      : (initial?.finalised_by ?? null)

    const payload = {
      firm_id:            firmId,
      property_id:        propertyId,
      account_year_start: values.account_year_start,
      account_year_end:   values.account_year_end,
      budget_total:       values.budget_total_p != null
                            ? pToPounds(values.budget_total_p)
                            : null,
      status:             values.status,
      finalised_at,
      finalised_by,
      notes:              values.notes || null,
    }

    let err: { message: string } | null = null
    if (initial) {
      ;({ error: err } = await supabase
          .from('service_charge_accounts').update(payload).eq('id', initial.id))
    } else {
      ;({ error: err } = await supabase.from('service_charge_accounts').insert(payload))
    }

    if (err) { setError(err.message); setSaving(false) }
    else onSaved()
  }

  return (
    <Card className="mb-4 max-w-3xl">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">
            {initial ? 'Edit service charge account' : 'New service charge account'}
          </h3>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>

        {isLockedFinalised && (
          <div
            className="mb-4 flex items-start gap-2 text-sm border rounded-md px-3 py-2 bg-muted/40"
            role="note"
          >
            <Lock className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">{FINALISED_LOCK_TOOLTIP}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label htmlFor="sca-year-start" className="text-sm font-medium">Year start *</label>
            <Input
              id="sca-year-start"
              type="date"
              required
              disabled={isLockedFinalised}
              value={values.account_year_start}
              onChange={e => set('account_year_start', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="sca-year-end" className="text-sm font-medium">Year end *</label>
            <Input
              id="sca-year-end"
              type="date"
              required
              disabled={isLockedFinalised}
              value={values.account_year_end}
              onChange={e => set('account_year_end', e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="sca-budget" className="text-sm font-medium">Budget total</label>
            <MoneyInput
              id="sca-budget"
              disabled={isLockedFinalised}
              value={values.budget_total_p}
              onChange={p => set('budget_total_p', p)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="sca-status" className="text-sm font-medium">Status</label>
            <select
              id="sca-status"
              className={SELECT_CLASS}
              disabled={isLockedFinalised}
              title={isLockedFinalised ? FINALISED_LOCK_TOOLTIP : undefined}
              value={values.status}
              onChange={e => set('status', e.target.value as SCAStatus)}
            >
              {STATUS_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Finalised metadata — display only when present */}
          {initial?.finalised_at && (
            <div className="col-span-2 text-xs text-muted-foreground">
              Finalised {formatDate(initial.finalised_at)}
              {initial.finalised_by ? ' by user ' + initial.finalised_by.slice(0, 8) : ''}
            </div>
          )}

          <div className="col-span-2 space-y-1">
            <label htmlFor="sca-notes" className="text-sm font-medium">Notes</label>
            <Input
              id="sca-notes"
              value={values.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Any additional notes…"
            />
          </div>

          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <div className="col-span-2 flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving
                ? 'Saving…'
                : initial
                  ? 'Update service charge account'
                  : 'Save service charge account'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────────
function formatYearLabel(start: string, end: string): string {
  const s = start ? start.slice(0, 4) : ''
  const e = end ? end.slice(0, 4) : ''
  return s && e && s !== e ? `${s}–${e}` : (s || e || '—')
}

function capitalise(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}
