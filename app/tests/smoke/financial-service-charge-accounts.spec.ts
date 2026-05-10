/**
 * @file financial-service-charge-accounts.spec.ts
 * @description Smoke tests for the per-property Service charge accounts tab —
 * full CRUD, status state machine, finalised lock, and FK-blocked delete.
 * Cleanup unwinds budget_line_items → service_charge_accounts in FK-safe order.
 */
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './_env'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const SCA_NOTES_PREFIX = 'Smoke SCA'

async function goToFirstProperty(page: Page) {
  await page.goto('/properties')
  await page.locator('a[href^="/properties/"]').first().click()
  await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible()
}

async function goToServiceChargeAccountsTab(page: Page) {
  await page.getByRole('tab', { name: 'Service charge accounts' }).click()
  await expect(page.getByRole('tab', { name: 'Service charge accounts' })).toHaveAttribute(
    'data-state',
    'active',
  )
}

/**
 * Year picks for new SCAs — chosen sufficiently far in the future / past that
 * they will not collide with manually-created accounts in the dev project.
 * Uses the test invocation timestamp to keep each row uniquely identifiable
 * via the notes field.
 */
function uniqueYearPair(offsetYears: number): { start: string; end: string } {
  const base = 2200 + offsetYears
  return { start: `${base}-01-01`, end: `${base}-12-31` }
}

