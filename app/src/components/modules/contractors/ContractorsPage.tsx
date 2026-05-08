/**
 * @file ContractorsPage.tsx
 * @description Contractor register — approved trade contractors for the firm.
 * Responsible for: contractor CRUD, trade categories, insurance expiry tracking.
 * NOT responsible for: works order dispatch (WorksPage), portal access management.
 */
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, Card, CardContent, Badge, Input } from '@/components/ui'
import { HardHat, Plus, Search, Pencil, X } from 'lucide-react'
import { formatDate, daysUntil } from '@/lib/utils'
import type { Database } from '@/types/database'

type Contractor = Database['public']['Tables']['contractors']['Row']

const TRADE_LABELS: Record<string, string> = {
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

export function ContractorsPage() {
  const firmContext = useAuthStore(s => s.firmContext)
  const [contractors, setContractors] = useState<Contractor[]>([])
  const [filtered, setFiltered] = useState<Contractor[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Contractor | null>(null)

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

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const q = search.toLowerCase()
    setFiltered(
      contractors.filter(c =>
        c.company_name.toLowerCase().includes(q) ||
        (c.contact_name ?? '').toLowerCase().includes(q) ||
        (c.email ?? '').toLowerCase().includes(q) ||
        (c.trade_categories ?? []).some(t => (TRADE_LABELS[t] ?? t).toLowerCase().includes(q))
      )
    )
  }, [search, contractors])

  const approved = contractors.filter(c => c.approved && c.active).length

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
            initial={editing}
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
                              {TRADE_LABELS[t] ?? t}
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
      </div>
    </div>
  )
}

// ── Contractor Form ─────────────────────────────────────────────────────────
function ContractorForm({ firmId, initial, onSaved, onCancel }: {
  firmId: string
  initial: Contractor | null
  onSaved: () => void
  onCancel: () => void
}) {
  const [values, setValues] = useState({
    company_name: initial?.company_name ?? '',
    contact_name: initial?.contact_name ?? '',
    email: initial?.email ?? '',
    phone: initial?.phone ?? '',
    address: initial?.address ?? '',
    trade_categories_text: (initial?.trade_categories ?? []).join(', '),
    insurance_expiry: initial?.insurance_expiry ?? '',
    gas_safe_number: initial?.gas_safe_number ?? '',
    electrical_approval: initial?.electrical_approval ?? '',
    preferred_order: String(initial?.preferred_order ?? 99),
    approved: initial?.approved ?? false,
    active: initial?.active ?? true,
    notes: initial?.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set(field: string, value: string | boolean) {
    setValues(v => ({ ...v, [field]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)

    // Parse comma-separated trade categories → normalised slug array
    const tradeCategories = values.trade_categories_text
      .split(',')
      .map(s => s.trim().toLowerCase().replace(/\s+/g, '_'))
      .filter(Boolean)

    const payload = {
      firm_id: firmId,
      company_name: values.company_name,
      contact_name: values.contact_name || null,
      email: values.email || null,
      phone: values.phone || null,
      address: values.address || null,
      trade_categories: tradeCategories.length > 0 ? tradeCategories : null,
      insurance_expiry: values.insurance_expiry || null,
      gas_safe_number: values.gas_safe_number || null,
      electrical_approval: values.electrical_approval || null,
      preferred_order: parseInt(values.preferred_order, 10) || 99,
      approved: values.approved,
      active: values.active,
      notes: values.notes || null,
    }

    let err: { message: string } | null = null
    if (initial) {
      ;({ error: err } = await supabase.from('contractors').update(payload).eq('id', initial.id))
    } else {
      ;({ error: err } = await supabase.from('contractors').insert(payload))
    }
    if (err) { setError(err.message); setSaving(false) }
    else onSaved()
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
          <div className="col-span-2 space-y-1">
            <label htmlFor="co-trades" className="text-sm font-medium">
              Trade categories <span className="text-muted-foreground font-normal">(comma-separated)</span>
            </label>
            <Input
              id="co-trades"
              value={values.trade_categories_text}
              onChange={e => set('trade_categories_text', e.target.value)}
              placeholder="e.g. electrical, roofing, general maintenance"
            />
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
            <label htmlFor="co-order" className="text-sm font-medium">Dispatch priority <span className="text-muted-foreground font-normal">(1 = first)</span></label>
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
          <div className="col-span-2 flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                id="co-approved"
                checked={values.approved}
                onChange={e => set('approved', e.target.checked)}
                className="h-4 w-4"
              />
              Approved contractor
            </label>
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
