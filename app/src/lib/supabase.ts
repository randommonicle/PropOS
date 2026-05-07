/**
 * @file supabase.ts
 * @description Supabase client configuration for PropOS frontend.
 * Responsible for: initialising and exporting the typed Supabase client.
 * NOT responsible for: auth session management (handled by AuthProvider),
 *   server-side operations (handled by Edge Functions using the service role key).
 *
 * The client uses the anon (publishable) key. All data access is governed by
 * Row-Level Security policies on the Supabase project.
 */
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. Ensure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.'
  )
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
})
