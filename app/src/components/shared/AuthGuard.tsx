/**
 * @file AuthGuard.tsx
 * @description Route guard that redirects unauthenticated users to the login page.
 * Responsible for: protecting routes that require authentication.
 * NOT responsible for: role-based access control (see RoleGuard).
 *
 * FORWARD: Tier-1 hardening (commit 1i.1) made loadFirmContext source role +
 * firm_id from the JWT instead of public.users (SECURITY_AUDIT §H-7). With
 * signup disabled (§H-1) the only path to authenticated-without-context is an
 * admin-deactivated user (active=false → JWT hook returns no claims) or a race
 * between sign-in and the admin-driven public.users insert. Today this hits
 * the loading-state then redirects to login on the next refresh — adequate
 * but not friendly. Production replacement: render a "Your account is not
 * yet provisioned — contact your firm admin" banner when isAuthenticated &&
 * !firmContext, mirroring the "deactivated" UX. Anchor: SECURITY_AUDIT §H-7
 * + DECISIONS 2026-05-10 — Tier-1 security hardening (1i.1) UX rules.
 */
import { Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'

interface AuthGuardProps {
  children: React.ReactNode
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}
