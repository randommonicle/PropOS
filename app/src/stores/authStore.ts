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
