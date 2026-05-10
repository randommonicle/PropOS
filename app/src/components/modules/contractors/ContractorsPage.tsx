/**
 * @file ContractorsPage.tsx
 * @description Contractor register — approved trade contractors for the firm.
 * Responsible for: contractor CRUD, trade categories, insurance expiry tracking.
 * NOT responsible for: works order dispatch (WorksPage), portal access management.
 *
 * Trade categories are managed via the trade_categories lookup table (migration 00021).
 * Values stored on contractors.trade_categories are display names (e.g. "Electrical"),
 * not slugs. A legacy fallback map handles old slug-based records.
 */
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, Card, CardContent, Badge, Input } from '@/components/ui'
import { HardHat, Plus, Search, Pencil, X, ChevronDown, ChevronUp, Settings2 } from 'lucide-react'
import { formatDate, daysUntil } from '@/lib/utils'
import { hasAdminRole, hasAnyFinanceRole, hasDirectorRole } from '@/lib/constants'
import { buildPayeeSetupPA, validateProposedPayeeSetup } from '@/lib/contractors/payeeSetup'
import type { Database } from '@/types/database'

type Contractor = Database['public']['Tables']['contractors']['Row']

// trade_categories is not yet in the generated Database types
interface TradeCat {
  id: string
  firm_id: string
  name: string
  active: boolean
  sort_order: number
}

// Fallback map for old slug-based values still in the database
const LEGACY_LABELS: Record<string, string> = {
  electrical: 'Electrical',
  gas: 'Gas',
  plumbing: 'Plumbing',
  roofing: 'Roofing',
  general_maintenance: 'General Maintenance',
  lift_maintenance: 'Lift Maintenance',
  fire_safety: 'Fire Safety',
  pest_control: 'Pest Control',
  cleaning: 'Cleaning',
  landscaping: 'Landscaping',
  structural: 'Structural',
  asbestos: 'Asbestos',
  decorating: 'Decorating',
  other: 'Other',
}

function tradeLabel(t: string): string {
  return LEGACY_LABELS[t] ?? t
}

// trade_categories is not yet in the generated Database types — use any cast
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tradeCatTable = () => (supabase as any).from('trade_categories')

