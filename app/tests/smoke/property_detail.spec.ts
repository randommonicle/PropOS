/**
 * @file property_detail.spec.ts
 * @description Smoke tests for the property detail page — units and leaseholders CRUD.
 * Covers: unit create, edit, delete (with confirmation); leaseholder create, edit,
 * mark-as-ended, delete (with confirmation); FK constraint error surfacing.
 *
 * afterAll hooks clean up in FK-safe order: leaseholders first, then units.
 */
import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL ?? 'https://tmngfuonanizxyffrsjy.supabase.co',
  process.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_M_cBRZKdJtIunGAUFBhD1g_SYMADNyT',
)

// ── Helper: navigate to the first property detail page ────────────────────────
async function goToFirstProperty(page: Parameters<typeof test>[1]) {
  await page.goto('/properties')
  // Click the first property card link
  await page.locator('a[href^="/properties/"]').first().click()
  // Wait for the page to settle — heading should show the property name
  await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible()
}

// ── Helper: switch to a specific tab on the property detail page ─────────────
// PropertyDetailPage uses Radix Tabs (`?tab=overview|units|leaseholders`).
// Tab triggers expose role=tab, so we click the named tab and wait for the
// active panel to be present before returning.
async function goToTab(
  page: Parameters<typeof test>[1],
  tab: 'Overview' | 'Units' | 'Leaseholders',
) {
  await page.getByRole('tab', { name: tab }).click()
  await expect(page.getByRole('tab', { name: tab })).toHaveAttribute('data-state', 'active')
}

