/**
 * Auth setup — Property Manager. Runs once before any test that uses the PM
 * storage state. Logs in as pm@propos.local and saves the browser session.
 *
 * Pre-req: pm@propos.local exists in auth.users + public.users (created via
 * the Dashboard + supabase/seed/test_users.sql per DECISIONS 2026-05-10).
 */
import { test as setup, expect } from '@playwright/test'
import path from 'path'

const authFile = path.join(import.meta.dirname, '../.auth/pm-user.json')

setup('authenticate as demo property manager', async ({ page }) => {
  await page.goto('/')
  await page.waitForURL('**/login')

  await page.getByLabel('Email').fill('pm@propos.local')
  await page.getByLabel('Password').fill('PropOS2026!')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.waitForURL('**/dashboard', { timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await page.context().storageState({ path: authFile })
})
