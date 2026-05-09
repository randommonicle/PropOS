/**
 * @file PropertyDetailPage.tsx
 * @description Property detail view — tabbed interface containing property metadata,
 * units CRUD, and leaseholders CRUD. Future tabs (bank accounts, compliance, etc.)
 * are added by extending TAB_VALUES and rendering an additional TabsContent block.
 * Responsible for: displaying property info; full create/read/update/delete for
 *                  units and leaseholders within the property; tab navigation.
 * NOT responsible for: financial data CRUD logic (delegated to BankAccountsTab and
 *                      future financial-module tab components), compliance items
 *                      (Compliance module), works orders (Works module), apportionment
 *                      schedules (Financial module).
 *
 * Tabs and URL sync:
 *   - Active tab is mirrored into the `?tab=` search param so refreshes and direct
 *     links (e.g. /properties/:id?tab=units) preserve the user's location.
 *   - Default tab is 'overview'. Unknown values fall back to the default.
 *
 * Edge cases handled:
 *   - FK constraint on unit delete (unit has leaseholders / demands / works orders) → inline error
 *   - FK constraint on leaseholder delete (leaseholder has demands) → inline error with
 *     suggestion to use "Mark as ended" instead
 *   - Leaseholder end: sets is_current=false + to_date=today; preserves record for audit trail
 *   - Company leaseholder: conditional company_name / company_reg fields
 *   - Historical leaseholders: hidden by default, shown via toggle
 *   - Ground rent review: basis + date only shown when ground_rent_pa is set
 */
import { useEffect, useState, useCallback } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageHeader } from '@/components/shared/PageHeader'
import {
  Card, CardContent, CardHeader, CardTitle, Button, Badge, Input,
  Tabs, TabsList, TabsTrigger, TabsContent,
} from '@/components/ui'
import { ChevronLeft, Plus, Pencil, Trash2, X, AlertTriangle } from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import { formatPounds } from '@/lib/money'
import { BankAccountsTab } from '@/components/modules/financial'
import type { Database } from '@/types/database'

type Property    = Database['public']['Tables']['properties']['Row']
type Unit        = Database['public']['Tables']['units']['Row']
type Leaseholder = Database['public']['Tables']['leaseholders']['Row']

// ── Constants ────────────────────────────────────────────────────────────────
const SELECT_CLASS = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm'

/** Tab identifiers — also used as the `?tab=` search-param values for deep linking. */
const TAB_VALUES = ['overview', 'units', 'leaseholders', 'bank-accounts'] as const
type TabValue = typeof TAB_VALUES[number]
const DEFAULT_TAB: TabValue = 'overview'

/** Ground rent review basis options per the schema */
const GROUND_RENT_REVIEW_OPTIONS = [
  { value: '',            label: 'Not specified' },
  { value: 'fixed',       label: 'Fixed' },
  { value: 'rpi',         label: 'RPI' },
  { value: 'doubling',    label: 'Doubling' },
  { value: 'review_only', label: 'Review only' },
]

