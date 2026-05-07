/**
 * Smoke tests — Documents module
 * Verifies: page loads, upload UI present, filter controls visible.
 */
import { test, expect } from '@playwright/test'

test.describe('Documents', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/documents')
  })

  test('documents page loads', async ({ page }) => {
    // Page title is 'Document Vault' — the sidebar link says 'Documents' (different)
    await expect(page.getByRole('heading', { name: 'Document Vault' })).toBeVisible()
  })

  test('upload button is present', async ({ page }) => {
    await expect(page.getByRole('button', { name: /upload/i })).toBeVisible()
  })

  test('document type filter is present', async ({ page }) => {
    await expect(page.getByRole('combobox')).toBeVisible()
  })
})
