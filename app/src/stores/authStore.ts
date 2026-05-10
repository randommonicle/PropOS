/**
 * @file authStore.ts
 * @description Zustand store for authentication state.
 * Responsible for: storing the current Supabase session, user, and firm context.
 * NOT responsible for: triggering auth actions (use useAuth hook for that),
 *   API calls (use the Supabase client directly or via React Query).
 */
import { create } from 'zustand'
import type { Session, User } from '@supabase/supabase-js'
import type { UserRole } from '@/lib/constants'

interface FirmContext {
  firmId: string
  firmName: string
  /**
   * All roles the authenticated user holds (1i.3 — populated from the
   * `user_roles` JWT array claim emitted by 00029's custom_access_token_hook).
   * Consumers should gate on this via the typed helpers in `@/lib/constants`
   * (hasAdminRole, hasPmRole, etc.) so multi-role membership works correctly.
   */
  roles: UserRole[]
  /**
   * Priority-picked first role, kept for backwards-compat with unswept
   * call-sites during the 1i.3 transition. Removed in the cleanup commit
   * alongside the legacy `user_role` JWT claim (FORWARD: PROD-GATE — 00029
   * step 4). New code should consume `roles` via the helpers, not `role`.
   *
   * @deprecated since 1i.3 phase 2 — use `roles` + the typed helpers.
   */
  role: UserRole
}

interface AuthState {
  session: Session | null
  user: User | null
  firmContext: FirmContext | null
  isLoading: boolean
  setSession: (session: Session | null) => void
  setUser: (user: User | null) => void
  setFirmContext: (context: FirmContext | null) => void
  setLoading: (loading: boolean) => void
  clear: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  user: null,
  firmContext: null,
  isLoading: true,
  setSession: (session) => set({ session }),
  setUser: (user) => set({ user }),
  setFirmContext: (firmContext) => set({ firmContext }),
  setLoading: (isLoading) => set({ isLoading }),
  clear: () => set({ session: null, user: null, firmContext: null, isLoading: false }),
}))
