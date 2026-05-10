/**
 * Auth setup — Auditor (1i.3). Runs once before any test that uses the
 * auditor storage state. Logs in as auditor@propos.local and saves the
 * browser session.
 *
 * Pre-req: auditor@propos.local exists in auth.users + public.users + a
 * row in public.user_roles with role='auditor'.
 */
import { test as setup, expect } from '@playwright/test'
import path from 'path'

const authFile = path.join(import.meta.dirname, '../.auth/auditor-user.json')

setup('authenticate as demo auditor', async ({ page }) => {
  await page.goto('/')
  await page.waitForURL('**/login')

  await page.getByLabel('Email').fill('auditor@propos.local')
  await page.getByLabel('Password').fill('PropOS2026!')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.waitForURL('**/dashboard', { timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()

  await page.context().storageState({ path: authFile })
})
