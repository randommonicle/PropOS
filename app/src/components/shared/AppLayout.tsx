/**
 * @file AppLayout.tsx
 * @description Main application shell layout with sidebar navigation.
 * Responsible for: top-level layout chrome, nav links, user menu.
 * NOT responsible for: page content (rendered via <Outlet />), auth state.
 */
import { Link, Outlet, useLocation } from 'react-router-dom'
import {
  Building2, FileText, Wrench, ShieldCheck,
  Wallet, Users, LogOut, LayoutDashboard, FileArchive
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/properties', label: 'Properties', icon: Building2 },
  { to: '/compliance', label: 'Compliance', icon: ShieldCheck },
  { to: '/works', label: 'Works', icon: Wrench },
  { to: '/financial', label: 'Financial', icon: Wallet },
  { to: '/documents', label: 'Documents', icon: FileArchive },
  { to: '/reports', label: 'Reports', icon: FileText },
  { to: '/users', label: 'Users', icon: Users },
]

export function AppLayout() {
  const { firmContext, signOut } = useAuth()
  const location = useLocation()

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="w-64 flex-shrink-0 border-r bg-card flex flex-col">
        {/* Logo / firm name */}
        <div className="h-16 flex items-center px-6 border-b">
          <div>
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">PropOS</p>
            <p className="text-sm font-semibold truncate">{firmContext?.firmName ?? '—'}</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
          {navItems.map(({ to, label, icon: Icon }) => {
            const active = location.pathname.startsWith(to)
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {label}
              </Link>
            )
          })}
        </nav>

        {/* Sign out */}
        <div className="p-3 border-t">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground"
            onClick={signOut}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
