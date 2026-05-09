/**
 * @file WorksPage.tsx
 * @description Works orders, dispatch engine, and Section 20 consultation tracker.
 * Tabs: Works Orders | Section 20
 *
 * Dispatch engine:
 *   - Creates dispatch_log entry with a signed token
 *   - Sets works_order.status = 'dispatching'
 *   - Invokes dispatch-engine Edge Function → sends accept/decline email via Resend
 *   - contractor-response Edge Function handles token accept/decline (public endpoint)
 *   - dispatch_timeout_check() SQL function + pg_cron resets timed-out dispatches to draft
 *
 * Section 20 state machine (LTA 1985 s.20):
 *   stage1_pending → stage1_issued → stage1_closed
 *     → stage2_issued → stage2_closed → awarded → complete
 *   Any active stage → dispensation (LTA 1985 s.20ZA)
 */
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, Card, CardContent, Badge, Input } from '@/components/ui'
import { Wrench, Plus, Search, Pencil, X, Send, ChevronRight } from 'lucide-react'
import { cn, formatDate } from '@/lib/utils'
import type { Database } from '@/types/database'

type WorksOrder     = Database['public']['Tables']['works_orders']['Row']
type Section20      = Database['public']['Tables']['section20_consultations']['Row']
type Section20Update = Database['public']['Tables']['section20_consultations']['Update']
type S20Observation = Database['public']['Tables']['section20_observations']['Row']
type Contractor     = Database['public']['Tables']['contractors']['Row']
type Property       = Database['public']['Tables']['properties']['Row']

// ── Status / priority display maps ──────────────────────────────────────────
const ORDER_STATUS_VARIANT: Record<string, 'secondary' | 'amber' | 'green' | 'red' | 'outline'> = {
  draft: 'secondary',
  dispatching: 'amber',
  accepted: 'outline',
  in_progress: 'amber',
  complete: 'green',
  cancelled: 'red',
  disputed: 'red',
  dispatch_failed: 'red',
}

const PRIORITY_VARIANT: Record<string, 'red' | 'amber' | 'outline' | 'secondary'> = {
  emergency: 'red',
  high: 'amber',
  normal: 'outline',
  low: 'secondary',
}

const ORDER_TYPE_LABELS: Record<string, string> = {
  reactive: 'Reactive',
  planned: 'Planned',
  section20: 'Section 20',
  emergency: 'Emergency',
  recall: 'Recall',
}

const S20_STATUS_LABELS: Record<string, string> = {
  stage1_pending:  'Stage 1 — Pending',
  stage1_issued:   'Stage 1 — Notice Issued',
  stage1_closed:   'Stage 1 — Closed',
  stage2_issued:   'Stage 2 — Notice Issued',
  stage2_closed:   'Stage 2 — Closed',
  awarded:         'Contract Awarded',
  complete:        'Complete',
  dispensation:    'Dispensation Applied',
  withdrawn:       'Withdrawn',
}

const S20_STATUS_VARIANT: Record<string, 'secondary' | 'amber' | 'green' | 'red' | 'outline'> = {
  stage1_pending:  'secondary',
  stage1_issued:   'amber',
  stage1_closed:   'outline',
  stage2_issued:   'amber',
  stage2_closed:   'outline',
  awarded:         'green',
  complete:        'green',
  dispensation:    'outline',
  withdrawn:       'red',
}

/** Active statuses that can be advanced, withdrawn, or have dispensation applied */
const S20_ACTIVE = new Set(['stage1_pending','stage1_issued','stage1_closed','stage2_issued','stage2_closed','awarded'])

/** Number of days remaining in the statutory 30-day observation window (0 when period has elapsed) */
function s20ObservationDaysRemaining(c: Section20): number {
  const noticeDate =
    c.status === 'stage1_issued' ? c.stage1_notice_date :
    c.status === 'stage2_issued' ? c.stage2_notice_date : null
  if (!noticeDate) return 0
  const closeAfter = new Date(noticeDate)
  closeAfter.setDate(closeAfter.getDate() + 30)
  return Math.max(0, Math.ceil((closeAfter.getTime() - Date.now()) / 86_400_000))
}

const SELECT_CLASS = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm'

// ── Tab bar ──────────────────────────────────────────────────────────────────
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

