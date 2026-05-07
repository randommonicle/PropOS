/**
 * Smoke tests — Dashboard
 * Verifies: firm name, stat cards load, no auth errors.
 */
import { test, expect } from '@playwright/test'

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard')
  })

  test('shows firm name in sidebar', async ({ page }) => {
    // Sidebar renders as <aside> (role=complementary) — scope there to avoid
    // matching the identical firm name that also appears as a dashboard subtitle
    await expect(
      page.getByRole('complementary').getByText('Demo Property Management Ltd')
    ).toBeVisible()
  })

  test('stat cards load with data', async ({ page }) => {
    const main = page.getByRole('main')
    // '9 units' is unique to the Properties card sub-stat (seed: 3 props × 3 units)
    await expect(main.getByText('9 units')).toBeVisible()
    // The other cards should be present
    await expect(main.getByText('Open Works Orders')).toBeVisible()
    await expect(main.getByText('Compliance — Red')).toBeVisible()
    await expect(main.getByText('Compliance — Amber')).toBeVisible()
  })

  test('no 401 errors in network', async ({ page }) => {
    const authErrors: string[] = []
    page.on('response', res => {
      if (res.status() === 401) authErrors.push(res.url())
    })
    await page.goto('/dashboard')
    await page.waitForTimeout(2_000)
    expect(authErrors, `401 errors: ${authErrors.join(', ')}`).toHaveLength(0)
  })

  test('sidebar navigation links are present', async ({ page }) => {
    const nav = page.getByRole('complementary')
    for (const label of ['Properties', 'Compliance', 'Works', 'Financial', 'Documents', 'Reports', 'Users']) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible()
    }
  })
})
