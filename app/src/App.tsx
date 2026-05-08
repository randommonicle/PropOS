/**
 * @file App.tsx
 * @description Root application component — defines the React Router route tree.
 * Responsible for: routing, authentication gates, lazy module loading.
 * NOT responsible for: data fetching, business logic.
 */
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthGuard } from '@/components/shared/AuthGuard'
import { AppLayout } from '@/components/shared/AppLayout'
import { LoginPage } from '@/components/modules/properties/LoginPage'
import { DashboardPage } from '@/components/modules/properties/DashboardPage'
import { PropertiesPage } from '@/components/modules/properties/PropertiesPage'
import { PropertyDetailPage } from '@/components/modules/properties/PropertyDetailPage'
import { DocumentsPage } from '@/components/modules/documents/DocumentsPage'
import { CompliancePage } from '@/components/modules/compliance/CompliancePage'
import { ContractorsPage } from '@/components/modules/contractors/ContractorsPage'
import { WorksPage } from '@/components/modules/works/WorksPage'

// Placeholder for modules built in later phases
function ComingSoon({ name }: { name: string }) {
  return (
    <div className="p-8">
      <p className="text-muted-foreground text-sm">{name} — coming in a later phase.</p>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <AuthGuard>
              <AppLayout />
            </AuthGuard>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="properties" element={<PropertiesPage />} />
          <Route path="properties/:id" element={<PropertyDetailPage />} />
          <Route path="compliance" element={<CompliancePage />} />
          <Route path="contractors" element={<ContractorsPage />} />
          <Route path="works" element={<WorksPage />} />
          <Route path="financial" element={<ComingSoon name="Financial" />} />
          <Route path="documents" element={<DocumentsPage />} />
          <Route path="reports" element={<ComingSoon name="Reports" />} />
          <Route path="users" element={<ComingSoon name="Users" />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
