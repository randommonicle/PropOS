/**
 * Playwright configuration for PropOS smoke tests.
 * Runs headless Chromium against the local Vite dev server.
 * Auth state is captured once in auth.setup.ts and reused across all tests.
 *
 * Usage:
 *   npm run test:smoke          — headless (CI-style)
 *   npm run test:smoke:headed   — with browser visible (debugging)
 *   npm run test:smoke:ui       — interactive Playwright UI
 */
import { defineConfig, devices } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Tier-1 security hardening (commit 1i.1 / SECURITY_AUDIT §H-6) removed the
// publishable-key fallback from every smoke spec. The smoke runner now
// requires VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY in the environment.
// Vite loads .env.local for the dev server automatically; the Playwright
// process is separate and needs its own load. Tiny inline parser keeps us
// dependency-free (no dotenv install needed).
const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  }
}

export default defineConfig({
  testDir: './tests/smoke',
  fullyParallel: false,   // sequential — single user session against real Supabase
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    headless: true,
  },

  // Auto-start the Vite dev server if not already running
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,   // use already-running server if available
    timeout: 30_000,
  },

  projects: [
    // Step 1: log in as admin and save auth state to disk
    {
      name: 'setup',
      testMatch: '**/auth.setup.ts',
    },
    // Step 1b: log in as the demo property manager and save its auth state.
    // Tests that exercise cross-user flows (e.g. payment authorisations where
    // a PM requests and an admin authorises) override storageState locally
    // via test.use({ storageState: 'tests/.auth/pm-user.json' }).
    {
      name: 'setup-pm',
      testMatch: '**/auth-pm.setup.ts',
    },
    // 1i.3 — three new test users for the function-split + multi-role smokes.
    // accounts: queues invoices for payment / requests payment_payee_setup.
    // senior_pm: PM-tier with override authority (re-open closed periods).
    // auditor: read-only across financial + audit-log tables.
    { name: 'setup-accounts',  testMatch: '**/auth-accounts.setup.ts' },
    { name: 'setup-senior-pm', testMatch: '**/auth-senior-pm.setup.ts' },
    { name: 'setup-auditor',   testMatch: '**/auth-auditor.setup.ts' },
    // Step 2: run smoke tests using saved admin auth state by default.
    {
      name: 'smoke',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/.auth/user.json',
      },
      dependencies: ['setup', 'setup-pm', 'setup-accounts', 'setup-senior-pm', 'setup-auditor'],
    },
  ],
})
