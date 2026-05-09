/**
 * @file DemandsTab.tsx
 * @description Per-property demands list + create/edit/delete. Sixth tab on
 * PropertyDetailPage.
 *
 * Responsible for: full CRUD on `demands` rows scoped to a single property,
 *                  including LTA 1985 s.21B client-side guard, the demand
 *                  status state machine, the paid-account lock, and FK-safe
 *                  deletion gated by audit-history retention rules.
 * NOT responsible for: PDF generation (`document_id` stays null in 1d),
 *                      LTA s.20B 18-month banding warning (deferred),
 *                      bulk demand generation per accounting period (later
 *                      ledger commit), portal visibility toggle (Phase 5).
 *
 * Regulatory rules (DECISIONS 2026-05-09 — demands UX + delete policy):
 *   1. LTA 1985 s.21B: `s21b_attached` MUST be true before `issued_date` is
 *      set OR before status moves out of 'draft' to any non-'withdrawn' state.
 *      Server-side enforcement is in the financial-rules Edge Function
 *      (deferred); the form rejects the save with the s.21B message inline.
 *   2. Paid lock: a demand whose stored status is 'paid' opens with amount,
 *      dates, status, demand_type, and s21b_attached all disabled — only
 *      `notes` is editable. Mirrors the SCA finalised lock.
 *   3. Delete policy: hard-delete is permitted ONLY when status='draft' AND
 *      no `transactions` row references the demand (FK 23503 surfaces). The
 *      rejection message names RICS Rule 4.7 / TPI §5 / LTA s.20B audit chain.
 *   4. On transition draft → issued, the form auto-stamps `issued_date = today`
 *      if the PM has not supplied one. The PM may override before save.
 */
