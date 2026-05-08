/**
 * @file CompliancePage.tsx
 * @description Compliance tracker — statutory inspection items and insurance policies.
 * Tabs: Compliance Items (RAG dashboard) | Insurance Policies
 * Responsible for: RAG status overview, compliance item CRUD, insurance policy CRUD.
 * NOT responsible for: reminder scheduling (Edge Function), document linking.
 */
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, Card, CardContent, Badge, Input } from '@/components/ui'
import { ShieldCheck, Plus, Search, Pencil, X } from 'lucide-react'
import { cn, formatDate, daysUntil, ragStatus } from '@/lib/utils'
import type { Database } from '@/types/database'

type ComplianceItem = Database['public']['Tables']['compliance_items']['Row']
type InsurancePolicy = Database['public']['Tables']['insurance_policies']['Row']
type Property = Database['public']['Tables']['properties']['Row']

// ── Display label maps ───────────────────────────────────────────────────────
const ITEM_TYPE_LABELS: Record<string, string> = {
  eicr: 'EICR',
  fra: 'Fire Risk Assessment',
  gas_safety: 'Gas Safety',
  asbestos_management: 'Asbestos Management',
  asbestos_refurb: 'Asbestos Refurb',
  lift_thorough: 'Lift (Thorough)',
  lift_service: 'Lift (Service)',
  health_safety: 'Health & Safety',
  water_hygiene: 'Water Hygiene',
  legionella: 'Legionella',
  pat_testing: 'PAT Testing',
  fire_suppression: 'Fire Suppression',
  emergency_lighting: 'Emergency Lighting',
  planning: 'Planning',
  building_regs: 'Building Regs',
  other: 'Other',
}

const POLICY_TYPE_LABELS: Record<string, string> = {
  buildings: 'Buildings',
  liability: 'Public Liability',
  directors_officers: 'Directors & Officers',
  terrorism: 'Terrorism',
  engineering: 'Engineering',
  other: 'Other',
}

function ragVariant(days: number | null): 'red' | 'amber' | 'green' | 'secondary' {
  const r = ragStatus(days)
  if (r === 'red') return 'red'
  if (r === 'amber') return 'amber'
  if (r === 'green') return 'green'
  return 'secondary'
}