test.describe('Property detail — service charge accounts', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
    // FK-safe order: budget_line_items references service_charge_accounts.
    // We only seed budget_line_items in the FK-blocked test, but unwind unconditionally.
    const { data: scas } = await supabase
      .from('service_charge_accounts')
      .select('id')
      .like('notes', `${SCA_NOTES_PREFIX}%`)
    const ids = (scas ?? []).map(r => r.id)
    if (ids.length) {
      await supabase.from('budget_line_items').delete().in('account_id', ids)
    }
    await supabase.from('service_charge_accounts').delete().like('notes', `${SCA_NOTES_PREFIX}%`)
  })

  test('Service charge accounts tab updates the URL to ?tab=service-charge-accounts', async ({ page }) => {
    await goToFirstProperty(page)
    await goToServiceChargeAccountsTab(page)
    await expect(page).toHaveURL(/\?tab=service-charge-accounts/)
    await expect(page.getByRole('button', { name: 'Add service charge account' })).toBeVisible()
  })

  test('Heading and add button are visible', async ({ page }) => {
    await goToFirstProperty(page)
    await goToServiceChargeAccountsTab(page)
    await expect(page.getByRole('heading', { name: /^Service charge accounts/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add service charge account' })).toBeVisible()
  })

  test('service charge account create round-trip', async ({ page }) => {
    const note = `${SCA_NOTES_PREFIX} Create ${Date.now()}`
    const { start, end } = uniqueYearPair(0)
    await goToFirstProperty(page)
    await goToServiceChargeAccountsTab(page)

    await page.getByRole('button', { name: 'Add service charge account' }).click()
    await expect(page.getByRole('heading', { name: 'New service charge account' })).toBeVisible()

    await page.getByLabel('Year start *').fill(start)
    await page.getByLabel('Year end *').fill(end)

    // budget_total via MoneyInput — type, blur, expect canonical formatting.
    const budget = page.getByLabel('Budget total')
    await budget.fill('12345.67')
    await budget.blur()
    await expect(budget).toHaveValue('12,345.67')

    await page.getByLabel('Notes').fill(note)
    await page.getByRole('button', { name: 'Save service charge account' }).click()

    await expect(page.getByRole('heading', { name: 'New service charge account' })).not.toBeVisible()

    // Year label "2200" appears in the year column for the new row.
    await expect(page.getByRole('cell', { name: String(2200), exact: true })).toBeVisible()
    await expect(page.getByRole('main').getByText(/£12,345\.67/)).toBeVisible()
  })

  test('service charge account edit round-trip — notes update reflected', async ({ page }) => {
    const note    = `${SCA_NOTES_PREFIX} Edit ${Date.now()}`
    const updated = `${SCA_NOTES_PREFIX} Edited ${Date.now()}`
    const { start, end } = uniqueYearPair(1)
    await goToFirstProperty(page)
    await goToServiceChargeAccountsTab(page)

    // Create
    await page.getByRole('button', { name: 'Add service charge account' }).click()
    await page.getByLabel('Year start *').fill(start)
    await page.getByLabel('Year end *').fill(end)
    await page.getByLabel('Notes').fill(note)
    await page.getByRole('button', { name: 'Save service charge account' }).click()

    const yearCell = page.getByRole('cell', { name: '2201', exact: true })
    await expect(yearCell).toBeVisible()

    // Edit: locate the row by its year cell, then click Edit.
    const row = page.getByRole('main').locator('tr', { has: yearCell })
    await row.getByRole('button', { name: /Edit 2201 service charge account/ }).click()
    await expect(page.getByRole('heading', { name: 'Edit service charge account' })).toBeVisible()

    await page.getByLabel('Notes').clear()
    await page.getByLabel('Notes').fill(updated)
    await page.getByRole('button', { name: 'Update service charge account' }).click()

    await expect(page.getByRole('heading', { name: 'Edit service charge account' })).not.toBeVisible()

    // Reopen edit and confirm the notes field shows the updated value.
    const row2 = page.getByRole('main').locator('tr', { has: page.getByRole('cell', { name: '2201', exact: true }) })
    await row2.getByRole('button', { name: /Edit 2201 service charge account/ }).click()
    await expect(page.getByLabel('Notes')).toHaveValue(updated)
  })

  test('status state machine — draft → active → reconciling → finalised stamps finalised_at', async ({ page }) => {
    const note = `${SCA_NOTES_PREFIX} Status ${Date.now()}`
    const { start, end } = uniqueYearPair(2)
    await goToFirstProperty(page)
    await goToServiceChargeAccountsTab(page)

    // Create as draft (default).
    await page.getByRole('button', { name: 'Add service charge account' }).click()
    await page.getByLabel('Year start *').fill(start)
    await page.getByLabel('Year end *').fill(end)
    await page.getByLabel('Notes').fill(note)
    await page.getByRole('button', { name: 'Save service charge account' }).click()

    const yearCell = page.getByRole('cell', { name: '2202', exact: true })
    await expect(yearCell).toBeVisible()

    // Walk forward through the state machine via successive edits.
    for (const next of ['Active', 'Reconciling', 'Finalised'] as const) {
      const row = page.getByRole('main').locator('tr', { has: page.getByRole('cell', { name: '2202', exact: true }) })
      await row.getByRole('button', { name: /Edit 2202 service charge account/ }).click()
      await page.getByLabel('Status').selectOption(next)
      await page.getByRole('button', { name: 'Update service charge account' }).click()
      await expect(page.getByRole('heading', { name: 'Edit service charge account' })).not.toBeVisible()
    }

    // After finalisation: status cell shows the Finalised badge, and reopening the
    // row exposes the "Finalised <date>" metadata line — proving finalised_at was stamped.
    const finalRow = page.getByRole('main').locator('tr', { has: page.getByRole('cell', { name: '2202', exact: true }) })
    await expect(finalRow.getByRole('cell').filter({ hasText: /^Finalised$/ })).toBeVisible()

    await finalRow.getByRole('button', { name: /Edit 2202 service charge account/ }).click()
    await expect(page.getByRole('heading', { name: 'Edit service charge account' })).toBeVisible()
    // Match the formatted en-GB date prefixed by "Finalised " — this is unique to
    // the form's metadata line; the badge says only "Finalised" without a date.
    await expect(page.getByText(/Finalised \d{2}\/\d{2}\/\d{4}/)).toBeVisible()
  })

  test('finalised guard — opening a finalised account locks status, dates, budget; only notes editable', async ({ page }) => {
    // Seed directly: a finalised SCA with finalised_at populated.
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
    const { data: prop } = await supabase.from('properties').select('id, firm_id').limit(1).single()
    if (!prop) throw new Error('No properties found for smoke test')

    const note = `${SCA_NOTES_PREFIX} Lock ${Date.now()}`
    await supabase.from('service_charge_accounts').insert({
      firm_id: prop.firm_id,
      property_id: prop.id,
      account_year_start: '2203-01-01',
      account_year_end:   '2203-12-31',
      status: 'finalised',
      finalised_at: new Date().toISOString(),
      notes: note,
    })

    await page.goto(`/properties/${prop.id}?tab=service-charge-accounts`)
    const row = page.getByRole('main').locator('tr', { has: page.getByRole('cell', { name: '2203', exact: true }) })
    await row.getByRole('button', { name: /Edit 2203 service charge account/ }).click()
    await expect(page.getByRole('heading', { name: 'Edit service charge account' })).toBeVisible()

    // Lock note surfaces.
    await expect(page.getByText(/finalised accounts cannot be reverted/i)).toBeVisible()

    // Locked controls.
    await expect(page.getByLabel('Year start *')).toBeDisabled()
    await expect(page.getByLabel('Year end *')).toBeDisabled()
    await expect(page.getByLabel('Budget total')).toBeDisabled()
    await expect(page.getByLabel('Status')).toBeDisabled()

    // Notes still editable.
    await expect(page.getByLabel('Notes')).not.toBeDisabled()
  })

  test('draft account delete shows inline confirmation then removes row', async ({ page }) => {
    const note = `${SCA_NOTES_PREFIX} Del ${Date.now()}`
    const { start, end } = uniqueYearPair(4)
    await goToFirstProperty(page)
    await goToServiceChargeAccountsTab(page)

    await page.getByRole('button', { name: 'Add service charge account' }).click()
    await page.getByLabel('Year start *').fill(start)
    await page.getByLabel('Year end *').fill(end)
    await page.getByLabel('Notes').fill(note)
    await page.getByRole('button', { name: 'Save service charge account' }).click()

    const yearCell = page.getByRole('cell', { name: '2204', exact: true })
    await expect(yearCell).toBeVisible()

    const row = page.getByRole('main').locator('tr', { has: page.getByRole('cell', { name: '2204', exact: true }) })
    await row.getByRole('button', { name: /Delete 2204 service charge account/ }).click()
    await expect(page.getByRole('button', { name: 'Confirm delete' })).toBeVisible()

    await page.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(page.getByRole('cell', { name: '2204', exact: true })).not.toBeVisible()
  })

  test('non-draft account cannot be hard-deleted (RICS Rule 3.7 evidence trail; TPI)', async ({ page }) => {
    // Seed: an active SCA with a budget_line_items child to also exercise the FK
    // path. The pre-FK guard fires first because status != draft.
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
    const { data: prop } = await supabase.from('properties').select('id, firm_id').limit(1).single()
    if (!prop) throw new Error('No properties found for smoke test')

    const note = `${SCA_NOTES_PREFIX} FK ${Date.now()}`
    const { data: sca } = await supabase
      .from('service_charge_accounts')
      .insert({
        firm_id: prop.firm_id,
        property_id: prop.id,
        account_year_start: '2205-01-01',
        account_year_end:   '2205-12-31',
        status: 'active',
        notes: note,
      })
      .select('id')
      .single()
    if (!sca) throw new Error('Failed to seed service_charge_accounts row')

    await supabase.from('budget_line_items').insert({
      firm_id: prop.firm_id,
      account_id: sca.id,
      category: 'Smoke FK guard',
      budgeted_amount: 0,
      actual_amount: 0,
    })

    await page.goto(`/properties/${prop.id}?tab=service-charge-accounts`)
    const row = page.getByRole('main').locator('tr', { has: page.getByRole('cell', { name: '2205', exact: true }) })
    await row.getByRole('button', { name: /Delete 2205 service charge account/ }).click()
    await page.getByRole('button', { name: 'Confirm delete' }).click()

    // Status guard fires first — message names RICS Rule 3.7 evidence trail
    // and TPI Consumer Charter & Standards Edition 3 (canonical anchors per
    // audit Tier-1 R-4).
    await expect(page.getByText(/RICS Rule 3\.7 evidence trail/i)).toBeVisible()
    await expect(page.getByRole('cell', { name: '2205', exact: true })).toBeVisible()
  })
})
