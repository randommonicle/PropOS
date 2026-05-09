/**
 * Worktree-local Playwright config — overrides baseURL to a port that does not
 * collide with the main repo's running dev server. Used by the build engineer
 * when running smoke tests against an isolated worktree dev server (typically
 * on 5174). Do NOT commit results from this config; CI uses playwright.config.ts.
 */
import baseConfig from './playwright.config'
import { defineConfig } from '@playwright/test'

const url = process.env.WORKTREE_BASE_URL ?? 'http://127.0.0.1:5174'

export default defineConfig({
  ...baseConfig,
  use: { ...baseConfig.use, baseURL: url },
  webServer: undefined,
})