// ── Shared tab bar ───────────────────────────────────────────────────────────
function TabBar({ tabs, active, onChange }: {
  tabs: { key: string; label: string }[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="flex border-b mb-6">
      {tabs.map(t => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            active === t.key
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

const SELECT_CLASS = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm'

// ════════════════════════════════════════════════════════════════════════════
// CompliancePage — root
// ════════════════════════════════════════════════════════════════════════════
export function CompliancePage() {
  const firmContext = useAuthStore(s => s.firmContext)
  const [tab, setTab] = useState<'items' | 'insurance'>('items')
  const [properties, setProperties] = useState<Property[]>([])

  useEffect(() => {
    if (!firmContext?.firmId) return
    supabase
      .from('properties')
      .select('*')
      .eq('firm_id', firmContext.firmId)
      .order('name')
      .then(({ data }) => setProperties(data ?? []))
  }, [firmContext?.firmId])

  const propMap = new Map(properties.map(p => [p.id, p.name]))
  const firmId = firmContext?.firmId ?? ''

  return (
    <div>
      <PageHeader
        title="Compliance"
        description="Statutory inspections, certifications, and insurance policies"
      />
      <div className="p-8">
        <TabBar
          tabs={[
            { key: 'items', label: 'Compliance Items' },
            { key: 'insurance', label: 'Insurance Policies' },
          ]}
          active={tab}
          onChange={k => setTab(k as 'items' | 'insurance')}
        />
        {tab === 'items' && (
          <ComplianceItemsTab firmId={firmId} properties={properties} propMap={propMap} />
        )}
        {tab === 'insurance' && (
          <InsuranceTab firmId={firmId} properties={properties} propMap={propMap} />
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Compliance Items Tab
// ════════════════════════════════════════════════════════════════════════════
function ComplianceItemsTab({ firmId, properties, propMap }: {
  firmId: string
  properties: Property[]
  propMap: Map<string, string>
}) {
  const [items, setItems] = useState<ComplianceItem[]>([])
  const [filtered, setFiltered] = useState<ComplianceItem[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<ComplianceItem | null>(null)

  const load = useCallback(async () => {
    if (!firmId) return
    const { data } = await supabase
      .from('compliance_items')
      .select('*')
      .eq('firm_id', firmId)
      .order('expiry_date', { ascending: true, nullsFirst: false })
    setItems(data ?? [])
    setLoading(false)
  }, [firmId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const q = search.toLowerCase()
    setFiltered(
      items.filter(item =>
        item.description.toLowerCase().includes(q) ||
        (ITEM_TYPE_LABELS[item.item_type] ?? item.item_type).toLowerCase().includes(q) ||
        (propMap.get(item.property_id) ?? '').toLowerCase().includes(q)
      )
    )
  }, [search, items, propMap])

  const red = items.filter(i => ragStatus(daysUntil(i.expiry_date)) === 'red').length
  const amber = items.filter(i => ragStatus(daysUntil(i.expiry_date)) === 'amber').length
  const green = items.filter(i => ragStatus(daysUntil(i.expiry_date)) === 'green').length

  return (
    <div>
      {/* RAG summary strip */}
      <div className="grid grid-cols-3 gap-4 mb-6 max-w-sm">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-red-600">{red}</p>
            <p className="text-xs text-muted-foreground mt-1">Red</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-amber-600">{amber}</p>
            <p className="text-xs text-muted-foreground mt-1">Amber</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-green-600">{green}</p>
            <p className="text-xs text-muted-foreground mt-1">Green</p>
          </CardContent>
        </Card>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search items…"
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <Button size="sm" onClick={() => { setEditing(null); setShowForm(true) }}>
          <Plus className="h-4 w-4 mr-1" /> Add item
        </Button>
      </div>

      {showForm && (
        <ComplianceItemForm
          firmId={firmId}
          properties={properties}
          initial={editing}
          onSaved={() => { setShowForm(false); setEditing(null); load() }}
          onCancel={() => { setShowForm(false); setEditing(null) }}
        />
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <ShieldCheck className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No compliance items found.</p>
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Property</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Type</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Description</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Issue Date</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Expiry</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(item => {
                const days = daysUntil(item.expiry_date)
                const variant = ragVariant(days)
                const statusVariant: 'green' | 'red' | 'secondary' =
                  item.status === 'current' ? 'green' :
                  item.status === 'expired' ? 'red' : 'secondary'
                return (
                  <tr key={item.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium whitespace-nowrap">
                      {propMap.get(item.property_id) ?? '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge variant="outline" className="text-xs">
                        {ITEM_TYPE_LABELS[item.item_type] ?? item.item_type}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 max-w-xs truncate">{item.description}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatDate(item.issue_date)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <Badge variant={variant} className="text-xs">
                          {item.expiry_date ? formatDate(item.expiry_date) : 'No date'}
                        </Badge>
                        {days !== null && (
                          <span className="text-xs text-muted-foreground">
                            {days < 0 ? `${Math.abs(days)}d overdue` : `${days}d`}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Badge variant={statusVariant} className="text-xs capitalize">
                        {item.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setEditing(item); setShowForm(true) }}
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
  )
}

// ── Compliance Item Form ────────────────────────────────────────────────────
function ComplianceItemForm({ firmId, properties, initial, onSaved, onCancel }: {
  firmId: string
  properties: Property[]
  initial: ComplianceItem | null
  onSaved: () => void
  onCancel: () => void
}) {
  const [values, setValues] = useState({
    property_id: initial?.property_id ?? '',
    item_type: initial?.item_type ?? 'eicr',
    description: initial?.description ?? '',
    issue_date: initial?.issue_date ?? '',
    expiry_date: initial?.expiry_date ?? '',
    status: initial?.status ?? 'current',
    notes: initial?.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set(field: string, value: string) {
    setValues(v => ({ ...v, [field]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const payload = {
      firm_id: firmId,
      property_id: values.property_id,
      item_type: values.item_type,
      description: values.description,
      issue_date: values.issue_date || null,
      expiry_date: values.expiry_date || null,
      status: values.status,
      notes: values.notes || null,
    }
    let err: { message: string } | null = null
    if (initial) {
      ;({ error: err } = await supabase.from('compliance_items').update(payload).eq('id', initial.id))
    } else {
      ;({ error: err } = await supabase.from('compliance_items').insert(payload))
    }
    if (err) { setError(err.message); setSaving(false) }
    else onSaved()
  }

  return (
    <Card className="mb-6 max-w-2xl">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{initial ? 'Edit compliance item' : 'New compliance item'}</h3>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label htmlFor="ci-property" className="text-sm font-medium">Property *</label>
            <select id="ci-property" required className={SELECT_CLASS} value={values.property_id} onChange={e => set('property_id', e.target.value)}>
              <option value="">Select property…</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="ci-type" className="text-sm font-medium">Item type *</label>
            <select id="ci-type" required className={SELECT_CLASS} value={values.item_type} onChange={e => set('item_type', e.target.value)}>
              {Object.entries(ITEM_TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2 space-y-1">
            <label htmlFor="ci-desc" className="text-sm font-medium">Description *</label>
            <Input
              id="ci-desc"
              required
              value={values.description}
              onChange={e => set('description', e.target.value)}
              placeholder="e.g. EICR — main distribution board"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="ci-issue" className="text-sm font-medium">Issue date</label>
            <Input id="ci-issue" type="date" value={values.issue_date} onChange={e => set('issue_date', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="ci-expiry" className="text-sm font-medium">Expiry date</label>
            <Input id="ci-expiry" type="date" value={values.expiry_date} onChange={e => set('expiry_date', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="ci-status" className="text-sm font-medium">Status</label>
            <select id="ci-status" className={SELECT_CLASS} value={values.status} onChange={e => set('status', e.target.value)}>
              <option value="current">Current</option>
              <option value="expiring_soon">Expiring Soon</option>
              <option value="expired">Expired</option>
              <option value="action_required">Action Required</option>
              <option value="not_applicable">Not Applicable</option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="ci-notes" className="text-sm font-medium">Notes</label>
            <Input id="ci-notes" value={values.notes} onChange={e => set('notes', e.target.value)} />
          </div>
          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <div className="col-span-2 flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : initial ? 'Update' : 'Save item'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Insurance Tab
// ════════════════════════════════════════════════════════════════════════════
function InsuranceTab({ firmId, properties, propMap }: {
  firmId: string
  properties: Property[]
  propMap: Map<string, string>
}) {
  const [policies, setPolicies] = useState<InsurancePolicy[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<InsurancePolicy | null>(null)

  const load = useCallback(async () => {
    if (!firmId) return
    const { data } = await supabase
      .from('insurance_policies')
      .select('*')
      .eq('firm_id', firmId)
      .order('renewal_date', { ascending: true })
    setPolicies(data ?? [])
    setLoading(false)
  }, [firmId])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-muted-foreground">
          {policies.length} {policies.length === 1 ? 'policy' : 'policies'}
        </p>
        <Button size="sm" onClick={() => { setEditing(null); setShowForm(true) }}>
          <Plus className="h-4 w-4 mr-1" /> Add policy
        </Button>
      </div>

      {showForm && (
        <InsurancePolicyForm
          firmId={firmId}
          properties={properties}
          initial={editing}
          onSaved={() => { setShowForm(false); setEditing(null); load() }}
          onCancel={() => { setShowForm(false); setEditing(null) }}
        />
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : policies.length === 0 ? (
        <div className="text-center py-16">
          <ShieldCheck className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No insurance policies found.</p>
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Property</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Insurer</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Policy #</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Type</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Renewal</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {policies.map(pol => {
                const days = daysUntil(pol.renewal_date)
                const variant = ragVariant(days)
                return (
                  <tr key={pol.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium whitespace-nowrap">
                      {propMap.get(pol.property_id) ?? '—'}
                    </td>
                    <td className="px-4 py-3">{pol.insurer}</td>
                    <td className="px-4 py-3 text-muted-foreground">{pol.policy_number ?? '—'}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="text-xs">
                        {POLICY_TYPE_LABELS[pol.policy_type] ?? pol.policy_type}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <Badge variant={variant} className="text-xs">{formatDate(pol.renewal_date)}</Badge>
                        {days !== null && (
                          <span className="text-xs text-muted-foreground">
                            {days < 0 ? `${Math.abs(days)}d overdue` : `${days}d`}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setEditing(pol); setShowForm(true) }}
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
  )
}

// ── Insurance Policy Form ───────────────────────────────────────────────────
function InsurancePolicyForm({ firmId, properties, initial, onSaved, onCancel }: {
  firmId: string
  properties: Property[]
  initial: InsurancePolicy | null
  onSaved: () => void
  onCancel: () => void
}) {
  const [values, setValues] = useState({
    property_id: initial?.property_id ?? '',
    insurer: initial?.insurer ?? '',
    broker: initial?.broker ?? '',
    policy_number: initial?.policy_number ?? '',
    policy_type: initial?.policy_type ?? 'buildings',
    inception_date: initial?.inception_date ?? '',
    renewal_date: initial?.renewal_date ?? '',
    auto_renew: initial?.auto_renew ?? false,
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
    const payload = {
      firm_id: firmId,
      property_id: values.property_id,
      insurer: values.insurer,
      broker: values.broker || null,
      policy_number: values.policy_number || null,
      policy_type: values.policy_type,
      inception_date: values.inception_date,
      renewal_date: values.renewal_date,
      auto_renew: values.auto_renew,
      notes: values.notes || null,
    }
    let err: { message: string } | null = null
    if (initial) {
      ;({ error: err } = await supabase.from('insurance_policies').update(payload).eq('id', initial.id))
    } else {
      ;({ error: err } = await supabase.from('insurance_policies').insert(payload))
    }
    if (err) { setError(err.message); setSaving(false) }
    else onSaved()
  }

  return (
    <Card className="mb-6 max-w-2xl">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{initial ? 'Edit insurance policy' : 'New insurance policy'}</h3>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label htmlFor="ip-property" className="text-sm font-medium">Property *</label>
            <select id="ip-property" required className={SELECT_CLASS} value={values.property_id} onChange={e => set('property_id', e.target.value)}>
              <option value="">Select property…</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="ip-type" className="text-sm font-medium">Policy type *</label>
            <select id="ip-type" required className={SELECT_CLASS} value={values.policy_type} onChange={e => set('policy_type', e.target.value)}>
              {Object.entries(POLICY_TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="ip-insurer" className="text-sm font-medium">Insurer *</label>
            <Input id="ip-insurer" required value={values.insurer} onChange={e => set('insurer', e.target.value)} placeholder="e.g. Zurich" />
          </div>
          <div className="space-y-1">
            <label htmlFor="ip-broker" className="text-sm font-medium">Broker</label>
            <Input id="ip-broker" value={values.broker} onChange={e => set('broker', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="ip-polnum" className="text-sm font-medium">Policy number</label>
            <Input id="ip-polnum" value={values.policy_number} onChange={e => set('policy_number', e.target.value)} />
          </div>
          <div className="flex items-center gap-3 pt-6">
            <input
              type="checkbox"
              id="ip-autorenew"
              checked={values.auto_renew}
              onChange={e => set('auto_renew', e.target.checked)}
              className="h-4 w-4"
            />
            <label htmlFor="ip-autorenew" className="text-sm">Auto-renew</label>
          </div>
          <div className="space-y-1">
            <label htmlFor="ip-inception" className="text-sm font-medium">Inception date *</label>
            <Input id="ip-inception" type="date" required value={values.inception_date} onChange={e => set('inception_date', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="ip-renewal" className="text-sm font-medium">Renewal date *</label>
            <Input id="ip-renewal" type="date" required value={values.renewal_date} onChange={e => set('renewal_date', e.target.value)} />
          </div>
          <div className="col-span-2 space-y-1">
            <label htmlFor="ip-notes" className="text-sm font-medium">Notes</label>
            <Input id="ip-notes" value={values.notes} onChange={e => set('notes', e.target.value)} />
          </div>
          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <div className="col-span-2 flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : initial ? 'Update' : 'Save policy'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