// ════════════════════════════════════════════════════════════════════════════
// Units
// ════════════════════════════════════════════════════════════════════════════
test.describe('Property detail — units', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
    // All unit-test smoke refs start with 'Smoke U'
    await supabase.from('units').delete().like('unit_ref', 'Smoke U%')
  })

  test('units section heading and add button are visible', async ({ page }) => {
    await goToFirstProperty(page)
    await goToTab(page, 'Units')
    // Scope to <h2> — the tab trigger also has text "Units" so a plain text match
    // would resolve to two elements under strict mode.
    await expect(page.getByRole('heading', { name: /^Units/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add unit' })).toBeVisible()
  })

  test('unit create round-trip', async ({ page }) => {
    const marker = `Smoke U${Date.now()}`
    await goToFirstProperty(page)
    await goToTab(page, 'Units')

    await page.getByRole('button', { name: 'Add unit' }).click()
    await expect(page.getByRole('heading', { name: 'New unit' })).toBeVisible()

    // Required field
    await page.getByLabel('Unit ref *').fill(marker)

    // Optional lease fields
    await page.getByLabel('Lease term (years)').fill('125')
    await page.getByLabel('Ground rent (£/yr)').fill('250')

    await page.getByRole('button', { name: 'Save unit' }).click()

    // Form closes and new unit appears in table
    await expect(page.getByRole('heading', { name: 'New unit' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(marker)).toBeVisible()
  })

  test('unit edit round-trip', async ({ page }) => {
    const original = `Smoke U Edit ${Date.now()}`
    const updated  = `Smoke U Edited ${Date.now()}`
    await goToFirstProperty(page)
    await goToTab(page, 'Units')

    // Create a unit to edit
    await page.getByRole('button', { name: 'Add unit' }).click()
    await page.getByLabel('Unit ref *').fill(original)
    await page.getByRole('button', { name: 'Save unit' }).click()
    await expect(page.getByRole('main').getByText(original)).toBeVisible()

    // Click the edit (pencil) button for this unit
    const row = page.getByRole('main').locator('tr', { has: page.getByText(original) })
    await row.getByRole('button').filter({ has: page.locator('svg') }).first().click()

    // Form should open pre-populated
    await expect(page.getByRole('heading', { name: 'Edit unit' })).toBeVisible()

    // Clear and re-fill unit ref
    await page.getByLabel('Unit ref *').clear()
    await page.getByLabel('Unit ref *').fill(updated)
    await page.getByRole('button', { name: 'Update unit' }).click()

    await expect(page.getByRole('heading', { name: 'Edit unit' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(updated)).toBeVisible()
  })

  test('unit delete shows inline confirmation then removes row', async ({ page }) => {
    const marker = `Smoke U Del ${Date.now()}`
    await goToFirstProperty(page)
    await goToTab(page, 'Units')

    // Create a unit to delete
    await page.getByRole('button', { name: 'Add unit' }).click()
    await page.getByLabel('Unit ref *').fill(marker)
    await page.getByRole('button', { name: 'Save unit' }).click()
    await expect(page.getByRole('main').getByText(marker)).toBeVisible()

    // Click the delete (trash) button — confirmation row should appear
    const row = page.getByRole('main').locator('tr', { has: page.getByText(marker) })
    await row.getByRole('button', { name: /delete/i }).click()
    await expect(page.getByRole('button', { name: 'Confirm delete' })).toBeVisible()

    // Cancel first — unit should still be there
    await page.getByRole('button', { name: 'Cancel' }).first().click()
    await expect(page.getByRole('main').getByText(marker)).toBeVisible()

    // Now confirm delete
    const row2 = page.getByRole('main').locator('tr', { has: page.getByText(marker) })
    await row2.getByRole('button', { name: /delete/i }).click()
    await page.getByRole('button', { name: 'Confirm delete' }).click()

    // Unit should be gone — use cell locator to avoid matching the <strong> in the confirmation row
    await expect(page.getByRole('cell', { name: marker, exact: true })).not.toBeVisible()
  })

})

// ════════════════════════════════════════════════════════════════════════════
// Leaseholders
// ════════════════════════════════════════════════════════════════════════════
test.describe('Property detail — leaseholders', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })

    // Delete leaseholders BEFORE units (FK constraint)
    await Promise.all([
      supabase.from('leaseholders').delete().like('full_name', 'Smoke LH %'),
      supabase.from('leaseholders').delete().like('full_name', 'LH Edit%'),
      supabase.from('leaseholders').delete().like('full_name', 'LHPerson%'),
    ])

    // Now safe to delete the units created by leaseholder tests
    await Promise.all([
      supabase.from('units').delete().like('unit_ref', 'Smoke LH%'),
      supabase.from('units').delete().like('unit_ref', 'SmokeUnit%'),
    ])
  })

  test('leaseholders section heading and add button are visible', async ({ page }) => {
    await goToFirstProperty(page)
    await goToTab(page, 'Leaseholders')
    // Scope to <h2> — the tab trigger also has text "Leaseholders".
    await expect(page.getByRole('heading', { name: /^Leaseholders/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add leaseholder' })).toBeVisible()
  })

  test('leaseholder create round-trip', async ({ page }) => {
    const unitRef = `Smoke LH Unit ${Date.now()}`
    const lhName  = `Smoke LH ${Date.now()}`
    await goToFirstProperty(page)

    // Create a unit first so the leaseholder form has a unit to assign to
    await goToTab(page, 'Units')
    await page.getByRole('button', { name: 'Add unit' }).click()
    await page.getByLabel('Unit ref *').fill(unitRef)
    await page.getByRole('button', { name: 'Save unit' }).click()
    await expect(page.getByRole('main').getByText(unitRef)).toBeVisible()

    // Now create a leaseholder
    await goToTab(page, 'Leaseholders')
    await page.getByRole('button', { name: 'Add leaseholder' }).click()
    await expect(page.getByRole('heading', { name: 'New leaseholder' })).toBeVisible()

    // Select the unit we just created
    await page.getByLabel('Unit *').selectOption({ label: unitRef })
    await page.getByLabel(/Full name \*/).fill(lhName)

    await page.getByRole('button', { name: 'Save leaseholder' }).click()

    await expect(page.getByRole('heading', { name: 'New leaseholder' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(lhName)).toBeVisible()
  })

  test('leaseholder edit round-trip', async ({ page }) => {
    const unitRef  = `Smoke LH Eu ${Date.now()}`
    const original = `LH Edit Orig ${Date.now()}`
    const updated  = `LH Edit Upd  ${Date.now()}`
    await goToFirstProperty(page)

    // Create unit + leaseholder
    await goToTab(page, 'Units')
    await page.getByRole('button', { name: 'Add unit' }).click()
    await page.getByLabel('Unit ref *').fill(unitRef)
    await page.getByRole('button', { name: 'Save unit' }).click()

    await goToTab(page, 'Leaseholders')
    await page.getByRole('button', { name: 'Add leaseholder' }).click()
    await page.getByLabel('Unit *').selectOption({ label: unitRef })
    await page.getByLabel(/Full name \*/).fill(original)
    await page.getByRole('button', { name: 'Save leaseholder' }).click()
    await expect(page.getByRole('main').getByText(original)).toBeVisible()

    // Edit the leaseholder
    const row = page.getByRole('main').locator('tr', { has: page.getByText(original) })
    await row.getByRole('button', { name: /edit/i }).first().click()
    await expect(page.getByRole('heading', { name: 'Edit leaseholder' })).toBeVisible()

    await page.getByLabel(/Full name \*/).clear()
    await page.getByLabel(/Full name \*/).fill(updated)
    await page.getByRole('button', { name: 'Update leaseholder' }).click()

    await expect(page.getByRole('heading', { name: 'Edit leaseholder' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(updated)).toBeVisible()
  })

  test('leaseholder mark-as-ended preserves record in historical view', async ({ page }) => {
    const unitRef = `SmokeUnit${Date.now()}`
    // lhName must NOT contain "end" as a substring — the End button aria-label is
    // "End {lhName}" and /end/i would otherwise also match Edit and Delete buttons
    // (which include lhName in their aria-label).
    const lhName  = `LHPerson${Date.now()}`
    await goToFirstProperty(page)

    // Create unit + leaseholder
    await goToTab(page, 'Units')
    await page.getByRole('button', { name: 'Add unit' }).click()
    await page.getByLabel('Unit ref *').fill(unitRef)
    await page.getByRole('button', { name: 'Save unit' }).click()

    await goToTab(page, 'Leaseholders')
    await page.getByRole('button', { name: 'Add leaseholder' }).click()
    await page.getByLabel('Unit *').selectOption({ label: unitRef })
    await page.getByLabel(/Full name \*/).fill(lhName)
    await page.getByRole('button', { name: 'Save leaseholder' }).click()
    await expect(page.getByRole('main').getByText(lhName)).toBeVisible()

    // Mark as ended (X / amber button)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(lhName) })
    await row.getByRole('button', { name: /end/i }).click()

    // Should disappear from the default (current-only) view
    await expect(page.getByRole('main').getByText(lhName)).not.toBeVisible()

    // Show historical — record should reappear with Ended status
    await page.getByText('Show historical').click()
    await expect(page.getByRole('main').getByText(lhName)).toBeVisible()
    // Scope to the specific row to avoid strict-mode errors from other ended leaseholders
    const endedRow = page.getByRole('main').locator('tr', { has: page.getByText(lhName) })
    await expect(endedRow.getByText(/Ended/)).toBeVisible()
  })

  test('leaseholder delete shows inline confirmation then removes row', async ({ page }) => {
    const unitRef = `SmokeUnitDel${Date.now()}`
    const lhName  = `LHPersonDel${Date.now()}`
    await goToFirstProperty(page)

    // Create unit + leaseholder
    await goToTab(page, 'Units')
    await page.getByRole('button', { name: 'Add unit' }).click()
    await page.getByLabel('Unit ref *').fill(unitRef)
    await page.getByRole('button', { name: 'Save unit' }).click()

    await goToTab(page, 'Leaseholders')
    await page.getByRole('button', { name: 'Add leaseholder' }).click()
    await page.getByLabel('Unit *').selectOption({ label: unitRef })
    await page.getByLabel(/Full name \*/).fill(lhName)
    await page.getByRole('button', { name: 'Save leaseholder' }).click()
    await expect(page.getByRole('main').getByText(lhName)).toBeVisible()

    // Click delete
    const row = page.getByRole('main').locator('tr', { has: page.getByText(lhName) })
    await row.getByRole('button', { name: /delete/i }).click()
    await expect(page.getByRole('button', { name: 'Confirm delete' })).toBeVisible()

    // Confirm
    await page.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(page.getByRole('cell', { name: lhName, exact: true })).not.toBeVisible()
  })

})

// ════════════════════════════════════════════════════════════════════════════
// Tab navigation
// PropertyDetailPage uses Radix Tabs with `?tab=` URL sync. The default tab is
// 'overview'; switching tabs updates the URL and shows the corresponding panel.
// ════════════════════════════════════════════════════════════════════════════
test.describe('Property detail — tabs', () => {
  test('lands on overview by default and shows property details', async ({ page }) => {
    await goToFirstProperty(page)
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('data-state', 'active')
    await expect(page.getByRole('main').getByText('Property details')).toBeVisible()
  })

  test('clicking Units tab reveals the units add button and updates the URL', async ({ page }) => {
    await goToFirstProperty(page)
    await goToTab(page, 'Units')
    await expect(page.getByRole('button', { name: 'Add unit' })).toBeVisible()
    await expect(page).toHaveURL(/\?tab=units/)
  })

  test('clicking Leaseholders tab reveals the leaseholders add button and updates the URL', async ({ page }) => {
    await goToFirstProperty(page)
    await goToTab(page, 'Leaseholders')
    await expect(page.getByRole('button', { name: 'Add leaseholder' })).toBeVisible()
    await expect(page).toHaveURL(/\?tab=leaseholders/)
  })
})
