/**
 * @file PropertiesPage.tsx
 * @description Property list view — all properties for the current firm.
 * Responsible for: listing properties, search/filter, link to detail page.
 * NOT responsible for: property creation (handled by PropertyForm), unit management.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, Card, CardContent, Input, Badge } from '@/components/ui'
import { Building2, Plus, Search } from 'lucide-react'
import type { Database } from '@/types/database'

type Property = Database['public']['Tables']['properties']['Row']

export function PropertiesPage() {
  const firmContext = useAuthStore(s => s.firmContext)
  const [properties, setProperties] = useState<Property[]>([])
  const [filtered, setFiltered] = useState<Property[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    if (!firmContext?.firmId) return
    loadProperties(firmContext.firmId)
  }, [firmContext?.firmId])

  useEffect(() => {
    const q = search.toLowerCase()
    setFiltered(
      properties.filter(
        p =>
          p.name.toLowerCase().includes(q) ||
          p.address_line1.toLowerCase().includes(q) ||
          p.postcode.toLowerCase().includes(q)
      )
    )
  }, [search, properties])

  async function loadProperties(firmId: string) {
    const { data } = await supabase
      .from('properties')
      .select('*')
      .eq('firm_id', firmId)
      .order('name')
    setProperties(data ?? [])
    setFiltered(data ?? [])
    setLoading(false)
  }

  return (
    <div>
      <PageHeader title="Properties" description="All properties managed by your firm">
        <Button size="sm" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4 mr-1" /> Add property
        </Button>
      </PageHeader>

      <div className="p-8">
        {showForm && (
          <PropertyForm
            firmId={firmContext!.firmId}
            onSaved={() => { setShowForm(false); loadProperties(firmContext!.firmId) }}
            onCancel={() => setShowForm(false)}
          />
        )}

        <div className="relative mb-6 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, address, or postcode…"
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {loading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Building2 className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground text-sm">No properties found.</p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map(property => (
              <Link key={property.id} to={`/properties/${property.id}`}>
                <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="font-semibold text-sm">{property.name}</h3>
                      {property.is_hrb && (
                        <Badge variant="amber" className="text-xs">HRB</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {property.address_line1}, {property.town}, {property.postcode}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 capitalize">
                      {property.property_type.replace('_', ' ')}
                      {property.total_units ? ` · ${property.total_units} units` : ''}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Property creation form
// ──────────────────────────────────────────────────────────────────────────────

interface PropertyFormProps {
  firmId: string
  onSaved: () => void
  onCancel: () => void
}

function PropertyForm({ firmId, onSaved, onCancel }: PropertyFormProps) {
  const [values, setValues] = useState({
    name: '',
    address_line1: '',
    address_line2: '',
    town: '',
    postcode: '',
    property_type: 'block',
    total_units: '',
    is_hrb: false,
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
    const { error } = await supabase.from('properties').insert({
      firm_id: firmId,
      name: values.name,
      address_line1: values.address_line1,
      address_line2: values.address_line2 || null,
      town: values.town,
      postcode: values.postcode.toUpperCase(),
      property_type: values.property_type,
      total_units: values.total_units ? parseInt(values.total_units, 10) : null,
      is_hrb: values.is_hrb,
    })
    if (error) {
      setError(error.message)
      setSaving(false)
    } else {
      onSaved()
    }
  }

  return (
    <Card className="mb-6 max-w-2xl">
      <CardContent className="p-6">
        <h3 className="font-semibold mb-4">New property</h3>
        <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-4">
          <div className="col-span-2 space-y-1">
            <label htmlFor="prop-name" className="text-sm font-medium">Property name *</label>
            <Input id="prop-name" required value={values.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Maple House" />
          </div>
          <div className="col-span-2 space-y-1">
            <label htmlFor="prop-addr1" className="text-sm font-medium">Address line 1 *</label>
            <Input id="prop-addr1" required value={values.address_line1} onChange={e => set('address_line1', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="prop-addr2" className="text-sm font-medium">Address line 2</label>
            <Input id="prop-addr2" value={values.address_line2} onChange={e => set('address_line2', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="prop-town" className="text-sm font-medium">Town *</label>
            <Input id="prop-town" required value={values.town} onChange={e => set('town', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="prop-postcode" className="text-sm font-medium">Postcode *</label>
            <Input id="prop-postcode" required value={values.postcode} onChange={e => set('postcode', e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor="prop-type" className="text-sm font-medium">Property type *</label>
            <select
              id="prop-type"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={values.property_type}
              onChange={e => set('property_type', e.target.value)}
            >
              <option value="block">Block</option>
              <option value="estate">Estate</option>
              <option value="mixed">Mixed</option>
              <option value="house">House</option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="prop-units" className="text-sm font-medium">Total units</label>
            <Input id="prop-units" type="number" min="0" value={values.total_units} onChange={e => set('total_units', e.target.value)} />
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <input
              type="checkbox"
              id="is_hrb"
              checked={values.is_hrb}
              onChange={e => set('is_hrb', e.target.checked)}
              className="h-4 w-4"
            />
            <label htmlFor="is_hrb" className="text-sm">Higher-Risk Building (HRB) — Building Safety Act 2022</label>
          </div>
          {error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
          <div className="col-span-2 flex gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save property'}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
