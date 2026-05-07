/**
 * @file DashboardPage.tsx
 * @description PropOS main dashboard — summary cards across all modules.
 * Responsible for: high-level metrics display (property count, compliance RAG, open works orders).
 * NOT responsible for: detailed module views (each module handles its own pages).
 */
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { PageHeader } from '@/components/shared/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { Building2, ShieldCheck, Wrench, AlertTriangle } from 'lucide-react'
import { ragStatus, daysUntil } from '@/lib/utils'

interface DashboardStats {
  propertyCount: number
  unitCount: number
  openWorksOrders: number
  redCompliance: number
  amberCompliance: number
}

export function DashboardPage() {
  const firmContext = useAuthStore(s => s.firmContext)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!firmContext?.firmId) return
    loadStats(firmContext.firmId)
  }, [firmContext?.firmId])

  async function loadStats(firmId: string) {
    const [properties, units, works, compliance] = await Promise.all([
      supabase.from('properties').select('id', { count: 'exact', head: true }).eq('firm_id', firmId),
      supabase.from('units').select('id', { count: 'exact', head: true }).eq('firm_id', firmId),
      supabase.from('works_orders')
        .select('id', { count: 'exact', head: true })
        .eq('firm_id', firmId)
        .in('status', ['draft', 'dispatching', 'accepted', 'in_progress']),
      supabase.from('compliance_items')
        .select('expiry_date')
        .eq('firm_id', firmId)
        .neq('status', 'not_applicable'),
    ])

    let red = 0
    let amber = 0
    for (const item of (compliance.data ?? [])) {
      const rag = ragStatus(daysUntil(item.expiry_date))
      if (rag === 'red') red++
      else if (rag === 'amber') amber++
    }

    setStats({
      propertyCount: properties.count ?? 0,
      unitCount: units.count ?? 0,
      openWorksOrders: works.count ?? 0,
      redCompliance: red,
      amberCompliance: amber,
    })
    setLoading(false)
  }

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description={firmContext?.firmName ?? 'Loading…'}
      />
      <div className="p-8">
        {loading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <StatCard
              icon={<Building2 className="h-5 w-5 text-primary" />}
              label="Properties"
              value={stats?.propertyCount ?? 0}
              sub={`${stats?.unitCount ?? 0} units`}
            />
            <StatCard
              icon={<Wrench className="h-5 w-5 text-blue-600" />}
              label="Open Works Orders"
              value={stats?.openWorksOrders ?? 0}
            />
            <StatCard
              icon={<AlertTriangle className="h-5 w-5 text-red-600" />}
              label="Compliance — Red"
              value={stats?.redCompliance ?? 0}
              valueClass="text-red-600"
            />
            <StatCard
              icon={<ShieldCheck className="h-5 w-5 text-amber-600" />}
              label="Compliance — Amber"
              value={stats?.amberCompliance ?? 0}
              valueClass="text-amber-600"
            />
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({
  icon, label, value, sub, valueClass,
}: {
  icon: React.ReactNode
  label: string
  value: number
  sub?: string
  valueClass?: string
}) {
  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <p className={`text-3xl font-bold ${valueClass ?? ''}`}>{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  )
}
