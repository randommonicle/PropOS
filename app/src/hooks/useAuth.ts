/**
 * @file useAuth.ts
 * @description React hook for authentication actions and state.
 * Responsible for: sign in, sign out, session bootstrap, and exposing auth state.
 * NOT responsible for: routing after auth (handled by AuthGuard component).
 */
import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { UserRole } from '@/lib/constants'

export function useAuth() {
  const { session, user, firmContext, isLoading, setSession, setUser, setFirmContext, setLoading, clear } =
    useAuthStore()

  useEffect(() => {
    // Bootstrap: get the current session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user) {
        loadFirmContext(session.user.id)
      } else {
        setLoading(false)
      }
    })

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user) {
        loadFirmContext(session.user.id)
      } else {
        clear()
      }
    })

    return () => subscription.unsubscribe()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadFirmContext(userId: string) {
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('firm_id, role')
      .eq('id', userId)
      .single()

    if (userError || !userData) {
      setLoading(false)
      return
    }

    const { data: firmData } = await supabase
      .from('firms')
      .select('name')
      .eq('id', userData.firm_id)
      .single()

    setFirmContext({
      firmId: userData.firm_id,
      firmName: firmData?.name ?? '',
      role: userData.role as UserRole,
    })
    setLoading(false)
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  async function signOut() {
    await supabase.auth.signOut()
    clear()
  }

  return {
    session,
    user,
    firmContext,
    isLoading,
    isAuthenticated: !!session,
    signIn,
    signOut,
  }
}
