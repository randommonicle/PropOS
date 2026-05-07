/**
 * @file PropertyDetailPage.tsx
 * @description Property detail view — property info, units list, leaseholders.
 * Responsible for: displaying and editing property, managing units and leaseholders.
 * NOT responsible for: financial data (Financial module), compliance items (Compliance module).
 */
import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageHeader } from '@/components/shared/PageHeader'
import { Card, CardContent, CardHeader, CardTitle, Button, Badge, Input } from '@/components/ui'
import { ChevronLeft, Plus } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { formatPounds } from '@/lib/money'
import type { Database } from '@/types/database'

type Property = Database['public']['Tables']['properties']['Row']
type Unit = Database['public']['Tables']['units']['Row']
type Leaseholder = Database['public']['Tables']['leaseholders']['Row']

export function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>()
  const firmContext = useAuthStore(s => s.firmContext)
  const [property, setProperty] = useState<Property | null>(null)
  const [units, setUnits] = useState<Unit[]>([])
  const [leaseholders, setLeaseholders] = useState<Leaseholder[]>([])
  const [loading, setLoading] = useState(true)
  const [showUnitForm, setShowUnitForm] = useState(false)

  useEffect(() => {
    if (!id) return
    loadAll(id)
  }, [id])

  async function loadAll(propertyId: string) {
    const [propRes, unitsRes, lhRes] = await Promise.all([
      supabase.from('properties').select('*').eq('id', propertyId).single(),
      supabase.from('units').select('*').eq('property_id', propertyId).order('unit_ref'),
      supabase.from('leaseholders').select('*').eq('property_id', propertyId).eq('is_current', true).order('full_name'),
    ])
    setProperty(propRes.data)
    setUnits(unitsRes.data ?? [])
    setLeaseholders(lhRes.data ?? [])
    setLoading(false)
  }

  if (loading) return <div className="p-8 text-muted-foreground text-sm">Loading…</div>
  if (!property) return <div className="p-8 text-muted-foreground text-sm">Property not found.</div>

  return (
    <div>
      <PageHeader title={property.name} description={`${property.address_line1}, ${property.town}, ${property.postcode}`}>
        <Link to="/properties">
          <Button variant="outline" size="sm">
            <ChevronLeft className="h-4 w-4 mr-1" /> Properties
          </Button>
        </Link>
      </PageHeader>

      <div className="p-8 space-y-8">
        {/* Property info */}
        <Card>
          <CardHeader><CardTitle className="text-base">Property details</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <Field label="Type" value={property.property_type} />
              <Field label="Total units" value={property.total_units?.toString() ?? '—'} />
              <Field label="Build year" value={property.build_year?.toString() ?? '—'} />
              <Field label="Listed status" value={property.listed_status ?? '—'} />
              <Field label="Freeholder" value={property.freeholder_name ?? '—'} />
              <Field label="Managing since" value={formatDate(property.managing_since)} />
              <Field label="HRB" value={property.is_hrb ? 'Yes — BSA applies' : 'No'} />
              {property.is_hrb && (
                <Field label="Storeys" value={property.storey_count?.toString() ?? '—'} />
              )}
              {property.is_hrb && (
                <Field label="Height (m)" value={property.height_metres?.toString() ?? '—'} />
              )}
            </dl>
          </CardContent>
        </Card>

        {/* Units */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Units ({units.length})</h2>
            <Button size="sm" onClick={() => setShowUnitForm(true)}>
              <Plus className="h-4 w-4 mr-1" /> Add unit
            </Button>
          </div>

          {showUnitForm && (
            <UnitForm
              firmId={firmContext!.firmId}
              propertyId={property.id}
              onSaved={() => { setShowUnitForm(false); loadAll(property.id) }}
              onCancel={() => setShowUnitForm(false)}
            />
          )}

          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Unit ref</th>
                  <th className="text-left px-4 py-2 font-medium">Type</th>
                  <th className="text-left px-4 py-2 font-medium">Floor</th>
                  <th className="text-left px-4 py-2 font-medium">Ground rent</th>
                  <th className="text-left px-4 py-2 font-medium">Lease end</th>
                </tr>
              </thead>
              <tbody>
                {units.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">No units added yet.</td></tr>
                ) : (
                  units.map(unit => (
                    <tr key={unit.id} className="border-t">
                      <td className="px-4 py-2 font-medium">{unit.unit_ref}</td>
                      <td className="px-4 py-2 capitalize">{unit.unit_type}</td>
                      <td className="px-4 py-2">{unit.floor ?? '—'}</td>
                      <td className="px-4 py-2">{unit.ground_rent_pa ? formatPounds(unit.ground_rent_pa) + '/yr' : '—'}</td>
                      <td className="px-4 py-2">{formatDate(unit.lease_end)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Leaseholders */}
        <div>
          <h2 className="font-semibold mb-4">Current leaseholders ({leaseholders.length})</h2>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Name</th>
                  <th className="text-left px-4 py-2 font-medium">Email</th>
                  <th className="text-left px-4 py-2 font-medium">Phone</th>
                  <th className="text-left px-4 py-2 font-medium">Resident</th>
                  <th className="text-left px-4 py-2 font-medium">Portal</th>
                </tr>
              </thead>
              <tbody>
                {leaseholders.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">No leaseholders recorded.</td></tr>
                ) : (
                  leaseholders.map(lh => (
                    <tr key={lh.id} className="border-t">
                      <td className="px-4 py-2">{lh.full_name}</td>
                      <td className="px-4 py-2">{lh.email ?? '—'}</td>
                      <td className="px-4 py-2">{lh.phone ?? '—'}</td>
                      <td className="px-4 py-2">
                        <Badge variant={lh.is_resident ? 'green' : 'secondary'}>{lh.is_resident ? 'Yes' : 'No'}</Badge>
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={lh.portal_access ? 'green' : 'secondary'}>{lh.portal_access ? 'Active' : 'None'}</Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground mb-0.5">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Unit creation form
// ──────────────────────────────────────────────────────────────────────────────

interface UnitFormProps {
  firmId: string
  propertyId: string
  onSaved: () => void
  onCancel: () => void
}

function UnitForm({ firmId, propertyId, onSaved, onCancel }: UnitFormProps) {
  const [values, setValues] = useState({ unit_ref: '', unit_type: 'flat', floor: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const { error } = await supabase.from('units').insert({
      firm_id: firmId,
      property_id: propertyId,
      unit_ref: values.unit_ref,
      unit_type: values.unit_type,
      floor: values.floor ? parseInt(values.floor, 10) : null,
    })
    if (error) { setError(error.message); setSaving(false) }
    else onSaved()
  }

  return (
    <Card className="mb-4 max-w-lg">
      <CardContent className="p-4">
        <h4 className="font-medium mb-3 text-sm">New unit</h4>
        <form onSubmit={handleSubmit} className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">Unit ref *</label>
            <Input required placeholder="Flat 4" value={values.unit_ref} onChange={e => setValues(v => ({ ...v, unit_ref: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Type</label>
            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={values.unit_type} onChange={e => setValues(v => ({ ...v, unit_type: e.target.value }))}>
              <option value="flat">Flat</option>
              <option value="house">House</option>
              <option value="commercial">Commercial</option>
              <option value="parking">Parking</option>
              <option value="storage">Storage</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Floor</label>
            <Input type="number" placeholder="0" value={values.floor} onChange={e => setValues(v => ({ ...v, floor: e.target.value }))} />
          </div>
          {error && <p className="col-span-3 text-xs text-destructive">{error}</p>}
          <div className="col-span-3 flex gap-2 justify-end">
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
            <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save unit'}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