import { useEffect, useState, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import {
  Card, CardContent, Button, Badge, Input,
} from '@/components/ui'
import { MoneyInput } from '@/components/shared/MoneyInput'
import { Plus, Pencil, Trash2, X, AlertTriangle, Lock } from 'lucide-react'
import { cn, formatDate, formatYearLabel, slugToTitle, todayISODate } from '@/lib/utils'
import { poundsToP, pToPounds, formatPounds } from '@/lib/money'
import {
  DEMAND_TYPES, type DemandType,
  DEMAND_STATUSES, type DemandStatus,
} from '@/lib/constants'
import type { Database } from '@/types/database'

type Demand              = Database['public']['Tables']['demands']['Row']
type Unit                = Database['public']['Tables']['units']['Row']
type Leaseholder         = Database['public']['Tables']['leaseholders']['Row']
type ServiceChargeAccount = Database['public']['Tables']['service_charge_accounts']['Row']

const SELECT_CLASS = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60'

const STATUS_OPTIONS: Array<{ value: DemandStatus; label: string }> =
  DEMAND_STATUSES.map(value => ({ value, label: slugToTitle(value) }))

const DEMAND_TYPE_OPTIONS: Array<{ value: DemandType; label: string }> =
  DEMAND_TYPES.map(value => ({ value, label: slugToTitle(value) }))

const STATUS_BADGE_VARIANT: Record<DemandStatus, 'secondary' | 'amber' | 'green' | 'destructive'> = {
  draft:     'secondary',
  issued:    'amber',
  part_paid: 'amber',
  paid:      'green',
  overdue:   'destructive',
  disputed:  'destructive',
  withdrawn: 'secondary',
}

/** Statuses that require LTA s.21B compliance to reach (i.e. anything that
 *  presents the demand to the leaseholder as enforceable). Withdrawn from
 *  a draft is permitted without s21b_attached because no demand was issued. */
const STATUSES_REQUIRING_S21B: DemandStatus[] =
  ['issued', 'part_paid', 'paid', 'overdue', 'disputed']

const PAID_LOCK_TOOLTIP =
  'Paid demands cannot be edited (DECISIONS 2026-05-09). Only the notes field ' +
  'is editable on a paid demand; amount, dates, status, demand type, and the ' +
  's.21B flag are locked to preserve the closing record.'

const S21B_LABEL =
  'Section 21B summary attached (LTA 1985 s.21B — required before issuing)'

export function DemandsTab({
  firmId,
  propertyId,
}: {
  firmId: string
  propertyId: string
}) {
  const [demands,      setDemands]      = useState<Demand[]>([])
  const [units,        setUnits]        = useState<Unit[]>([])
  const [leaseholders, setLeaseholders] = useState<Leaseholder[]>([])
  const [accounts,     setAccounts]     = useState<ServiceChargeAccount[]>([])
  const [loading,      setLoading]      = useState(true)

  const [showForm,    setShowForm]    = useState(false)
  const [editing,     setEditing]     = useState<Demand | null>(null)
  const [deletingId,  setDeletingId]  = useState<string | null>(null)
  const [deleteErr,   setDeleteErr]   = useState<string | null>(null)

  const load = useCallback(async () => {
    const [demRes, unitsRes, lhRes, scaRes] = await Promise.all([
      supabase.from('demands').select('*')
        .eq('property_id', propertyId).order('created_at', { ascending: false }),
      supabase.from('units').select('*')
        .eq('property_id', propertyId).order('unit_ref'),
      supabase.from('leaseholders').select('*')
        .eq('property_id', propertyId).order('full_name'),
      supabase.from('service_charge_accounts').select('*')
        .eq('property_id', propertyId).order('account_year_start', { ascending: false }),
    ])
    setDemands(demRes.data ?? [])
    setUnits(unitsRes.data ?? [])
    setLeaseholders(lhRes.data ?? [])
    setAccounts(scaRes.data ?? [])
    setLoading(false)
  }, [propertyId])

  useEffect(() => { load() }, [load])

  async function handleDelete(demand: Demand) {
    setDeleteErr(null)

    // Audit-history retention: only `draft` demands may be hard-deleted. Any later
    // status implies issuance to the leaseholder, which is the audit-trail event
    // protected by RICS Rule 4.7, TPI §5, and the LTA s.20B 18-month chain.
    if (demand.status !== 'draft') {
      setDeleteErr(
        `Cannot delete — status is "${demand.status}". Per RICS Client Money ` +
        'Rule 4.7, TPI Code §5, and the LTA s.20B audit chain, only draft ' +
        'demands may be hard-deleted. Issued / part-paid / paid / overdue / ' +
        'disputed / withdrawn demands must be retained for audit.'
      )
      return
    }

    const { error } = await supabase.from('demands').delete().eq('id', demand.id)
    if (error) {
      // 23503: FK violation (transactions reference this demand).
      setDeleteErr(
        error.code === '23503'
          ? 'Cannot delete — this demand has linked transactions. Audit-history ' +
            'retention requirements (RICS Rule 4.7 / TPI §5 / LTA s.20B) prevent ' +
            'removal. Reassign the linked transactions first if appropriate.'
          : error.message
      )
      return
    }
    setDeletingId(null)
    load()
  }

  const unitMap        = useMemo(() => new Map(units.map(u => [u.id, u.unit_ref])), [units])
  const leaseholderMap = useMemo(() => new Map(leaseholders.map(lh => [lh.id, lh.full_name])), [leaseholders])

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading demands…</div>
  }

  return (
    <section aria-label="Demands">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">Demands ({demands.length})</h2>
        <Button
          size="sm"
          onClick={() => { setEditing(null); setShowForm(true) }}
          disabled={units.length === 0 || leaseholders.length === 0}
          title={
            units.length === 0
              ? 'Add a unit first.'
              : leaseholders.length === 0
                ? 'Add a leaseholder first.'
                : undefined
          }
        >
          <Plus className="h-4 w-4 mr-1" /> Add demand
        </Button>
      </div>

      {showForm && (
        <DemandForm
          firmId={firmId}
          propertyId={propertyId}
          units={units}
          leaseholders={leaseholders}
          accounts={accounts}
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
              <th className="text-left px-4 py-2 font-medium">Unit</th>
              <th className="text-left px-4 py-2 font-medium">Leaseholder</th>
              <th className="text-left px-4 py-2 font-medium">Type</th>
              <th className="text-left px-4 py-2 font-medium">Period</th>
              <th className="text-left px-4 py-2 font-medium">Amount</th>
              <th className="text-left px-4 py-2 font-medium">Issued</th>
              <th className="text-left px-4 py-2 font-medium">Due</th>
              <th className="text-left px-4 py-2 font-medium">s.21B</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {demands.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                  No demands raised yet.
                </td>
              </tr>
            ) : (
              demands.map(d => (
                <DemandRow
                  key={d.id}
                  demand={d}
                  unitRef={unitMap.get(d.unit_id) ?? '—'}
                  leaseholderName={leaseholderMap.get(d.leaseholder_id) ?? '—'}
                  isDeleting={deletingId === d.id}
                  onEdit={() => { setEditing(d); setShowForm(true); setDeleteErr(null) }}
                  onAskDelete={() => { setDeletingId(d.id); setDeleteErr(null) }}
                  onConfirmDelete={() => handleDelete(d)}
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
function DemandRow({
  demand, unitRef, leaseholderName, isDeleting,
  onEdit, onAskDelete, onConfirmDelete, onCancelDelete,
}: {
  demand: Demand
  unitRef: string
  leaseholderName: string
  isDeleting: boolean
  onEdit: () => void
  onAskDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  const status = demand.status as DemandStatus
  const period = demand.period_start && demand.period_end
    ? `${formatDate(demand.period_start)} → ${formatDate(demand.period_end)}`
    : '—'
  const rowLabel = `${unitRef} ${demand.demand_type} demand`
  return (
    <>
      <tr className={cn('border-t hover:bg-muted/30', status === 'paid' && 'opacity-80')}>
        <td className="px-4 py-2 font-medium">{unitRef}</td>
        <td className="px-4 py-2">{leaseholderName}</td>
        <td className="px-4 py-2">{slugToTitle(demand.demand_type)}</td>
        <td className="px-4 py-2 text-muted-foreground text-xs">{period}</td>
        <td className="px-4 py-2">{formatPounds(demand.amount)}</td>
        <td className="px-4 py-2 text-xs text-muted-foreground">
          {demand.issued_date ? formatDate(demand.issued_date) : '—'}
        </td>
        <td className="px-4 py-2 text-xs text-muted-foreground">
          {demand.due_date ? formatDate(demand.due_date) : '—'}
        </td>
        <td className="px-4 py-2">
          <Badge variant={demand.s21b_attached ? 'green' : 'secondary'}>
            {demand.s21b_attached ? 'Yes' : 'No'}
          </Badge>
        </td>
        <td className="px-4 py-2">
          <Badge variant={STATUS_BADGE_VARIANT[status]}>
            {slugToTitle(status)}
          </Badge>
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
          <td colSpan={10} className="px-4 py-3">
            <div className="flex items-center gap-3 text-sm flex-wrap">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
              <span>
                Delete the <strong>{unitRef}</strong> {slugToTitle(demand.demand_type)} demand?
                Only draft demands can be removed; once issued, the row must be retained for audit.
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
// DemandForm — create and edit
// ════════════════════════════════════════════════════════════════════════════
function DemandForm({
  firmId, propertyId, units, leaseholders, accounts, initial, onSaved, onCancel,
}: {
  firmId: string
  propertyId: string
  units: Unit[]
  leaseholders: Leaseholder[]
  accounts: ServiceChargeAccount[]
  initial: Demand | null
  onSaved: () => void
  onCancel: () => void
}) {
  const initialStatus = (initial?.status as DemandStatus | undefined) ?? 'draft'
  const isLockedPaid = initialStatus === 'paid'

  const [values, setValues] = useState({
    unit_id:        initial?.unit_id ?? '',
    leaseholder_id: initial?.leaseholder_id ?? '',
    account_id:     initial?.account_id ?? '',
    demand_type:    (initial?.demand_type as DemandType | undefined) ?? 'service_charge',
    period_start:   initial?.period_start ?? '',
    period_end:     initial?.period_end ?? '',
    amount_p:       initial?.amount != null
                      ? poundsToP(Number(initial.amount))
                      : null as number | null,
    draft_date:     initial?.draft_date ?? '',
    issued_date:    initial?.issued_date ?? '',
    due_date:       initial?.due_date ?? '',
    s21b_attached:  initial?.s21b_attached ?? false,
    status:         initialStatus,
    notes:          initial?.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  function set<K extends keyof typeof values>(field: K, value: (typeof values)[K]) {
    setValues(v => ({ ...v, [field]: value }))
  }

  // Filter leaseholders to those attached to the selected unit and currently active.
  // Keep historical leaseholders out of the picker so PMs cannot accidentally raise
  // a demand against an ended tenant.
  const leaseholderOptions = useMemo(() => {
    if (!values.unit_id) return [] as Leaseholder[]
    return leaseholders.filter(lh => lh.unit_id === values.unit_id && lh.is_current)
  }, [values.unit_id, leaseholders])

  // If the selected leaseholder no longer matches the chosen unit (e.g. unit was
  // changed after picking the leaseholder), clear it so the user picks again.
  useEffect(() => {
    if (!values.leaseholder_id) return
    if (!leaseholderOptions.some(lh => lh.id === values.leaseholder_id)) {
      setValues(v => ({ ...v, leaseholder_id: '' }))
    }
  }, [values.unit_id, leaseholderOptions, values.leaseholder_id])

  function validate(): string | null {
    if (!values.unit_id)        return 'Unit is required.'
    if (!values.leaseholder_id) return 'Leaseholder is required.'
    if (values.amount_p == null) return 'Amount is required.'
    if (values.amount_p <= 0)    return 'Amount must be greater than zero.'
    if (values.period_start && values.period_end &&
        values.period_end < values.period_start) {
      return 'Period end must be on or after period start.'
    }
    // LTA 1985 s.21B: s21b_attached must be true before a demand is enforceable.
    // Setting issued_date OR moving status out of {draft, withdrawn} both qualify.
    const issuingByDate   = !!values.issued_date
    const issuingByStatus = STATUSES_REQUIRING_S21B.includes(values.status)
    if ((issuingByDate || issuingByStatus) && !values.s21b_attached) {
      return (
        'Cannot issue this demand: LTA 1985 s.21B requires the Section 21B ' +
        'summary to be attached before a demand is presented to the leaseholder. ' +
        'Tick "Section 21B summary attached" or revert status to draft / withdrawn.'
      )
    }
    return null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const v = validate()
    if (v) { setError(v); return }
    setSaving(true)

    // Auto-stamp issued_date on the moment of transition draft → issued, if the
    // PM hasn't supplied one. Re-issuing an already-issued demand keeps the
    // existing date.
    const transitioningToIssued =
      values.status === 'issued' && initial?.status !== 'issued'
    const issued_date = values.issued_date
      || (transitioningToIssued ? todayISODate() : null)

    const payload = {
      firm_id:        firmId,
      property_id:    propertyId,
      unit_id:        values.unit_id,
      leaseholder_id: values.leaseholder_id,
      account_id:     values.account_id || null,
      demand_type:    values.demand_type,
      period_start:   values.period_start || null,
      period_end:     values.period_end || null,
      amount:         pToPounds(values.amount_p ?? 0),
      draft_date:     values.draft_date || null,
      issued_date,
      due_date:       values.due_date || null,
      s21b_attached:  values.s21b_attached,
      status:         values.status,
      notes:          values.notes || null,
    }

    let err: { message: string } | null = null
    if (initial) {
      ;({ error: err } = await supabase
          .from('demands').update(payload).eq('id', initial.id))
    } else {
      ;({ error: err } = await supabase.from('demands').insert(payload))
    }

    if (err) { setError(err.message); setSaving(false) }
    else onSaved()
  }

  return (
    <Card className="mb-4 max-w-3xl">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{initial ? 'Edit demand' : 'New demand'}</h3>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>

        {isLockedPaid && (
          <div
            className="mb-4 flex items-start gap-2 text-sm border rounded-md px-3 py-2 bg-muted/40"
            role="note"
          >
            <Lock className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">{PAID_LOCK_TOOLTIP}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          {/* Unit + leaseholder */}
          <div className="space-y-1">
            <label htmlFor="dem-unit" className="text-sm font-medium">Unit *</label>
            <select
              id="dem-unit"
              required
              disabled={isLockedPaid}
              className={SELECT_CLASS}
              value={values.unit_id}
              onChange={e => set('unit_id', e.target.value)}
            >
              <option value="">Select unit…</option>
              {units.map(u => (
                <option key={u.id} value={u.id}>{u.unit_ref}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="dem-leaseholder" className="text-sm font-medium">Leaseholder *</label>
            <select
              id="dem-leaseholder"
              required
              disabled={isLockedPaid || !values.unit_id}
              className={SELECT_CLASS}
              value={values.leaseholder_id}
              onChange={e => set('leaseholder_id', e.target.value)}
            >
              <option value="">
                {values.unit_id ? 'Select leaseholder…' : 'Select unit first'}
              </option>
              {leaseholderOptions.map(lh => (
                <option key={lh.id} value={lh.id}>
                  {lh.is_company && lh.company_name
                    ? `${lh.company_name} (${lh.full_name})`
                    : lh.full_name}
                </option>
              ))}
            </select>
          </div>

          {/* Demand type + account */}
          <div className="space-y-1">
            <label htmlFor="dem-type" className="text-sm font-medium">Demand type *</label>
            <select
              id="dem-type"
              required
              disabled={isLockedPaid}
              className={SELECT_CLASS}
              value={values.demand_type}
              onChange={e => set('demand_type', e.target.value as DemandType)}
            >
              {DEMAND_TYPE_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="dem-account" className="text-sm font-medium">Service charge account</label>
            <select
              id="dem-account"
              disabled={isLockedPaid}
              className={SELECT_CLASS}
              value={values.account_id}
              onChange={e => set('account_id', e.target.value)}
            >
              <option value="">Not linked</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>
                  {formatYearLabel(a.account_year_start, a.account_year_end)} ({a.status})
                </option>
              ))}
            </select>
          </div>

          {/* Period */}
          <div className="space-y-1">
            <label htmlFor="dem-period-start" className="text-sm font-medium">Period start</label>
            <Input
              id="dem-period-start"
              type="date"
              disabled={isLockedPaid}
              value={values.period_start}
              onChange={e => set('period_start', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="dem-period-end" className="text-sm font-medium">Period end</label>
            <Input
              id="dem-period-end"
              type="date"
              disabled={isLockedPaid}
              value={values.period_end}
              onChange={e => set('period_end', e.target.value)}
            />
          </div>

          {/* Amount */}
          <div className="space-y-1">
            <label htmlFor="dem-amount" className="text-sm font-medium">Amount *</label>
            <MoneyInput
              id="dem-amount"
              disabled={isLockedPaid}
              value={values.amount_p}
              onChange={p => set('amount_p', p)}
              placeholder="0.00"
            />
          </div>

          {/* Status */}
          <div className="space-y-1">
            <label htmlFor="dem-status" className="text-sm font-medium">Status</label>
            <select
              id="dem-status"
              disabled={isLockedPaid}
              title={isLockedPaid ? PAID_LOCK_TOOLTIP : undefined}
              className={SELECT_CLASS}
              value={values.status}
              onChange={e => set('status', e.target.value as DemandStatus)}
            >
              {STATUS_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Dates */}
          <div className="space-y-1">
            <label htmlFor="dem-draft-date" className="text-sm font-medium">Draft date</label>
            <Input
              id="dem-draft-date"
              type="date"
              disabled={isLockedPaid}
              value={values.draft_date}
              onChange={e => set('draft_date', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="dem-issued-date" className="text-sm font-medium">Issued date</label>
            <Input
              id="dem-issued-date"
              type="date"
              disabled={isLockedPaid}
              value={values.issued_date}
              onChange={e => set('issued_date', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="dem-due-date" className="text-sm font-medium">Due date</label>
            <Input
              id="dem-due-date"
              type="date"
              disabled={isLockedPaid}
              value={values.due_date}
              onChange={e => set('due_date', e.target.value)}
            />
          </div>

          {/* s.21B */}
          <div className="col-span-2 flex items-start gap-2 pt-1">
            <input
              id="dem-s21b"
              type="checkbox"
              disabled={isLockedPaid}
              checked={values.s21b_attached}
              onChange={e => set('s21b_attached', e.target.checked)}
              className="h-4 w-4 mt-0.5"
            />
            <label htmlFor="dem-s21b" className="text-sm cursor-pointer">
              {S21B_LABEL}
            </label>
          </div>

          {/* Notes */}
          <div className="col-span-2 space-y-1">
            <label htmlFor="dem-notes" className="text-sm font-medium">Notes</label>
            <Input
              id="dem-notes"
              value={values.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Any additional notes…"
            />
          </div>

          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <div className="col-span-2 flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : initial ? 'Update demand' : 'Save demand'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