export function ContractorsPage() {
  const firmContext = useAuthStore(s => s.firmContext)
  const userId = useAuthStore(s => s.user?.id ?? null)
  const roles = firmContext?.roles ?? null
  const isAdmin = hasAdminRole(roles) || hasDirectorRole(roles)
  // Function-split (1i.3): payment_payee_setup PA can be requested by any
  // finance-tier staff (admin or accounts). Authorisation remains admin-only.
  const canRequestPayeeSetup = hasAnyFinanceRole(roles)

  const [contractors, setContractors] = useState<Contractor[]>([])
  const [filtered, setFiltered] = useState<Contractor[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Contractor | null>(null)
  const [tradeCategories, setTradeCategories] = useState<TradeCat[]>([])
  const [showAdminPanel, setShowAdminPanel] = useState(false)

  const loadTrades = useCallback(async () => {
    if (!firmContext?.firmId) return
    const { data } = await tradeCatTable()
      .select('*')
      .eq('firm_id', firmContext.firmId)
      .order('sort_order')
      .order('name')
    setTradeCategories((data as TradeCat[]) ?? [])
  }, [firmContext?.firmId])

  const load = useCallback(async () => {
    if (!firmContext?.firmId) return
    const { data } = await supabase
      .from('contractors')
      .select('*')
      .eq('firm_id', firmContext.firmId)
      .order('preferred_order', { ascending: true })
      .order('company_name')
    setContractors(data ?? [])
    setLoading(false)
  }, [firmContext?.firmId])

  useEffect(() => { load(); loadTrades() }, [load, loadTrades])

  useEffect(() => {
    const q = search.toLowerCase()
    setFiltered(
      contractors.filter(c =>
        c.company_name.toLowerCase().includes(q) ||
        (c.contact_name ?? '').toLowerCase().includes(q) ||
        (c.email ?? '').toLowerCase().includes(q) ||
        (c.trade_categories ?? []).some(t => tradeLabel(t).toLowerCase().includes(q))
      )
    )
  }, [search, contractors])

  const approved = contractors.filter(c => c.approved && c.active).length
  const activeCategories = tradeCategories.filter(t => t.active)

  return (
    <div>
      <PageHeader
        title="Contractors"
        description={`${approved} approved active contractor${approved === 1 ? '' : 's'}`}
      >
        <Button size="sm" onClick={() => { setEditing(null); setShowForm(true) }}>
          <Plus className="h-4 w-4 mr-1" /> Add contractor
        </Button>
      </PageHeader>

      <div className="p-8">
        {showForm && (
          <ContractorForm
            firmId={firmContext!.firmId}
            userId={userId}
            canRequestPayeeSetup={canRequestPayeeSetup}
            initial={editing}
            tradeCategories={activeCategories}
            onSaved={() => { setShowForm(false); setEditing(null); load() }}
            onCancel={() => { setShowForm(false); setEditing(null) }}
          />
        )}

        <div className="relative mb-6 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, trade, or email…"
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <HardHat className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No contractors found.</p>
          </div>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Company</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Contact</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Email / Phone</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Trades</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Ins. Expiry</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map(c => {
                  const insDays = daysUntil(c.insurance_expiry)
                  const insVariant: 'red' | 'amber' | 'green' | 'secondary' =
                    insDays === null ? 'secondary' :
                    insDays <= 14 ? 'red' :
                    insDays <= 90 ? 'amber' : 'green'
                  return (
                    <tr key={c.id} className="hover:bg-muted/20">
                      <td className="px-4 py-3">
                        <div className="font-medium">{c.company_name}</div>
                        {c.preferred_order !== null && c.preferred_order < 99 && (
                          <div className="text-xs text-muted-foreground">Priority {c.preferred_order}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">{c.contact_name ?? '—'}</td>
                      <td className="px-4 py-3">
                        <div>{c.email ?? '—'}</div>
                        {c.phone && <div className="text-xs text-muted-foreground">{c.phone}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1 max-w-xs">
                          {(c.trade_categories ?? []).slice(0, 3).map(t => (
                            <Badge key={t} variant="secondary" className="text-xs">
                              {tradeLabel(t)}
                            </Badge>
                          ))}
                          {(c.trade_categories ?? []).length > 3 && (
                            <Badge variant="outline" className="text-xs">
                              +{(c.trade_categories ?? []).length - 3}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {c.insurance_expiry ? (
                          <Badge variant={insVariant} className="text-xs">
                            {formatDate(c.insurance_expiry)}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <Badge variant={c.approved ? 'green' : 'secondary'} className="text-xs">
                            {c.approved ? 'Approved' : 'Pending'}
                          </Badge>
                          {!c.active && (
                            <Badge variant="red" className="text-xs">Inactive</Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setEditing(c); setShowForm(true) }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Admin: trade category management ─────────────────────────────── */}
        {isAdmin && (
          <div className="mt-8">
            <button
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowAdminPanel(p => !p)}
            >
              <Settings2 className="h-4 w-4" />
              Manage trade categories
              {showAdminPanel
                ? <ChevronUp className="h-3.5 w-3.5" />
                : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            {showAdminPanel && (
              <TradeAdminPanel
                firmId={firmContext!.firmId}
                categories={tradeCategories}
                onChanged={loadTrades}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Trade Admin Panel ────────────────────────────────────────────────────────
function TradeAdminPanel({ firmId, categories, onChanged }: {
  firmId: string
  categories: TradeCat[]
  onChanged: () => void
}) {
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [toggling, setToggling] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)

  async function handleAdd() {
    const name = newName.trim()
    if (!name) return
    setAdding(true)
    setAddError(null)
    const { error: err } = await tradeCatTable().insert({
      firm_id: firmId,
      name,
      sort_order: 99,
    })
    setAdding(false)
    if (err) { setAddError(err.message); return }
    setNewName('')
    onChanged()
  }

  async function handleToggle(cat: TradeCat) {
    setToggling(cat.id)
    await tradeCatTable().update({ active: !cat.active }).eq('id', cat.id)
    setToggling(null)
    onChanged()
  }

  return (
    <Card className="mt-3 max-w-xl">
      <CardContent className="p-5">
        <p className="text-xs text-muted-foreground mb-4">
          Click a category to toggle it on or off. Inactive categories can&apos;t be newly assigned
          but remain on any contractor that already has them.
        </p>
        <div className="flex flex-wrap gap-2 mb-5">
          {categories.length === 0 && (
            <p className="text-xs text-muted-foreground">No categories yet — add one below.</p>
          )}
          {categories.map(cat => (
            <button
              key={cat.id}
              type="button"
              disabled={toggling === cat.id}
              onClick={() => handleToggle(cat)}
              className={[
                'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                cat.active
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground border-input hover:border-foreground',
                toggling === cat.id ? 'opacity-50 cursor-wait' : 'cursor-pointer',
              ].join(' ')}
            >
              {cat.name}{!cat.active && ' (inactive)'}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-center">
          <Input
            placeholder="New trade category…"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            className="max-w-xs"
          />
          <Button size="sm" onClick={handleAdd} disabled={adding || !newName.trim()}>
            {adding ? 'Adding…' : 'Add'}
          </Button>
        </div>
        {addError && <p className="text-xs text-destructive mt-2">{addError}</p>}
      </CardContent>
    </Card>
  )
}

// ── Contractor Form ──────────────────────────────────────────────────────────
function ContractorForm({
  firmId, userId, canRequestPayeeSetup, initial, tradeCategories, onSaved, onCancel,
}: {
  firmId: string
  userId: string | null
  /** True iff the current user can submit a payment_payee_setup PA
   *  (hasAnyFinanceRole — admin OR accounts). */
  canRequestPayeeSetup: boolean
  initial: Contractor | null
  tradeCategories: TradeCat[]
  onSaved: () => void
  onCancel: () => void
}) {
  const [values, setValues] = useState({
    company_name:        initial?.company_name ?? '',
    contact_name:        initial?.contact_name ?? '',
    email:               initial?.email ?? '',
    phone:               initial?.phone ?? '',
    address:             initial?.address ?? '',
    insurance_expiry:    initial?.insurance_expiry ?? '',
    gas_safe_number:     initial?.gas_safe_number ?? '',
    electrical_approval: initial?.electrical_approval ?? '',
    preferred_order:     String(initial?.preferred_order ?? 99),
    active:              initial?.active ?? true,
    notes:               initial?.notes ?? '',
    // Bank details — populated into the payment_payee_setup PA proposed
    // JSONB. Not first-class columns on contractors today (PoC); production
    // schema lands in the data-integrity pass with encrypted columns.
    sort_code:           '',
    account_number:      '',
    account_name:        '',
  })

  // Selected trade categories — stored as display names (e.g. "Electrical")
  const [selectedTrades, setSelectedTrades] = useState<Set<string>>(
    new Set(initial?.trade_categories ?? [])
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set(field: string, value: string | boolean) {
    setValues(v => ({ ...v, [field]: value }))
  }

  function toggleTrade(name: string) {
    setSelectedTrades(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  // RICS Client money handling — segregation of duties. Contractor approval
  // is no longer a manually-tickable checkbox; it flows through the
  // dual-auth payment_payee_setup PA. On contractor add (or on bank-detail
  // edit on an existing contractor), the form INSERTs the contractor with
  // approved=false then INSERTs a payment_payee_setup PA. An admin
  // authorises the PA which stamps `contractors.approved_by` + `approved_at`
  // and flips `contractors.approved=true`. The same admin then becomes
  // INELIGIBLE to authorise a future payment_release to that contractor —
  // see PaymentAuthorisationsTab.handleAuthorise.
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const bankDetailsProvided =
      values.sort_code.trim() !== '' ||
      values.account_number.trim() !== '' ||
      values.account_name.trim() !== ''
    const isReApproval = !!initial && bankDetailsProvided

    // Edit path with no bank-detail change: just patch contractor metadata.
    // No PA insertion, no approved-flag flip. Mirrors the legacy "edit notes
    // and trades only" flow.
    const payload = {
      firm_id:             firmId,
      company_name:        values.company_name,
      contact_name:        values.contact_name || null,
      email:               values.email || null,
      phone:               values.phone || null,
      address:             values.address || null,
      trade_categories:    selectedTrades.size > 0 ? [...selectedTrades] : null,
      insurance_expiry:    values.insurance_expiry || null,
      gas_safe_number:     values.gas_safe_number || null,
      electrical_approval: values.electrical_approval || null,
      preferred_order:     parseInt(values.preferred_order, 10) || 99,
      // approved is NEVER set directly — only by the PA authorise path.
      // Bank-detail edit on an existing contractor flips approved=false
      // until the fresh payment_payee_setup PA is authorised.
      approved:            initial && !isReApproval ? initial.approved : false,
      active:              values.active,
      notes:               values.notes || null,
    }

    let contractorId = initial?.id ?? null
    if (initial) {
      const { error: uErr } = await supabase
        .from('contractors').update(payload).eq('id', initial.id)
      if (uErr) { setError(uErr.message); setSaving(false); return }
    } else {
      const { data: inserted, error: iErr } = await supabase
        .from('contractors').insert(payload).select('id').single()
      if (iErr || !inserted) {
        setError(iErr?.message ?? 'Failed to create contractor.')
        setSaving(false); return
      }
      contractorId = inserted.id
    }

    // Insert the payment_payee_setup PA only when bank details were entered.
    // Contractors without bank details don't yet need a PA (no money flow);
    // they can be created as approved=false and an accounts user can later
    // edit the contractor to add bank details, which triggers the PA via
    // the re-approval path. Avoids spurious validation errors on the
    // contractor-CRUD-only flow.
    const shouldInsertPA = bankDetailsProvided && canRequestPayeeSetup
    if (shouldInsertPA && contractorId && userId) {
      const pa = buildPayeeSetupPA(
        { id: contractorId, firm_id: firmId, company_name: values.company_name },
        {
          sort_code:      values.sort_code.trim()     || null,
          account_number: values.account_number.trim()|| null,
          account_name:   values.account_name.trim()  || null,
        },
        userId,
        isReApproval,
      )
      const validationError = validateProposedPayeeSetup(pa.proposed)
      if (validationError) {
        setError(validationError); setSaving(false); return
      }
      const { error: paErr } = await supabase.from('payment_authorisations').insert(pa)
      if (paErr) {
        setError(`Contractor saved but payee-setup PA failed: ${paErr.message}.`)
        setSaving(false); return
      }
    }

    setSaving(false)
    onSaved()
  }

  return (
    <Card className="mb-6 max-w-2xl">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{initial ? 'Edit contractor' : 'New contractor'}</h3>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          <div className="col-span-2 space-y-1">
            <label htmlFor="co-name" className="text-sm font-medium">Company name *</label>
            <Input
              id="co-name"
              required
              value={values.company_name}
              onChange={e => set('company_name', e.target.value)}
              placeholder="e.g. Smith Electrical Ltd"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="co-contact" className="text-sm font-medium">Contact name</label>
            <Input id="co-contact" value={values.contact_name} onChange={e => set('contact_name', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="co-email" className="text-sm font-medium">Email</label>
            <Input id="co-email" type="email" value={values.email} onChange={e => set('email', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="co-phone" className="text-sm font-medium">Phone</label>
            <Input id="co-phone" value={values.phone} onChange={e => set('phone', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="co-insexpiry" className="text-sm font-medium">Insurance expiry</label>
            <Input id="co-insexpiry" type="date" value={values.insurance_expiry} onChange={e => set('insurance_expiry', e.target.value)} />
          </div>

          {/* Trade category tag toggles */}
          <div className="col-span-2 space-y-2">
            <label className="text-sm font-medium">Trade categories</label>
            {tradeCategories.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No active trade categories. An admin can configure them via &ldquo;Manage trade categories&rdquo; below the contractor list.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {tradeCategories.map(cat => {
                  const selected = selectedTrades.has(cat.name)
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => toggleTrade(cat.name)}
                      className={[
                        'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                        selected
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background text-muted-foreground border-input hover:border-foreground',
                      ].join(' ')}
                    >
                      {cat.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="co-gas" className="text-sm font-medium">Gas Safe number</label>
            <Input id="co-gas" value={values.gas_safe_number} onChange={e => set('gas_safe_number', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="co-elec" className="text-sm font-medium">Electrical approval</label>
            <Input
              id="co-elec"
              value={values.electrical_approval}
              onChange={e => set('electrical_approval', e.target.value)}
              placeholder="e.g. NICEIC, NAPIT"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="co-order" className="text-sm font-medium">
              Dispatch priority <span className="text-muted-foreground font-normal">(1 = first)</span>
            </label>
            <Input
              id="co-order"
              type="number"
              min="1"
              value={values.preferred_order}
              onChange={e => set('preferred_order', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="co-notes" className="text-sm font-medium">Notes</label>
            <Input id="co-notes" value={values.notes} onChange={e => set('notes', e.target.value)} />
          </div>
          {/* Bank details — RICS function-split. Filled in for the
              payment_payee_setup PA's proposed JSONB. Optional on edit;
              when filled in on edit, triggers a fresh PA + flips the
              contractor's approved flag back to false. */}
          <div className="col-span-2 mt-2 pt-4 border-t">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-medium">Bank details (payee setup)</h4>
              {initial && (
                <Badge variant={initial.approved ? 'green' : 'amber'} className="text-xs">
                  {initial.approved ? 'Approved' : 'Pending payee-setup approval'}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Saving with bank details entered raises a payment_payee_setup
              authorisation request. An admin (other than the requester)
              must authorise it before any payment can be released to this
              contractor. RICS Client money handling — segregation of
              duties; both signatories must be staff of the firm.
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <label htmlFor="co-sort" className="text-xs font-medium">Sort code</label>
                <Input id="co-sort" placeholder="00-00-00"
                  value={values.sort_code}
                  onChange={e => set('sort_code', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label htmlFor="co-acct" className="text-xs font-medium">Account number</label>
                <Input id="co-acct" placeholder="12345678"
                  value={values.account_number}
                  onChange={e => set('account_number', e.target.value)} />
              </div>
              <div className="space-y-1">
                <label htmlFor="co-acctn" className="text-xs font-medium">Account name</label>
                <Input id="co-acctn"
                  value={values.account_name}
                  onChange={e => set('account_name', e.target.value)} />
              </div>
            </div>
          </div>
          <div className="col-span-2 flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                id="co-active"
                checked={values.active}
                onChange={e => set('active', e.target.checked)}
                className="h-4 w-4"
              />
              Active
            </label>
          </div>
          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <div className="col-span-2 flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : initial ? 'Update' : 'Save contractor'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
