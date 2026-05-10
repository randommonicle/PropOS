/**
 * Auth setup — Accounts (1i.3 / Phase 3 — function-split). Runs once before
 * any test that uses the accounts storage state. Logs in as
 * accounts@propos.local and saves the browser session.
 *
 * Pre-req: accounts@propos.local exists in auth.users + public.users + a
 * row in public.user_roles with role='accounts' (Dashboard +
 * supabase/seed/test_users.sql).
 */
import { test as setup, expect } from '@playwright/test'
import path from 'path'

const authFile = path.join(import.meta.dirname, '../.auth/accounts-user.json')

setup('authenticate as demo accounts staff', async ({ page }) => {
  await page.goto('/')
  await page.waitForURL('**/login')

  await page.getByLabel('Email').fill('accounts@propos.local')
  await page.getByLabel('Password').fill('PropOS2026!')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.waitForURL('**/dashboard', { timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await page.context().storageState({ path: authFile })
})
