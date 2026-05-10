/**
 * Auth setup — Senior PM (1i.3). Runs once before any test that uses the
 * senior_pm storage state. Logs in as senior_pm@propos.local and saves the
 * browser session.
 *
 * Pre-req: senior_pm@propos.local exists in auth.users + public.users + a
 * row in public.user_roles with role='senior_pm'.
 */
import { test as setup, expect } from '@playwright/test'
import path from 'path'

const authFile = path.join(import.meta.dirname, '../.auth/senior-pm-user.json')

setup('authenticate as demo senior PM', async ({ page }) => {
  await page.goto('/')
  await page.waitForURL('**/login')

  await page.getByLabel('Email').fill('senior_pm@propos.local')
  await page.getByLabel('Password').fill('PropOS2026!')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.waitForURL('**/dashboard', { timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await page.context().storageState({ path: authFile })
})
