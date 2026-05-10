/**
 * @file useAuth.ts
 * @description React hook for authentication actions and state.
 * Responsible for: sign in, sign out, session bootstrap, and exposing auth state.
 * NOT responsible for: routing after auth (handled by AuthGuard component).
 *
 * Trust model (Tier-1 security hardening commit 1i.1 / SECURITY_AUDIT §H-7):
 *   firm_id and role are read from the JWT claims, NOT from public.users.
 *   The JWT custom_access_token_hook (00014-00016) is the authoritative source —
 *   it reads public.users server-side under SECURITY DEFINER and stamps the
 *   claims into the access token. Re-reading public.users from the client would
 *   bypass that authority, allowing any user with WRITE on their own row to
 *   reflect a forged role/firm_id immediately client-side (the now-closed C-1
 *   exploit shape). Trusting the JWT means a role change requires a token
 *   refresh (jwt_expiry = 600s post-1i.1) before it propagates — that latency
 *   IS the security guarantee.
 *
 *   firms.name remains a public.firms read because the firm name is non-
 *   sensitive display text, and putting it in the JWT would either bloat
 *   every request or require a hook update on every firm rename.
 */
import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { UserRole } from '@/lib/constants'
import type { Session } from '@supabase/supabase-js'

interface AccessTokenClaims {
  firm_id?: string
  user_role?: string
}

// Decode the access-token JWT payload. JWTs are base64url-encoded; the standard
// atob() handles the base64 portion after URL-decoding (- → +, _ → /, padding).
// Decode failure is silent (returns {}) — AuthGuard will block render until
// firmContext is set, so a malformed token shows the loading state, never a
// half-authenticated screen.
function decodeAccessTokenClaims(session: Session | null): AccessTokenClaims {
  if (!session?.access_token) return {}
  const parts = session.access_token.split('.')
  if (parts.length !== 3) return {}
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    return JSON.parse(atob(padded)) as AccessTokenClaims
  } catch {
    return {}
  }
}

export function useAuth() {
  const { session, user, firmContext, isLoading, setSession, setUser, setFirmContext, setLoading, clear } =
    useAuthStore()

  useEffect(() => {
    // Bootstrap: get the current session on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session) {
        loadFirmContext(session)
      } else {
        setLoading(false)
      }
    })

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session) {
        loadFirmContext(session)
      } else {
        clear()
      }
    })

    return () => subscription.unsubscribe()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadFirmContext(session: Session) {
    const claims = decodeAccessTokenClaims(session)
    const firmId = claims.firm_id ?? null
    const role = claims.user_role ?? null

    // No claims → user is authenticated but unprovisioned (no public.users row,
    // or active=false). firmContext stays null; AuthGuard blocks render. The
    // user-visible "Your account is not yet provisioned" banner is FORWARD —
    // see AuthGuard.tsx FORWARD note.
    if (!firmId || !role) {
      setFirmContext(null)
      setLoading(false)
      return
    }

    const { data: firmData } = await supabase
      .from('firms')
      .select('name')
      .eq('id', firmId)
      .single()

    setFirmContext({
      firmId,
      firmName: firmData?.name ?? '',
      role: role as UserRole,
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