// ════════════════════════════════════════════════════════════════════════════
// WorksPage — root
// ════════════════════════════════════════════════════════════════════════════
export function WorksPage() {
  const firmContext = useAuthStore(s => s.firmContext)
  const [tab, setTab] = useState<'orders' | 's20'>('orders')
  const [properties, setProperties] = useState<Property[]>([])
  const [contractors, setContractors] = useState<Contractor[]>([])

  useEffect(() => {
    if (!firmContext?.firmId) return
    const id = firmContext.firmId
    Promise.all([
      supabase.from('properties').select('*').eq('firm_id', id).order('name'),
      supabase.from('contractors').select('*').eq('firm_id', id).eq('approved', true).eq('active', true).order('preferred_order'),
    ]).then(([props, contrs]) => {
      setProperties(props.data ?? [])
      setContractors(contrs.data ?? [])
    })
  }, [firmContext?.firmId])

  const propMap = new Map(properties.map(p => [p.id, p.name]))
  const contrMap = new Map(contractors.map(c => [c.id, c.company_name]))
  const firmId = firmContext?.firmId ?? ''

  return (
    <div>
      <PageHeader title="Works" description="Works orders, dispatch, and Section 20 consultations" />
      <div className="p-8">
        <TabBar
          tabs={[
            { key: 'orders', label: 'Works Orders' },
            { key: 's20', label: 'Section 20' },
          ]}
          active={tab}
          onChange={k => setTab(k as 'orders' | 's20')}
        />
        {tab === 'orders' && (
          <WorksOrdersTab
            firmId={firmId}
            properties={properties}
            contractors={contractors}
            propMap={propMap}
            contrMap={contrMap}
          />
        )}
        {tab === 's20' && (
          <Section20Tab
            firmId={firmId}
            properties={properties}
            contractors={contractors}
            propMap={propMap}
          />
        )}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Works Orders Tab
// ════════════════════════════════════════════════════════════════════════════
function WorksOrdersTab({ firmId, properties, contractors, propMap, contrMap }: {
  firmId: string
  properties: Property[]
  contractors: Contractor[]
  propMap: Map<string, string>
  contrMap: Map<string, string>
}) {
  const [orders, setOrders] = useState<WorksOrder[]>([])
  const [filtered, setFiltered] = useState<WorksOrder[]>([])
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('active')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<WorksOrder | null>(null)
  const [dispatching,    setDispatching]    = useState<WorksOrder | null>(null)
  const [emailWarning,   setEmailWarning]   = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!firmId) return
    const { data } = await supabase
      .from('works_orders')
      .select('*')
      .eq('firm_id', firmId)
      .order('raised_date', { ascending: false })
    setOrders(data ?? [])
    setLoading(false)
  }, [firmId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const q = search.toLowerCase()
    let base = orders
    if (statusFilter === 'active') {
      base = orders.filter(o => ['draft', 'dispatching', 'accepted', 'in_progress'].includes(o.status))
    } else if (statusFilter !== 'all') {
      base = orders.filter(o => o.status === statusFilter)
    }
    setFiltered(
      base.filter(o =>
        o.description.toLowerCase().includes(q) ||
        (propMap.get(o.property_id) ?? '').toLowerCase().includes(q) ||
        (contrMap.get(o.contractor_id ?? '') ?? '').toLowerCase().includes(q)
      )
    )
  }, [search, orders, statusFilter, propMap, contrMap])

  const openCount = orders.filter(o => ['draft', 'dispatching', 'accepted', 'in_progress'].includes(o.status)).length

  return (
    <div>
      {/* Controls */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search orders…"
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          className={cn(SELECT_CLASS, 'w-auto')}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="active">Active ({openCount})</option>
          <option value="all">All orders</option>
          <option value="draft">Draft</option>
          <option value="dispatching">Dispatching</option>
          <option value="accepted">Accepted</option>
          <option value="in_progress">In Progress</option>
          <option value="complete">Complete</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <Button size="sm" onClick={() => { setEditing(null); setShowForm(true) }}>
          <Plus className="h-4 w-4 mr-1" /> New order
        </Button>
      </div>

      {showForm && (
        <WorksOrderForm
          firmId={firmId}
          properties={properties}
          contractors={contractors}
          initial={editing}
          onSaved={() => { setShowForm(false); setEditing(null); load() }}
          onCancel={() => { setShowForm(false); setEditing(null) }}
        />
      )}

      {/* Email warning banner — shown when dispatch-engine Edge Function fails */}
      {emailWarning && (
        <div className="mb-4 flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>⚠ {emailWarning}</span>
          <button
            className="ml-4 text-amber-600 hover:text-amber-800 font-medium"
            onClick={() => setEmailWarning(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {dispatching && (
        <DispatchModal
          firmId={firmId}
          order={dispatching}
          contractors={contractors}
          onDispatched={(emailSent) => {
            setDispatching(null)
            load()
            if (!emailSent) {
              setEmailWarning(
                'Dispatch saved, but email notification failed — the contractor was not emailed. ' +
                'Check that the contractor has a valid email address on file.'
              )
            }
          }}
          onCancel={() => setDispatching(null)}
        />
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <Wrench className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No works orders found.</p>
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Property</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Description</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Type</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Priority</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Required By</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Contractor</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(order => (
                <tr key={order.id} className="hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium whitespace-nowrap">
                    {propMap.get(order.property_id) ?? '—'}
                  </td>
                  <td className="px-4 py-3 max-w-xs truncate">{order.description}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Badge variant="secondary" className="text-xs">
                      {ORDER_TYPE_LABELS[order.order_type] ?? order.order_type}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Badge variant={PRIORITY_VARIANT[order.priority] ?? 'secondary'} className="text-xs capitalize">
                      {order.priority}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Badge variant={ORDER_STATUS_VARIANT[order.status] ?? 'secondary'} className="text-xs capitalize">
                      {order.status.replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {formatDate(order.required_by)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {order.contractor_id ? contrMap.get(order.contractor_id) ?? '—' : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {order.status === 'draft' && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setDispatching(order)}
                          title="Dispatch to contractor"
                        >
                          <Send className="h-3.5 w-3.5 mr-1" /> Dispatch
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setEditing(order); setShowForm(true) }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Works Order Form ────────────────────────────────────────────────────────
function WorksOrderForm({ firmId, properties, contractors, initial, onSaved, onCancel }: {
  firmId: string
  properties: Property[]
  contractors: Contractor[]
  initial: WorksOrder | null
  onSaved: () => void
  onCancel: () => void
}) {
  const { user } = useAuthStore()
  const [values, setValues] = useState({
    property_id: initial?.property_id ?? '',
    description: initial?.description ?? '',
    order_type: initial?.order_type ?? 'reactive',
    priority: initial?.priority ?? 'normal',
    raised_date: initial?.raised_date ?? new Date().toISOString().split('T')[0],
    required_by: initial?.required_by ?? '',
    estimated_cost: initial?.estimated_cost != null ? String(initial.estimated_cost) : '',
    contractor_id: initial?.contractor_id ?? '',
    status: initial?.status ?? 'draft',
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
      description: values.description,
      order_type: values.order_type,
      priority: values.priority,
      raised_date: values.raised_date,
      required_by: values.required_by || null,
      estimated_cost: values.estimated_cost ? parseFloat(values.estimated_cost) : null,
      contractor_id: values.contractor_id || null,
      status: values.status,
      notes: values.notes || null,
      created_by: initial ? undefined : user?.id ?? null,
    }
    let err: { message: string } | null = null
    if (initial) {
      ;({ error: err } = await supabase.from('works_orders').update(payload).eq('id', initial.id))
    } else {
      ;({ error: err } = await supabase.from('works_orders').insert(payload))
    }
    if (err) { setError(err.message); setSaving(false) }
    else onSaved()
  }

  return (
    <Card className="mb-6 max-w-2xl">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{initial ? 'Edit works order' : 'New works order'}</h3>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label htmlFor="wo-property" className="text-sm font-medium">Property *</label>
            <select id="wo-property" required className={SELECT_CLASS} value={values.property_id} onChange={e => set('property_id', e.target.value)}>
              <option value="">Select property…</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="wo-type" className="text-sm font-medium">Order type</label>
            <select id="wo-type" className={SELECT_CLASS} value={values.order_type} onChange={e => set('order_type', e.target.value)}>
              {Object.entries(ORDER_TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2 space-y-1">
            <label htmlFor="wo-desc" className="text-sm font-medium">Description *</label>
            <Input
              id="wo-desc"
              required
              value={values.description}
              onChange={e => set('description', e.target.value)}
              placeholder="e.g. Fix communal lighting — 2nd floor"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="wo-priority" className="text-sm font-medium">Priority</label>
            <select id="wo-priority" className={SELECT_CLASS} value={values.priority} onChange={e => set('priority', e.target.value)}>
              <option value="emergency">Emergency</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="wo-status" className="text-sm font-medium">Status</label>
            <select id="wo-status" className={SELECT_CLASS} value={values.status} onChange={e => set('status', e.target.value)}>
              <option value="draft">Draft</option>
              <option value="dispatching">Dispatching</option>
              <option value="accepted">Accepted</option>
              <option value="in_progress">In Progress</option>
              <option value="complete">Complete</option>
              <option value="cancelled">Cancelled</option>
              <option value="disputed">Disputed</option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="wo-raised" className="text-sm font-medium">Raised date</label>
            <Input id="wo-raised" type="date" value={values.raised_date} onChange={e => set('raised_date', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="wo-reqby" className="text-sm font-medium">Required by</label>
            <Input id="wo-reqby" type="date" value={values.required_by} onChange={e => set('required_by', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="wo-cost" className="text-sm font-medium">Estimated cost (£)</label>
            <Input id="wo-cost" type="number" min="0" step="0.01" value={values.estimated_cost} onChange={e => set('estimated_cost', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="wo-contractor" className="text-sm font-medium">Contractor</label>
            <select id="wo-contractor" className={SELECT_CLASS} value={values.contractor_id} onChange={e => set('contractor_id', e.target.value)}>
              <option value="">Not assigned</option>
              {contractors.map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
            </select>
          </div>
          <div className="col-span-2 space-y-1">
            <label htmlFor="wo-notes" className="text-sm font-medium">Notes</label>
            <Input id="wo-notes" value={values.notes} onChange={e => set('notes', e.target.value)} />
          </div>
          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <div className="col-span-2 flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : initial ? 'Update' : 'Create order'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

// ── Dispatch Modal ──────────────────────────────────────────────────────────
// Priority → auto deadline hours
const PRIORITY_DEADLINE_HOURS: Record<string, number> = {
  emergency: 4,
  high:      24,
  normal:    48,
  low:       120,
}
const PRIORITY_DEADLINE_HINT: Record<string, string> = {
  emergency: 'Emergency priority — 4 hours',
  high:      'High priority — 24 hours',
  normal:    'Normal priority — 48 hours',
  low:       'Low priority — 5 days',
}

function DispatchModal({ firmId, order, contractors, onDispatched, onCancel }: {
  firmId: string
  order: WorksOrder
  contractors: Contractor[]
  /** emailSent = true if Resend call succeeded; false means dispatch is saved but no email was sent */
  onDispatched: (emailSent: boolean) => void
  onCancel: () => void
}) {
  const [contractorId, setContractorId] = useState(order.contractor_id ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Default response deadline driven by works order priority
  const priorityHours = PRIORITY_DEADLINE_HOURS[order.priority] ?? 48
  const defaultDeadline = new Date(Date.now() + priorityHours * 60 * 60 * 1000)
  const [deadlineDate, setDeadlineDate] = useState(defaultDeadline.toISOString().split('T')[0])

  async function handleDispatch() {
    if (!contractorId) { setError('Select a contractor to dispatch to.'); return }
    setSaving(true)
    setError(null)

    const token = crypto.randomUUID()
    const responseDeadline = new Date(deadlineDate + 'T23:59:59').toISOString()
    const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const now = new Date().toISOString()

    // Check how many previous dispatches exist (to set sequence_position correctly)
    const { count: prevCount } = await supabase
      .from('dispatch_log')
      .select('id', { count: 'exact', head: true })
      .eq('works_order_id', order.id)

    // Insert dispatch log and capture the generated ID for the email Edge Function
    const { data: logData, error: logErr } = await supabase
      .from('dispatch_log')
      .insert({
        firm_id: firmId,
        works_order_id: order.id,
        contractor_id: contractorId,
        sequence_position: (prevCount ?? 0) + 1,
        response_deadline: responseDeadline,
        token,
        token_expires_at: tokenExpiry,
        notified_via: 'email',
      })
      .select('id')
      .single()

    if (logErr || !logData) { setError(logErr?.message ?? 'Failed to create dispatch record'); setSaving(false); return }

    const { error: orderErr } = await supabase
      .from('works_orders')
      .update({
        status: 'dispatching',
        contractor_id: contractorId,
        dispatch_started_at: now,
      })
      .eq('id', order.id)

    if (orderErr) { setError(orderErr.message); setSaving(false); return }

    // Invoke dispatch-engine Edge Function to send the accept/decline email via Resend.
    // Email failure does NOT roll back the dispatch — the record is already saved.
    const { error: emailErr } = await supabase.functions.invoke('dispatch-engine', {
      body: { dispatch_log_id: logData.id },
    })

    if (emailErr) {
      console.warn('dispatch-engine email error:', emailErr.message)
    }

    onDispatched(!emailErr)
  }

  return (
    <Card className="mb-6 max-w-xl border-amber-200">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold flex items-center gap-2">
            <Send className="h-4 w-4 text-amber-600" />
            Dispatch works order
          </h3>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>
        <p className="text-sm text-muted-foreground mb-4 border-l-2 border-muted pl-3">
          {order.description}
        </p>
        <div className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="disp-contractor" className="text-sm font-medium">Contractor *</label>
            {contractors.length === 0 ? (
              <p className="text-sm text-amber-600">No approved contractors registered. Add contractors first.</p>
            ) : (
              <select
                id="disp-contractor"
                className={SELECT_CLASS}
                value={contractorId}
                onChange={e => setContractorId(e.target.value)}
              >
                <option value="">Select contractor…</option>
                {contractors.map(c => (
                  <option key={c.id} value={c.id}>{c.company_name}</option>
                ))}
              </select>
            )}
          </div>
          <div className="space-y-1">
            <label htmlFor="disp-deadline" className="text-sm font-medium">Response deadline</label>
            <Input
              id="disp-deadline"
              type="date"
              value={deadlineDate}
              min={new Date().toISOString().split('T')[0]}
              onChange={e => setDeadlineDate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Auto-set for {PRIORITY_DEADLINE_HINT[order.priority] ?? 'normal priority — 48 hours'}. You can adjust this.
            </p>
          </div>
          <p className="text-xs text-muted-foreground bg-muted/40 rounded px-3 py-2">
            <strong>Note:</strong> An accept/decline email will be sent to the contractor&apos;s
            registered email address. The contractor must have a valid email on file.
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button onClick={handleDispatch} disabled={saving || contractors.length === 0}>
              {saving ? 'Dispatching…' : 'Confirm dispatch'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Section 20 Tab
// ════════════════════════════════════════════════════════════════════════════
function Section20Tab({ firmId, properties, contractors, propMap }: {
  firmId: string
  properties: Property[]
  contractors: Contractor[]
  propMap: Map<string, string>
}) {
  const [consultations, setConsultations] = useState<Section20[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Section20 | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!firmId) return
    const { data } = await supabase
      .from('section20_consultations')
      .select('*')
      .eq('firm_id', firmId)
      .order('created_at', { ascending: false })
    setConsultations(data ?? [])
    setLoading(false)
  }, [firmId])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <p className="text-sm text-muted-foreground">
          LTA 1985 s.20 — qualifying works exceeding £250 per leaseholder require consultation
        </p>
        <Button size="sm" onClick={() => { setEditing(null); setShowForm(true) }}>
          <Plus className="h-4 w-4 mr-1" /> New consultation
        </Button>
      </div>

      {showForm && (
        <Section20Form
          firmId={firmId}
          properties={properties}
          contractors={contractors}
          initial={editing}
          onSaved={() => { setShowForm(false); setEditing(null); load() }}
          onCancel={() => { setShowForm(false); setEditing(null) }}
        />
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : consultations.length === 0 ? (
        <div className="text-center py-16">
          <Wrench className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No Section 20 consultations found.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {consultations.map(c => (
            <S20ConsultationCard
              key={c.id}
              consultation={c}
              firmId={firmId}
              contractors={contractors}
              propMap={propMap}
              expanded={expandedId === c.id}
              onToggleExpand={() => setExpandedId(expandedId === c.id ? null : c.id)}
              onEdit={() => { setEditing(c); setShowForm(true) }}
              onRefresh={load}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── S20 Consultation Card ────────────────────────────────────────────────────
function S20ConsultationCard({ consultation: c, firmId, contractors, propMap, expanded, onToggleExpand, onEdit, onRefresh }: {
  consultation: Section20
  firmId: string
  contractors: Contractor[]
  propMap: Map<string, string>
  expanded: boolean
  onToggleExpand: () => void
  onEdit: () => void
  onRefresh: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [nomContractorId, setNomContractorId] = useState(c.nominated_contractor_id ?? '')
  const [awardContractorId, setAwardContractorId] = useState(c.awarded_contractor_id ?? '')
  const [dispDecision, setDispDecision] = useState<'granted' | 'refused' | null>(null)
  const [showWithdrawConfirm, setShowWithdrawConfirm] = useState(false)

  const nextStatus  = getNextS20Status(c.status)
  const daysLeft    = s20ObservationDaysRemaining(c)
  const canAdvance  = nextStatus !== null && daysLeft === 0
  const isActive    = S20_ACTIVE.has(c.status)

  // Sync nomination dirty-check if the parent record refreshes
  const nomCId = c.nominated_contractor_id ?? ''

  async function advance() {
    if (!nextStatus || daysLeft > 0) return
    setSaving(true)
    const updates = buildS20StatusUpdate(c.status, nextStatus)
    // For awarded → need selected contractor
    if (c.status === 'stage2_closed' && !awardContractorId) {
      setSaving(false); return
    }
    const extra: Section20Update = {}
    if (c.status === 'stage2_closed') extra.awarded_contractor_id = awardContractorId
    await supabase
      .from('section20_consultations')
      .update({ status: nextStatus, ...updates, ...extra })
      .eq('id', c.id)
    setSaving(false)
    onRefresh()
  }

  async function saveNomination() {
    setSaving(true)
    await supabase
      .from('section20_consultations')
      .update({ nominated_contractor_id: nomContractorId || null })
      .eq('id', c.id)
    setSaving(false)
    onRefresh()
  }

  async function markDispensationDecision(granted: boolean) {
    setSaving(true)
    await supabase
      .from('section20_consultations')
      .update({ status: 'dispensation', dispensation_granted: granted })
      .eq('id', c.id)
    setSaving(false)
    setDispDecision(null)
    onRefresh()
  }

  async function withdraw() {
    setSaving(true)
    await supabase
      .from('section20_consultations')
      .update({ status: 'withdrawn' })
      .eq('id', c.id)
    setSaving(false)
    setShowWithdrawConfirm(false)
    onRefresh()
  }

  const contrMap = new Map(contractors.map(ct => [ct.id, ct.company_name]))

  return (
    <Card className="transition-shadow hover:shadow-sm">
      <CardContent className="p-5">
        {/* ── Header row ── */}
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="font-medium text-sm">{propMap.get(c.property_id) ?? '—'}</span>
              <Badge variant={S20_STATUS_VARIANT[c.status] ?? 'secondary'} className="text-xs">
                {S20_STATUS_LABELS[c.status] ?? c.status}
              </Badge>
              {c.threshold_exceeded && (
                <Badge variant="amber" className="text-xs">£250 threshold exceeded</Badge>
              )}
              {c.dispensation_applied && c.status !== 'dispensation' && (
                <Badge variant="outline" className="text-xs">Dispensation applied</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{c.works_description}</p>
            {c.estimated_cost != null && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Est. cost: £{Number(c.estimated_cost).toLocaleString('en-GB', { minimumFractionDigits: 2 })}
              </p>
            )}
          </div>
          <div className="flex gap-1 flex-shrink-0">
            <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Edit consultation">
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* ── Stage dates timeline ── */}
        {(c.stage1_notice_date || c.stage2_notice_date) && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground mb-3 border-l-2 border-muted pl-3">
            {c.stage1_notice_date && <span>Stage 1 issued: <strong>{formatDate(c.stage1_notice_date)}</strong></span>}
            {c.stage1_response_deadline && <span>S1 deadline: <strong>{formatDate(c.stage1_response_deadline)}</strong></span>}
            {c.stage1_closed_date && <span>S1 closed: <strong>{formatDate(c.stage1_closed_date)}</strong></span>}
            {c.stage2_notice_date && <span>Stage 2 issued: <strong>{formatDate(c.stage2_notice_date)}</strong></span>}
            {c.stage2_response_deadline && <span>S2 deadline: <strong>{formatDate(c.stage2_response_deadline)}</strong></span>}
            {c.stage2_closed_date && <span>S2 closed: <strong>{formatDate(c.stage2_closed_date)}</strong></span>}
          </div>
        )}

        {/* ── Observation period countdown ── */}
        {daysLeft > 0 && (
          <div className="flex items-center gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800 mb-3">
            <span className="font-semibold">⏱ {daysLeft} day{daysLeft !== 1 ? 's' : ''} remaining</span>
            <span className="text-amber-600">in the 30-day statutory observation period — consultation cannot be closed until this elapses.</span>
          </div>
        )}
        {(c.status === 'stage1_issued' || c.status === 'stage2_issued') && daysLeft === 0 && (
          <div className="flex items-center gap-2 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800 mb-3">
            ✓ 30-day observation period has elapsed — you may now close this stage.
          </div>
        )}

        {/* ── Dispensation decision (if applied and still active) ── */}
        {c.dispensation_applied && c.status !== 'dispensation' && c.dispensation_grounds && isActive && (
          <div className="rounded-md border border-muted bg-muted/30 px-3 py-2 text-sm mb-3">
            <p className="font-medium mb-1">Dispensation applied — grounds:</p>
            <p className="text-muted-foreground mb-2">{c.dispensation_grounds}</p>
            {dispDecision === null ? (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setDispDecision('granted')}>Record as Granted</Button>
                <Button size="sm" variant="outline" onClick={() => setDispDecision('refused')}>Record as Refused</Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm">Confirm dispensation was <strong>{dispDecision}</strong>?</span>
                <Button size="sm" variant="destructive" disabled={saving} onClick={() => markDispensationDecision(dispDecision === 'granted')}>Confirm</Button>
                <Button size="sm" variant="ghost" onClick={() => setDispDecision(null)}>Cancel</Button>
              </div>
            )}
          </div>
        )}

        {/* ── Dispensation result ── */}
        {c.status === 'dispensation' && (
          <div className="rounded-md border border-muted bg-muted/30 px-3 py-2 text-sm mb-3">
            <span className="font-medium">Dispensation: </span>
            {c.dispensation_granted === true && <span className="text-green-700 font-medium">Granted ✓</span>}
            {c.dispensation_granted === false && <span className="text-destructive font-medium">Refused — full s.20 process required</span>}
            {c.dispensation_granted === null && <span className="text-muted-foreground">Decision pending</span>}
            {c.dispensation_grounds && <p className="text-muted-foreground mt-1">Grounds: {c.dispensation_grounds}</p>}
          </div>
        )}

        {/* ── Contractor nomination (stage1_issued / stage1_closed) ── */}
        {(c.status === 'stage1_issued' || c.status === 'stage1_closed') && contractors.length > 0 && (
          <div className="flex items-center gap-2 mb-3">
            <label className="text-xs font-medium whitespace-nowrap text-muted-foreground">Nominated contractor:</label>
            <select
              className={cn(SELECT_CLASS, 'h-8 text-xs flex-1 max-w-xs')}
              value={nomContractorId}
              onChange={e => setNomContractorId(e.target.value)}
            >
              <option value="">None nominated by leaseholders</option>
              {contractors.map(ct => (
                <option key={ct.id} value={ct.id}>{ct.company_name}</option>
              ))}
            </select>
            {nomContractorId !== nomCId && (
              <Button size="sm" variant="outline" onClick={saveNomination} disabled={saving}>Save</Button>
            )}
          </div>
        )}
        {c.nominated_contractor_id && c.status !== 'stage1_issued' && c.status !== 'stage1_closed' && (
          <p className="text-xs text-muted-foreground mb-3">
            Nominated contractor: <strong>{contrMap.get(c.nominated_contractor_id) ?? '—'}</strong>
          </p>
        )}

        {/* ── Contractor award (stage2_closed) ── */}
        {c.status === 'stage2_closed' && contractors.length > 0 && (
          <div className="flex items-center gap-2 mb-3">
            <label className="text-xs font-medium whitespace-nowrap text-muted-foreground">Award contract to: *</label>
            <select
              className={cn(SELECT_CLASS, 'h-8 text-xs flex-1 max-w-xs')}
              value={awardContractorId}
              onChange={e => setAwardContractorId(e.target.value)}
            >
              <option value="">Select contractor…</option>
              {contractors.map(ct => (
                <option key={ct.id} value={ct.id}>{ct.company_name}</option>
              ))}
            </select>
          </div>
        )}
        {c.awarded_contractor_id && (c.status === 'awarded' || c.status === 'complete') && (
          <p className="text-xs text-muted-foreground mb-3">
            Awarded contractor: <strong>{contrMap.get(c.awarded_contractor_id) ?? '—'}</strong>
          </p>
        )}

        {/* ── Withdraw confirmation ── */}
        {showWithdrawConfirm && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm mb-3">
            <span>Withdraw this consultation? This cannot be undone.</span>
            <Button size="sm" variant="destructive" disabled={saving} onClick={withdraw}>Confirm withdraw</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowWithdrawConfirm(false)}>Cancel</Button>
          </div>
        )}

        {/* ── Actions row ── */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Main advance button */}
          {nextStatus && (
            <Button
              size="sm"
              disabled={!canAdvance || saving || (c.status === 'stage2_closed' && !awardContractorId)}
              onClick={advance}
              className="whitespace-nowrap"
              title={daysLeft > 0 ? `${daysLeft} days remaining in observation period` : undefined}
            >
              <ChevronRight className="h-3.5 w-3.5 mr-1" />
              {getNextS20Label(c.status)}
              {daysLeft > 0 && ` (${daysLeft}d)`}
            </Button>
          )}

          {/* Observations toggle */}
          {(c.status === 'stage1_issued' || c.status === 'stage2_issued' || expanded) && (
            <Button size="sm" variant="outline" onClick={onToggleExpand}>
              {expanded ? 'Hide observations' : 'Observations'}
            </Button>
          )}

          {/* Dispensation apply (if not already in terminal state) */}
          {isActive && !c.dispensation_applied && c.status !== 'dispensation' && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground text-xs"
              onClick={onEdit}
              title="Edit consultation to apply for dispensation (s.20ZA)"
            >
              Apply dispensation
            </Button>
          )}

          {/* Withdraw */}
          {isActive && !showWithdrawConfirm && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground text-xs ml-auto"
              onClick={() => setShowWithdrawConfirm(true)}
            >
              Withdraw
            </Button>
          )}
        </div>

        {/* ── Observations panel ── */}
        {expanded && (
          <div className="mt-4 border-t pt-4">
            <S20ObservationsPanel
              firmId={firmId}
              consultationId={c.id}
              stage={c.status === 'stage2_issued' ? 'stage2' : 'stage1'}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── S20 Observations Panel ───────────────────────────────────────────────────
function S20ObservationsPanel({ firmId, consultationId, stage }: {
  firmId: string
  consultationId: string
  stage: 'stage1' | 'stage2'
}) {
  const [observations, setObservations] = useState<S20Observation[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ leaseholder_name: '', received_date: new Date().toISOString().split('T')[0], content: '', nominated_contractor: '' })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('section20_observations')
      .select('*')
      .eq('consultation_id', consultationId)
      .order('received_date', { ascending: true })
    setObservations(data ?? [])
    setLoading(false)
  }, [consultationId])

  useEffect(() => { load() }, [load])

  async function addObservation(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    await supabase.from('section20_observations').insert({
      firm_id: firmId,
      consultation_id: consultationId,
      stage,
      received_date: form.received_date,
      content: form.content,
      nominated_contractor: form.nominated_contractor || null,
    })
    setSaving(false)
    setShowAdd(false)
    setForm({ leaseholder_name: '', received_date: new Date().toISOString().split('T')[0], content: '', nominated_contractor: '' })
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium">Leaseholder Observations — {stage === 'stage1' ? 'Stage 1' : 'Stage 2'}</h4>
        <Button size="sm" variant="outline" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add observation
        </Button>
      </div>

      {showAdd && (
        <form onSubmit={addObservation} className="rounded-md border bg-muted/20 p-4 mb-4 grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">Received date *</label>
            <Input type="date" required value={form.received_date} onChange={e => setForm(f => ({ ...f, received_date: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Nominated contractor (if named)</label>
            <Input placeholder="Contractor name, if any" value={form.nominated_contractor} onChange={e => setForm(f => ({ ...f, nominated_contractor: e.target.value }))} />
          </div>
          <div className="col-span-2 space-y-1">
            <label className="text-xs font-medium">Observation text *</label>
            <Input required placeholder="Record the leaseholder's observation…" value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} />
          </div>
          <div className="col-span-2 flex gap-2 justify-end">
            <Button type="button" size="sm" variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save observation'}</Button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : observations.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">No observations recorded yet.</p>
      ) : (
        <div className="space-y-2">
          {observations.map(obs => (
            <div key={obs.id} className="rounded-md border bg-background p-3 text-sm">
              <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                <span>Received: <strong>{formatDate(obs.received_date)}</strong></span>
                {obs.nominated_contractor && (
                  <Badge variant="outline" className="text-xs">Nominates: {obs.nominated_contractor}</Badge>
                )}
              </div>
              <p className="text-sm">{obs.content}</p>
              {obs.response_text && (
                <p className="text-xs text-muted-foreground mt-1 border-t pt-1">Response: {obs.response_text}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── S20 state machine helpers ────────────────────────────────────────────────
function getNextS20Status(current: string): string | null {
  const map: Record<string, string> = {
    stage1_pending: 'stage1_issued',
    stage1_issued:  'stage1_closed',
    stage1_closed:  'stage2_issued',
    stage2_issued:  'stage2_closed',
    stage2_closed:  'awarded',
    awarded:        'complete',
  }
  return map[current] ?? null
}

function getNextS20Label(current: string): string {
  const map: Record<string, string> = {
    stage1_pending: 'Issue Stage 1 Notice',
    stage1_issued:  'Close Stage 1',
    stage1_closed:  'Issue Stage 2 Notice',
    stage2_issued:  'Close Stage 2',
    stage2_closed:  'Award Contract',
    awarded:        'Mark Complete',
  }
  return map[current] ?? 'Advance'
}

function buildS20StatusUpdate(from: string, to: string): Section20Update {
  const today = new Date().toISOString().split('T')[0]
  // 30-day statutory consultation periods
  const plus30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  if (from === 'stage1_pending' && to === 'stage1_issued') {
    return { stage1_notice_date: today, stage1_response_deadline: plus30 }
  }
  if (from === 'stage1_issued' && to === 'stage1_closed') {
    return { stage1_closed_date: today }
  }
  if (from === 'stage1_closed' && to === 'stage2_issued') {
    return { stage2_notice_date: today, stage2_response_deadline: plus30 }
  }
  if (from === 'stage2_issued' && to === 'stage2_closed') {
    return { stage2_closed_date: today }
  }
  // awarded_contractor_id is set separately in S20ConsultationCard.advance()
  if (from === 'stage2_closed' && to === 'awarded') {
    return {}
  }
  return {}
}

// ── Section 20 Form ──────────────────────────────────────────────────────────
function Section20Form({ firmId, properties, contractors: _contractors, initial, onSaved, onCancel }: {
  firmId: string
  properties: Property[]
  contractors: Contractor[]
  initial: Section20 | null
  onSaved: () => void
  onCancel: () => void
}) {
  const { user } = useAuthStore()
  const [values, setValues] = useState({
    property_id: initial?.property_id ?? '',
    works_description: initial?.works_description ?? '',
    estimated_cost: initial?.estimated_cost != null ? String(initial.estimated_cost) : '',
    notes: initial?.notes ?? '',
    dispensation_applied: initial?.dispensation_applied ?? false,
    dispensation_grounds: initial?.dispensation_grounds ?? '',
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
      works_description: values.works_description,
      estimated_cost: values.estimated_cost ? parseFloat(values.estimated_cost) : null,
      notes: values.notes || null,
      dispensation_applied: values.dispensation_applied,
      dispensation_grounds: values.dispensation_grounds || null,
      created_by: initial ? undefined : user?.id ?? null,
    }
    let err: { message: string } | null = null
    if (initial) {
      ;({ error: err } = await supabase.from('section20_consultations').update(payload).eq('id', initial.id))
    } else {
      ;({ error: err } = await supabase.from('section20_consultations').insert(payload))
    }
    if (err) { setError(err.message); setSaving(false) }
    else onSaved()
  }

  return (
    <Card className="mb-6 max-w-2xl">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">{initial ? 'Edit consultation' : 'New Section 20 consultation'}</h3>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label htmlFor="s20-property" className="text-sm font-medium">Property *</label>
            <select id="s20-property" required className={SELECT_CLASS} value={values.property_id} onChange={e => set('property_id', e.target.value)}>
              <option value="">Select property…</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="s20-cost" className="text-sm font-medium">Estimated cost (£)</label>
            <Input
              id="s20-cost"
              type="number"
              min="0"
              step="0.01"
              value={values.estimated_cost}
              onChange={e => set('estimated_cost', e.target.value)}
              placeholder="e.g. 15000"
            />
          </div>
          <div className="col-span-2 space-y-1">
            <label htmlFor="s20-desc" className="text-sm font-medium">Works description *</label>
            <Input
              id="s20-desc"
              required
              value={values.works_description}
              onChange={e => set('works_description', e.target.value)}
              placeholder="e.g. External roof replacement — all blocks"
            />
          </div>
          <div className="col-span-2 space-y-1">
            <label htmlFor="s20-notes" className="text-sm font-medium">Notes</label>
            <Input id="s20-notes" value={values.notes} onChange={e => set('notes', e.target.value)} />
          </div>
          <div className="col-span-2 space-y-3 border-t pt-4">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                id="s20-dispensation"
                checked={values.dispensation_applied}
                onChange={e => set('dispensation_applied', e.target.checked)}
                className="h-4 w-4"
              />
              Apply for dispensation (LTA 1985 s.20ZA)
            </label>
            {values.dispensation_applied && (
              <div className="space-y-1">
                <label htmlFor="s20-grounds" className="text-sm font-medium">Dispensation grounds</label>
                <Input
                  id="s20-grounds"
                  value={values.dispensation_grounds}
                  onChange={e => set('dispensation_grounds', e.target.value)}
                  placeholder="State the grounds for dispensation…"
                />
              </div>
            )}
          </div>
          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <div className="col-span-2 flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : initial ? 'Update' : 'Create consultation'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
