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
    // Step 1: log in and save auth state to disk
    {
      name: 'setup',
      testMatch: '**/auth.setup.ts',
    },
    // Step 2: run smoke tests using saved auth state
    {
      name: 'smoke',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],
})