// ════════════════════════════════════════════════════════════════════════════
// PropertyDetailPage — root
// ════════════════════════════════════════════════════════════════════════════
export function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>()
  const firmContext = useAuthStore(s => s.firmContext)

  // Tab state mirrored into `?tab=`. Unknown / missing values fall back to DEFAULT_TAB
  // so a hand-crafted bad URL still renders something sensible.
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab')
  const tab: TabValue = (TAB_VALUES as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as TabValue)
    : DEFAULT_TAB
  function handleTabChange(next: string) {
    const nextTab = (TAB_VALUES as readonly string[]).includes(next) ? next : DEFAULT_TAB
    setSearchParams(prev => {
      const params = new URLSearchParams(prev)
      if (nextTab === DEFAULT_TAB) params.delete('tab')
      else params.set('tab', nextTab)
      return params
    }, { replace: true })
  }

  const [property,    setProperty]    = useState<Property | null>(null)
  const [units,       setUnits]       = useState<Unit[]>([])
  const [leaseholders, setLeaseholders] = useState<Leaseholder[]>([])
  const [loading,     setLoading]     = useState(true)

  // Unit CRUD state
  const [showUnitForm,   setShowUnitForm]   = useState(false)
  const [editingUnit,    setEditingUnit]    = useState<Unit | null>(null)
  const [deletingUnitId, setDeletingUnitId] = useState<string | null>(null)
  const [unitDeleteErr,  setUnitDeleteErr]  = useState<string | null>(null)

  // Leaseholder CRUD state
  const [showLhForm,   setShowLhForm]   = useState(false)
  const [editingLh,    setEditingLh]    = useState<Leaseholder | null>(null)
  const [deletingLhId, setDeletingLhId] = useState<string | null>(null)
  const [lhDeleteErr,  setLhDeleteErr]  = useState<string | null>(null)
  const [showHistorical, setShowHistorical] = useState(false)

  const load = useCallback(async (propertyId: string) => {
    const [propRes, unitsRes, lhRes] = await Promise.all([
      supabase.from('properties').select('*').eq('id', propertyId).single(),
      supabase.from('units').select('*').eq('property_id', propertyId).order('unit_ref'),
      supabase.from('leaseholders').select('*').eq('property_id', propertyId).order('full_name'),
    ])
    setProperty(propRes.data)
    setUnits(unitsRes.data ?? [])
    setLeaseholders(lhRes.data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { if (id) load(id) }, [id, load])

  // ── Unit delete ────────────────────────────────────────────────────────────
  async function handleDeleteUnit(unitId: string) {
    setUnitDeleteErr(null)
    const { error } = await supabase.from('units').delete().eq('id', unitId)
    if (error) {
      // Postgres FK violation (23503): unit is referenced by leaseholders / demands / works orders
      setUnitDeleteErr(
        error.code === '23503'
          ? 'Cannot delete — this unit has associated leaseholders, demands, or works orders. Remove those records first, or this unit cannot be deleted.'
          : error.message
      )
      return
    }
    setDeletingUnitId(null)
    if (id) load(id)
  }

  // ── Leaseholder delete ────────────────────────────────────────────────────
  async function handleDeleteLeaseholder(lhId: string) {
    setLhDeleteErr(null)
    const { error } = await supabase.from('leaseholders').delete().eq('id', lhId)
    if (error) {
      setLhDeleteErr(
        error.code === '23503'
          ? 'Cannot delete — this leaseholder has associated demands or records. Use "Mark as ended" to preserve the audit trail.'
          : error.message
      )
      return
    }
    setDeletingLhId(null)
    if (id) load(id)
  }

  // ── Leaseholder end (preserves record, sets is_current=false) ─────────────
  async function handleEndLeaseholder(lh: Leaseholder) {
    await supabase.from('leaseholders').update({
      is_current: false,
      to_date: new Date().toISOString().split('T')[0],
    }).eq('id', lh.id)
    if (id) load(id)
  }

  if (loading) return <div className="p-8 text-muted-foreground text-sm">Loading…</div>
  if (!property) return <div className="p-8 text-muted-foreground text-sm">Property not found.</div>

  const visibleLeaseholders = showHistorical
    ? leaseholders
    : leaseholders.filter(lh => lh.is_current)

  const unitMap = new Map(units.map(u => [u.id, u.unit_ref]))

  return (
    <div>
      <PageHeader
        title={property.name}
        description={`${property.address_line1}, ${property.town}, ${property.postcode}`}
      >
        <Link to="/properties">
          <Button variant="outline" size="sm">
            <ChevronLeft className="h-4 w-4 mr-1" /> Properties
          </Button>
        </Link>
      </PageHeader>

      <div className="p-8">
        <Tabs value={tab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="units">Units</TabsTrigger>
            <TabsTrigger value="leaseholders">Leaseholders</TabsTrigger>
            <TabsTrigger value="bank-accounts">Bank accounts</TabsTrigger>
          </TabsList>

          {/* ── Overview tab ─────────────────────────────────────────────── */}
          <TabsContent value="overview" className="space-y-8">
            <Card>
              <CardHeader><CardTitle className="text-base">Property details</CardTitle></CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                  <Field label="Type"          value={property.property_type} />
                  <Field label="Total units"   value={property.total_units?.toString() ?? '—'} />
                  <Field label="Build year"    value={property.build_year?.toString() ?? '—'} />
                  <Field label="Listed status" value={property.listed_status ?? '—'} />
                  <Field label="Freeholder"    value={property.freeholder_name ?? '—'} />
                  <Field label="Managing since" value={formatDate(property.managing_since)} />
                  <Field label="HRB"           value={property.is_hrb ? 'Yes — BSA applies' : 'No'} />
                  {property.is_hrb && <Field label="Storeys"    value={property.storey_count?.toString() ?? '—'} />}
                  {property.is_hrb && <Field label="Height (m)" value={property.height_metres?.toString() ?? '—'} />}
                </dl>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Units tab ────────────────────────────────────────────────── */}
          <TabsContent value="units" className="space-y-8">
            <section aria-label="Units">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Units ({units.length})</h2>
            <Button size="sm" onClick={() => { setEditingUnit(null); setShowUnitForm(true) }}>
              <Plus className="h-4 w-4 mr-1" /> Add unit
            </Button>
          </div>

          {showUnitForm && (
            <UnitForm
              firmId={firmContext!.firmId}
              propertyId={property.id}
              initial={editingUnit}
              onSaved={() => { setShowUnitForm(false); setEditingUnit(null); if (id) load(id) }}
              onCancel={() => { setShowUnitForm(false); setEditingUnit(null) }}
            />
          )}

          {unitDeleteErr && (
            <InlineError message={unitDeleteErr} onDismiss={() => setUnitDeleteErr(null)} />
          )}

          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Unit ref</th>
                  <th className="text-left px-4 py-2 font-medium">Type</th>
                  <th className="text-left px-4 py-2 font-medium">Floor</th>
                  <th className="text-left px-4 py-2 font-medium">Ground rent</th>
                  <th className="text-left px-4 py-2 font-medium">Lease end</th>
                  <th className="text-left px-4 py-2 font-medium">SoF</th>
                  <th className="text-left px-4 py-2 font-medium">Let</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {units.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                      No units added yet.
                    </td>
                  </tr>
                ) : (
                  units.map(unit => (
                    <>
                      <tr key={unit.id} className="border-t hover:bg-muted/30">
                        <td className="px-4 py-2 font-medium">{unit.unit_ref}</td>
                        <td className="px-4 py-2 capitalize">{unit.unit_type}</td>
                        <td className="px-4 py-2">{unit.floor ?? '—'}</td>
                        <td className="px-4 py-2">
                          {unit.ground_rent_pa ? formatPounds(unit.ground_rent_pa) + '/yr' : '—'}
                        </td>
                        <td className="px-4 py-2">{formatDate(unit.lease_end)}</td>
                        <td className="px-4 py-2">
                          <Badge variant={unit.is_share_of_freehold ? 'green' : 'secondary'}>
                            {unit.is_share_of_freehold ? 'Yes' : 'No'}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={unit.is_currently_let ? 'amber' : 'secondary'}>
                            {unit.is_currently_let ? 'Let' : 'Owner-occ'}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex gap-1 justify-end">
                            <Button
                              variant="ghost" size="sm"
                              onClick={() => {
                                setEditingUnit(unit)
                                setShowUnitForm(true)
                                setUnitDeleteErr(null)
                              }}
                              aria-label={`Edit ${unit.unit_ref}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost" size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => { setDeletingUnitId(unit.id); setUnitDeleteErr(null) }}
                              aria-label={`Delete ${unit.unit_ref}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>

                      {/* Inline delete confirmation */}
                      {deletingUnitId === unit.id && (
                        <tr key={`${unit.id}-confirm`} className="border-t bg-destructive/5">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="flex items-center gap-3 text-sm flex-wrap">
                              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
                              <span>
                                Delete <strong>{unit.unit_ref}</strong>? This cannot be undone.
                              </span>
                              <Button
                                size="sm" variant="destructive"
                                onClick={() => handleDeleteUnit(unit.id)}
                              >
                                Confirm delete
                              </Button>
                              <Button
                                size="sm" variant="outline"
                                onClick={() => setDeletingUnitId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))
                )}
              </tbody>
            </table>
          </div>
            </section>
          </TabsContent>

          {/* ── Leaseholders tab ─────────────────────────────────────────── */}
          <TabsContent value="leaseholders" className="space-y-8">
            <section aria-label="Leaseholders">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold">
                Leaseholders ({visibleLeaseholders.length}
                {!showHistorical && leaseholders.length !== visibleLeaseholders.length
                  ? ` of ${leaseholders.length}`
                  : ''})
              </h2>
              {leaseholders.some(lh => !lh.is_current) && (
                <button
                  className="text-xs text-muted-foreground underline underline-offset-2"
                  onClick={() => setShowHistorical(h => !h)}
                >
                  {showHistorical ? 'Hide historical' : 'Show historical'}
                </button>
              )}
            </div>
            <Button size="sm" onClick={() => { setEditingLh(null); setShowLhForm(true) }}>
              <Plus className="h-4 w-4 mr-1" /> Add leaseholder
            </Button>
          </div>

          {showLhForm && (
            <LeaseholderForm
              firmId={firmContext!.firmId}
              propertyId={property.id}
              units={units}
              initial={editingLh}
              onSaved={() => { setShowLhForm(false); setEditingLh(null); if (id) load(id) }}
              onCancel={() => { setShowLhForm(false); setEditingLh(null) }}
            />
          )}

          {lhDeleteErr && (
            <InlineError message={lhDeleteErr} onDismiss={() => setLhDeleteErr(null)} />
          )}

          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Name</th>
                  <th className="text-left px-4 py-2 font-medium">Unit</th>
                  <th className="text-left px-4 py-2 font-medium">Email</th>
                  <th className="text-left px-4 py-2 font-medium">Phone</th>
                  <th className="text-left px-4 py-2 font-medium">Resident</th>
                  <th className="text-left px-4 py-2 font-medium">Portal</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {visibleLeaseholders.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                      {showHistorical
                        ? 'No leaseholders recorded.'
                        : 'No current leaseholders recorded.'}
                    </td>
                  </tr>
                ) : (
                  visibleLeaseholders.map(lh => (
                    <>
                      <tr
                        key={lh.id}
                        className={cn(
                          'border-t hover:bg-muted/30',
                          !lh.is_current && 'opacity-60'
                        )}
                      >
                        <td className="px-4 py-2">
                          <span className="font-medium">
                            {lh.is_company ? lh.company_name : lh.full_name}
                          </span>
                          {lh.is_company && (
                            <span className="block text-xs text-muted-foreground">
                              {lh.full_name}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2">{unitMap.get(lh.unit_id) ?? '—'}</td>
                        <td className="px-4 py-2">{lh.email ?? '—'}</td>
                        <td className="px-4 py-2">{lh.phone ?? '—'}</td>
                        <td className="px-4 py-2">
                          <Badge variant={lh.is_resident ? 'green' : 'secondary'}>
                            {lh.is_resident ? 'Yes' : 'No'}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={lh.portal_access ? 'green' : 'secondary'}>
                            {lh.portal_access ? 'Active' : 'None'}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <Badge variant={lh.is_current ? 'green' : 'secondary'}>
                            {lh.is_current ? 'Current' : `Ended${lh.to_date ? ' ' + formatDate(lh.to_date) : ''}`}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex gap-1 justify-end">
                            <Button
                              variant="ghost" size="sm"
                              onClick={() => {
                                setEditingLh(lh)
                                setShowLhForm(true)
                                setLhDeleteErr(null)
                              }}
                              aria-label={`Edit ${lh.full_name}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            {lh.is_current && (
                              <Button
                                variant="ghost" size="sm"
                                className="text-amber-600 hover:text-amber-700"
                                title="Mark as ended — preserves audit trail"
                                onClick={() => handleEndLeaseholder(lh)}
                                aria-label={`End ${lh.full_name}`}
                              >
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            <Button
                              variant="ghost" size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => { setDeletingLhId(lh.id); setLhDeleteErr(null) }}
                              aria-label={`Delete ${lh.full_name}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>

                      {/* Inline delete confirmation */}
                      {deletingLhId === lh.id && (
                        <tr key={`${lh.id}-confirm`} className="border-t bg-destructive/5">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="flex items-center gap-3 text-sm flex-wrap">
                              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
                              <span>
                                Permanently delete <strong>{lh.full_name}</strong>?
                                Use "Mark as ended" to preserve the audit trail.
                              </span>
                              <Button
                                size="sm" variant="destructive"
                                onClick={() => handleDeleteLeaseholder(lh.id)}
                              >
                                Confirm delete
                              </Button>
                              <Button
                                size="sm" variant="outline"
                                onClick={() => setDeletingLhId(null)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))
                )}
              </tbody>
            </table>
          </div>
            </section>
          </TabsContent>

          {/* ── Bank accounts tab ────────────────────────────────────────── */}
          <TabsContent value="bank-accounts" className="space-y-8">
            <BankAccountsTab firmId={firmContext!.firmId} propertyId={property.id} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground mb-0.5">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}

function InlineError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="mb-3 flex items-start gap-2 text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
      <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
      <span className="flex-1">{message}</span>
      <button onClick={onDismiss} aria-label="Dismiss error">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// UnitForm — create and edit
// All schema fields are exposed. FK constraints are surfaced via InlineError.
// ════════════════════════════════════════════════════════════════════════════
function UnitForm({ firmId, propertyId, initial, onSaved, onCancel }: {
  firmId: string
  propertyId: string
  initial: Unit | null
  onSaved: () => void
  onCancel: () => void
}) {
  const [values, setValues] = useState({
    unit_ref:                 initial?.unit_ref ?? '',
    unit_type:                initial?.unit_type ?? 'flat',
    floor:                    initial?.floor != null ? String(initial.floor) : '',
    lease_start:              initial?.lease_start ?? '',
    lease_end:                initial?.lease_end ?? '',
    lease_term_years:         initial?.lease_term_years != null ? String(initial.lease_term_years) : '',
    ground_rent_pa:           initial?.ground_rent_pa != null ? String(initial.ground_rent_pa) : '',
    ground_rent_review_date:  initial?.ground_rent_review_date ?? '',
    ground_rent_review_basis: initial?.ground_rent_review_basis ?? '',
    is_share_of_freehold:     initial?.is_share_of_freehold ?? false,
    is_currently_let:         initial?.is_currently_let ?? false,
    notes:                    initial?.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  function set(field: string, value: string | boolean) {
    setValues(v => ({ ...v, [field]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const payload = {
      firm_id:                  firmId,
      property_id:              propertyId,
      unit_ref:                 values.unit_ref,
      unit_type:                values.unit_type,
      floor:                    values.floor ? parseInt(values.floor, 10) : null,
      lease_start:              values.lease_start || null,
      lease_end:                values.lease_end || null,
      lease_term_years:         values.lease_term_years ? parseInt(values.lease_term_years, 10) : null,
      ground_rent_pa:           values.ground_rent_pa ? parseFloat(values.ground_rent_pa) : null,
      ground_rent_review_date:  values.ground_rent_review_date || null,
      ground_rent_review_basis: values.ground_rent_review_basis || null,
      is_share_of_freehold:     values.is_share_of_freehold,
      is_currently_let:         values.is_currently_let,
      notes:                    values.notes || null,
    }

    let err: { message: string } | null = null
    if (initial) {
      ;({ error: err } = await supabase.from('units').update(payload).eq('id', initial.id))
    } else {
      ;({ error: err } = await supabase.from('units').insert(payload))
    }

    if (err) { setError(err.message); setSaving(false) }
    else onSaved()
  }

  return (
    <Card className="mb-4 max-w-3xl">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{initial ? 'Edit unit' : 'New unit'}</h3>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>

        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          {/* Identity */}
          <div className="space-y-1">
            <label htmlFor="unit-ref" className="text-sm font-medium">Unit ref *</label>
            <Input
              id="unit-ref"
              required
              placeholder="Flat 4"
              value={values.unit_ref}
              onChange={e => set('unit_ref', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="unit-type" className="text-sm font-medium">Unit type</label>
            <select
              id="unit-type"
              className={SELECT_CLASS}
              value={values.unit_type}
              onChange={e => set('unit_type', e.target.value)}
            >
              <option value="flat">Flat</option>
              <option value="house">House</option>
              <option value="commercial">Commercial</option>
              <option value="parking">Parking</option>
              <option value="storage">Storage</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="unit-floor" className="text-sm font-medium">Floor</label>
            <Input
              id="unit-floor"
              type="number"
              placeholder="0"
              value={values.floor}
              onChange={e => set('floor', e.target.value)}
            />
          </div>
          {/* Lease */}
          <div className="space-y-1">
            <label htmlFor="unit-term" className="text-sm font-medium">Lease term (years)</label>
            <Input
              id="unit-term"
              type="number"
              min="0"
              placeholder="125"
              value={values.lease_term_years}
              onChange={e => set('lease_term_years', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="unit-lease-start" className="text-sm font-medium">Lease start</label>
            <Input
              id="unit-lease-start"
              type="date"
              value={values.lease_start}
              onChange={e => set('lease_start', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="unit-lease-end" className="text-sm font-medium">Lease end</label>
            <Input
              id="unit-lease-end"
              type="date"
              value={values.lease_end}
              onChange={e => set('lease_end', e.target.value)}
            />
          </div>
          {/* Ground rent */}
          <div className="space-y-1">
            <label htmlFor="unit-gr-pa" className="text-sm font-medium">Ground rent (£/yr)</label>
            <Input
              id="unit-gr-pa"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={values.ground_rent_pa}
              onChange={e => set('ground_rent_pa', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="unit-gr-basis" className="text-sm font-medium">Ground rent review basis</label>
            <select
              id="unit-gr-basis"
              className={SELECT_CLASS}
              value={values.ground_rent_review_basis}
              onChange={e => set('ground_rent_review_basis', e.target.value)}
            >
              {GROUND_RENT_REVIEW_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="unit-gr-date" className="text-sm font-medium">Ground rent review date</label>
            <Input
              id="unit-gr-date"
              type="date"
              value={values.ground_rent_review_date}
              onChange={e => set('ground_rent_review_date', e.target.value)}
            />
          </div>
          {/* Flags */}
          <div className="flex flex-col gap-3 pt-1">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={values.is_share_of_freehold}
                onChange={e => set('is_share_of_freehold', e.target.checked)}
                className="h-4 w-4"
              />
              Share of freehold
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={values.is_currently_let}
                onChange={e => set('is_currently_let', e.target.checked)}
                className="h-4 w-4"
              />
              Currently let (sub-let by leaseholder)
            </label>
          </div>
          {/* Notes */}
          <div className="col-span-2 space-y-1">
            <label htmlFor="unit-notes" className="text-sm font-medium">Notes</label>
            <Input
              id="unit-notes"
              value={values.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Any additional notes…"
            />
          </div>

          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <div className="col-span-2 flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : initial ? 'Update unit' : 'Save unit'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// LeaseholderForm — create and edit
// Handles individual and company leaseholders. Historical tracking built in.
// ════════════════════════════════════════════════════════════════════════════
function LeaseholderForm({ firmId, propertyId, units, initial, onSaved, onCancel }: {
  firmId: string
  propertyId: string
  units: Unit[]
  initial: Leaseholder | null
  onSaved: () => void
  onCancel: () => void
}) {
  const [values, setValues] = useState({
    unit_id:                  initial?.unit_id ?? '',
    full_name:                initial?.full_name ?? '',
    email:                    initial?.email ?? '',
    phone:                    initial?.phone ?? '',
    correspondence_address:   initial?.correspondence_address ?? '',
    is_resident:              initial?.is_resident ?? true,
    is_company:               initial?.is_company ?? false,
    company_name:             initial?.company_name ?? '',
    company_reg:              initial?.company_reg ?? '',
    portal_access:            initial?.portal_access ?? false,
    is_current:               initial?.is_current ?? true,
    from_date:                initial?.from_date ?? '',
    to_date:                  initial?.to_date ?? '',
    notes:                    initial?.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)

  function set(field: string, value: string | boolean) {
    setValues(v => ({ ...v, [field]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const payload = {
      firm_id:                firmId,
      property_id:            propertyId,
      unit_id:                values.unit_id,
      full_name:              values.full_name,
      email:                  values.email || null,
      phone:                  values.phone || null,
      correspondence_address: values.correspondence_address || null,
      is_resident:            values.is_resident,
      is_company:             values.is_company,
      company_name:           values.is_company ? (values.company_name || null) : null,
      company_reg:            values.is_company ? (values.company_reg || null) : null,
      portal_access:          values.portal_access,
      is_current:             values.is_current,
      from_date:              values.from_date || null,
      // Clear to_date if leaseholder is marked as current
      to_date:                values.is_current ? null : (values.to_date || null),
      notes:                  values.notes || null,
    }

    let err: { message: string } | null = null
    if (initial) {
      ;({ error: err } = await supabase.from('leaseholders').update(payload).eq('id', initial.id))
    } else {
      ;({ error: err } = await supabase.from('leaseholders').insert({
        ...payload,
        user_id: null, // portal user link is assigned separately in Phase 5
      }))
    }

    if (err) { setError(err.message); setSaving(false) }
    else onSaved()
  }

  return (
    <Card className="mb-4 max-w-3xl">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{initial ? 'Edit leaseholder' : 'New leaseholder'}</h3>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>

        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          {/* Unit assignment */}
          <div className="space-y-1">
            <label htmlFor="lh-unit" className="text-sm font-medium">Unit *</label>
            <select
              id="lh-unit"
              required
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

          {/* Company toggle */}
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                id="lh-is-company"
                checked={values.is_company}
                onChange={e => set('is_company', e.target.checked)}
                className="h-4 w-4"
              />
              Company leaseholder
            </label>
          </div>

          {/* Name */}
          <div className="space-y-1">
            <label htmlFor="lh-name" className="text-sm font-medium">
              {values.is_company ? 'Contact name *' : 'Full name *'}
            </label>
            <Input
              id="lh-name"
              required
              placeholder={values.is_company ? 'Contact at company' : 'e.g. Jane Smith'}
              value={values.full_name}
              onChange={e => set('full_name', e.target.value)}
            />
          </div>

          {/* Company fields (conditional) */}
          {values.is_company ? (
            <>
              <div className="space-y-1">
                <label htmlFor="lh-company-name" className="text-sm font-medium">Company name *</label>
                <Input
                  id="lh-company-name"
                  required={values.is_company}
                  placeholder="e.g. Smith Holdings Ltd"
                  value={values.company_name}
                  onChange={e => set('company_name', e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="lh-company-reg" className="text-sm font-medium">Company reg</label>
                <Input
                  id="lh-company-reg"
                  placeholder="e.g. 12345678"
                  value={values.company_reg}
                  onChange={e => set('company_reg', e.target.value)}
                />
              </div>
            </>
          ) : (
            <div /> // maintain grid alignment
          )}

          {/* Contact details */}
          <div className="space-y-1">
            <label htmlFor="lh-email" className="text-sm font-medium">Email</label>
            <Input
              id="lh-email"
              type="email"
              value={values.email}
              onChange={e => set('email', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="lh-phone" className="text-sm font-medium">Phone</label>
            <Input
              id="lh-phone"
              type="tel"
              value={values.phone}
              onChange={e => set('phone', e.target.value)}
            />
          </div>
          <div className="col-span-2 space-y-1">
            <label htmlFor="lh-address" className="text-sm font-medium">Correspondence address</label>
            <Input
              id="lh-address"
              placeholder="If different from unit address"
              value={values.correspondence_address}
              onChange={e => set('correspondence_address', e.target.value)}
            />
          </div>

          {/* Tenure dates */}
          <div className="space-y-1">
            <label htmlFor="lh-from" className="text-sm font-medium">From date</label>
            <Input
              id="lh-from"
              type="date"
              value={values.from_date}
              onChange={e => set('from_date', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="lh-to" className="text-sm font-medium">To date</label>
            <Input
              id="lh-to"
              type="date"
              value={values.to_date}
              disabled={values.is_current}
              onChange={e => set('to_date', e.target.value)}
            />
          </div>

          {/* Flags */}
          <div className="col-span-2 grid grid-cols-2 gap-2 pt-1">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={values.is_resident}
                onChange={e => set('is_resident', e.target.checked)}
                className="h-4 w-4"
              />
              Resident (lives in unit)
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={values.is_current}
                onChange={e => set('is_current', e.target.checked)}
                className="h-4 w-4"
              />
              Current leaseholder
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={values.portal_access}
                onChange={e => set('portal_access', e.target.checked)}
                className="h-4 w-4"
              />
              Portal access <span className="text-muted-foreground">(Phase 5)</span>
            </label>
          </div>

          {/* Notes */}
          <div className="col-span-2 space-y-1">
            <label htmlFor="lh-notes" className="text-sm font-medium">Notes</label>
            <Input
              id="lh-notes"
              value={values.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Any additional notes…"
            />
          </div>

          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <div className="col-span-2 flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : initial ? 'Update leaseholder' : 'Save leaseholder'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
