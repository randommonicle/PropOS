/**
 * @file _env.ts
 * @description Required-env helper for the smoke test runner.
 * Tier-1 security hardening (commit 1i.1 / SECURITY_AUDIT §H-6) replaced the
 * `process.env.X ?? '<publishable-key-fallback>'` pattern across every spec
 * with calls to requireEnv(). The fallback embedded the publishable key + the
 * project URL in git history, making both stable identifiers for the project
 * (rate-limit/quota burning vector even though the key intentionally enforces
 * RLS only). Failing fast at module load keeps a missing env var from looking
 * like a smoke regression.
 *
 * Set via `app/.env.local` (gitignored) or via the shell environment when
 * running smokes from CI. The two required values are VITE_SUPABASE_URL and
 * VITE_SUPABASE_ANON_KEY — same names the Vite app uses, so a single
 * `.env.local` covers both the dev server and the smoke runner.
 */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
      `Copy app/.env.local from the main repo or set it in your shell. ` +
      `See SECURITY_AUDIT_2026-05-10.md §H-6 for the rationale.`
    )
  }
  return value
}

export const SUPABASE_URL      = requireEnv('VITE_SUPABASE_URL')
export const SUPABASE_ANON_KEY = requireEnv('VITE_SUPABASE_ANON_KEY')
