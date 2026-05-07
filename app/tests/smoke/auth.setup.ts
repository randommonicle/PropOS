/**
 * Auth setup — runs once before all smoke tests.
 * Logs in with the demo admin account and saves browser storage state
 * so subsequent tests skip the login flow.
 */
import { test as setup, expect } from '@playwright/test'
import path from 'path'

// import.meta.dirname is the ESM equivalent of __dirname (Node 20.11+)
const authFile = path.join(import.meta.dirname, '../.auth/user.json')

setup('authenticate as demo admin', async ({ page }) => {
  await page.goto('/')

  // Should redirect to /login
  await page.waitForURL('**/login')

  await page.getByLabel('Email').fill('admin@propos.local')
  await page.getByLabel('Password').fill('PropOS2026!')
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Wait for redirect to dashboard — confirms JWT hook injected firm_id correctly
  await page.waitForURL('**/dashboard', { timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  // Save auth state (cookies + localStorage) for reuse
  await page.context().storageState({ path: authFile })
})
