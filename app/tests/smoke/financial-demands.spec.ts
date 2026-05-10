/**
 * @file financial-demands.spec.ts
 * @description Smoke tests for the per-property Demands tab — full CRUD, the
 * LTA 1985 s.21B client guard, the status state machine, the paid lock, and
 * FK-safe deletion. Cleanup unwinds transactions → demands in FK-safe order.
 */
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './_env'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const NOTES_PREFIX = 'Smoke DEM'

async function goToFirstProperty(page: Page) {
  await page.goto('/properties')
  await page.locator('a[href^="/properties/"]').first().click()
  await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible()
}

async function goToDemandsTab(page: Page) {
  await page.getByRole('tab', { name: 'Demands' }).click()
  await expect(page.getByRole('tab', { name: 'Demands' })).toHaveAttribute(
    'data-state',
    'active',
  )
}

/**
 * Locate a demand row by its unit_ref AND amount. Both seeded test demands and
 * any pre-existing demands share the unit_ref, so we additionally filter by
 * amount which is chosen unique per test. This avoids the brittle `.first()`
 * chains that silently pick a row when more than one matches.
 */
function rowByUnitAndAmount(page: Page, unitRef: string, amountPounds: number) {
  const amountText = `£${amountPounds.toFixed(2)}`
  return page.getByRole('main').locator('tr', {
    has: page.getByRole('cell', { name: unitRef, exact: true }),
  }).filter({ hasText: amountText })
}

/**
 * Resolve a property + unit + current leaseholder triplet via Supabase. The
 * dev seed has properties and units but does NOT seed leaseholders, so the
 * helper inserts a test-scoped leaseholder against the first property's first
 * unit. The leaseholder is prefixed in `notes` so afterAll can clean it up
 * after demands have been removed.
 */
async function resolveSeedTriplet() {
  await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
  const { data: prop } = await supabase
    .from('properties').select('id, firm_id').limit(1).single()
  if (!prop) throw new Error('No properties found for smoke test')
  const { data: unit } = await supabase
    .from('units').select('id, unit_ref').eq('property_id', prop.id).limit(1).single()
  if (!unit) throw new Error(`No units found for property ${prop.id}`)

  // Reuse an existing test-scoped leaseholder when re-running locally; otherwise insert one.
  const { data: existing } = await supabase
    .from('leaseholders')
    .select('id, full_name')
    .eq('property_id', prop.id).eq('unit_id', unit.id).eq('is_current', true)
    .like('notes', `${NOTES_PREFIX}%`)
    .limit(1).maybeSingle()
  if (existing) return { prop, unit, lh: existing }

  const { data: created, error } = await supabase
    .from('leaseholders')
    .insert({
      firm_id: prop.firm_id, property_id: prop.id, unit_id: unit.id,
      full_name: 'Smoke DEM Leaseholder',
      is_current: true, is_resident: false, is_company: false,
      portal_access: false,
      notes: `${NOTES_PREFIX} seed leaseholder`,
    })
    .select('id, full_name').single()
  if (error || !created) throw new Error(`Failed to seed leaseholder: ${error?.message}`)
  return { prop, unit, lh: created }
}

test.describe('Property detail — demands', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
    // FK-safe order: transactions → demands. We don't seed transactions in 1d
    // but we unwind unconditionally in case future tests add them.
    const { data: dems } = await supabase
      .from('demands').select('id').like('notes', `${NOTES_PREFIX}%`)
    const ids = (dems ?? []).map(r => r.id)
    if (ids.length) {
      await supabase.from('transactions').delete().in('demand_id', ids)
    }
    await supabase.from('demands').delete().like('notes', `${NOTES_PREFIX}%`)
    // Remove the helper-seeded leaseholder last (FK-safe — its demands are gone).
    await supabase.from('leaseholders').delete().like('notes', `${NOTES_PREFIX}%`)
  })

  test('Demands tab updates the URL to ?tab=demands', async ({ page }) => {
    await goToFirstProperty(page)
    await goToDemandsTab(page)
    await expect(page).toHaveURL(/\?tab=demands/)
    await expect(page.getByRole('button', { name: 'Add demand' })).toBeVisible()
  })

  test('Heading and add button are visible', async ({ page }) => {
    await goToFirstProperty(page)
    await goToDemandsTab(page)
    await expect(page.getByRole('heading', { name: /^Demands/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add demand' })).toBeVisible()
  })

  test('demand create round-trip — leaseholder picker filters to selected unit', async ({ page }) => {
    const { prop, unit, lh } = await resolveSeedTriplet()
    const note = `${NOTES_PREFIX} Create ${Date.now()}`
    await page.goto(`/properties/${prop.id}?tab=demands`)

    await page.getByRole('button', { name: 'Add demand' }).click()
    await expect(page.getByRole('heading', { name: 'New demand' })).toBeVisible()

    // Before unit selected: leaseholder select is disabled.
    await expect(page.getByLabel('Leaseholder *')).toBeDisabled()

    await page.getByLabel('Unit *').selectOption(unit.id)
    await expect(page.getByLabel('Leaseholder *')).toBeEnabled()
    await page.getByLabel('Leaseholder *').selectOption(lh.id)

    await page.getByLabel('Demand type *').selectOption('Service Charge')

    const amount = page.getByLabel('Amount *')
    await amount.fill('456.78')
    await amount.blur()
    await expect(amount).toHaveValue('456.78')

    await page.getByLabel('Notes').fill(note)
    await page.getByRole('button', { name: 'Save demand' }).click()

    await expect(page.getByRole('heading', { name: 'New demand' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(/£456\.78/).first()).toBeVisible()
  })

  test('demand edit round-trip — notes update reflected on reopen', async ({ page }) => {
    const { prop, unit, lh } = await resolveSeedTriplet()
    const note    = `${NOTES_PREFIX} Edit ${Date.now()}`
    const updated = `${NOTES_PREFIX} Edited ${Date.now()}`

    await supabase.from('demands').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      unit_id: unit.id, leaseholder_id: lh.id,
      demand_type: 'service_charge', amount: 100,
      status: 'draft', notes: note,
    })

    await page.goto(`/properties/${prop.id}?tab=demands`)
    const editName = `Edit ${unit.unit_ref} service_charge demand`
    const row = rowByUnitAndAmount(page, unit.unit_ref, 100)
    await row.getByRole('button', { name: editName }).click()
    await expect(page.getByRole('heading', { name: 'Edit demand' })).toBeVisible()

    await page.getByLabel('Notes').clear()
    await page.getByLabel('Notes').fill(updated)
    await page.getByRole('button', { name: 'Update demand' }).click()
    await expect(page.getByRole('heading', { name: 'Edit demand' })).not.toBeVisible()

    // Reopen and confirm — re-derive the row locator after the form closed.
    await rowByUnitAndAmount(page, unit.unit_ref, 100)
      .getByRole('button', { name: editName }).click()
    await expect(page.getByLabel('Notes')).toHaveValue(updated)
  })

  test('LTA s.21B guard — issuing without s21b_attached is rejected', async ({ page }) => {
    const { prop, unit, lh } = await resolveSeedTriplet()
    const note = `${NOTES_PREFIX} S21B-status ${Date.now()}`
    await page.goto(`/properties/${prop.id}?tab=demands`)

    await page.getByRole('button', { name: 'Add demand' }).click()
    await page.getByLabel('Unit *').selectOption(unit.id)
    await page.getByLabel('Leaseholder *').selectOption(lh.id)
    await page.getByLabel('Amount *').fill('1.00')
    await page.getByLabel('Status').selectOption('Issued')
    await page.getByLabel('Notes').fill(note)
    // Do NOT tick s21b_attached.

    await page.getByRole('button', { name: 'Save demand' }).click()

    // Inline error names LTA 1985 s.21B; form remains open.
    await expect(page.getByText(/Cannot issue this demand: LTA 1985 s\.21B/i)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'New demand' })).toBeVisible()

    // Tick the box and re-save — now succeeds.
    await page.getByLabel(/Section 21B summary attached/).check()
    await page.getByRole('button', { name: 'Save demand' }).click()
    await expect(page.getByRole('heading', { name: 'New demand' })).not.toBeVisible()
  })

  test('LTA s.21B guard — setting issued_date without s21b_attached is rejected', async ({ page }) => {
    const { prop, unit, lh } = await resolveSeedTriplet()
    const note = `${NOTES_PREFIX} S21B-date ${Date.now()}`
    await page.goto(`/properties/${prop.id}?tab=demands`)

    await page.getByRole('button', { name: 'Add demand' }).click()
    await page.getByLabel('Unit *').selectOption(unit.id)
    await page.getByLabel('Leaseholder *').selectOption(lh.id)
    await page.getByLabel('Amount *').fill('1.00')
    // Status stays draft, but issued_date is being set — the s.21B guard fires.
    await page.getByLabel('Issued date').fill('2026-06-01')
    await page.getByLabel('Notes').fill(note)
    await page.getByRole('button', { name: 'Save demand' }).click()

    await expect(page.getByText(/Cannot issue this demand: LTA 1985 s\.21B/i)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'New demand' })).toBeVisible()
  })

  test('status state machine — draft → issued auto-stamps issued_date', async ({ page }) => {
    const { prop, unit, lh } = await resolveSeedTriplet()
    const note = `${NOTES_PREFIX} StateMachine ${Date.now()}`

    // Seed a draft demand directly.
    const { data: dem } = await supabase
      .from('demands')
      .insert({
        firm_id: prop.firm_id, property_id: prop.id,
        unit_id: unit.id, leaseholder_id: lh.id,
        demand_type: 'service_charge', amount: 250,
        status: 'draft', notes: note,
      })
      .select('id')
      .single()
    if (!dem) throw new Error('Failed to seed demand row')

    await page.goto(`/properties/${prop.id}?tab=demands`)
    const row = rowByUnitAndAmount(page, unit.unit_ref, 250)
    await row.getByRole('button', { name: `Edit ${unit.unit_ref} service_charge demand` }).click()

    await page.getByLabel(/Section 21B summary attached/).check()
    await page.getByLabel('Status').selectOption('Issued')
    await page.getByRole('button', { name: 'Update demand' }).click()
    await expect(page.getByRole('heading', { name: 'Edit demand' })).not.toBeVisible()

    // The DB row has issued_date populated.
    const { data: refreshed } = await supabase
      .from('demands').select('issued_date, status').eq('id', dem.id).single()
    expect(refreshed?.status).toBe('issued')
    expect(refreshed?.issued_date).toBeTruthy()
  })

  test('paid lock — opening a paid demand locks all fields except notes', async ({ page }) => {
    const { prop, unit, lh } = await resolveSeedTriplet()
    const note = `${NOTES_PREFIX} PaidLock ${Date.now()}`

    await supabase.from('demands').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      unit_id: unit.id, leaseholder_id: lh.id,
      demand_type: 'service_charge', amount: 999,
      status: 'paid', s21b_attached: true,
      issued_date: '2026-04-01', notes: note,
    })

    await page.goto(`/properties/${prop.id}?tab=demands`)
    const row = rowByUnitAndAmount(page, unit.unit_ref, 999)
    await row.getByRole('button', { name: `Edit ${unit.unit_ref} service_charge demand` }).click()
    await expect(page.getByRole('heading', { name: 'Edit demand' })).toBeVisible()

    // Lock note surfaces.
    await expect(page.getByText(/paid demands cannot be edited/i)).toBeVisible()

    // Locked controls.
    await expect(page.getByLabel('Unit *')).toBeDisabled()
    await expect(page.getByLabel('Leaseholder *')).toBeDisabled()
    await expect(page.getByLabel('Demand type *')).toBeDisabled()
    await expect(page.getByLabel('Amount *')).toBeDisabled()
    await expect(page.getByLabel('Status')).toBeDisabled()
    await expect(page.getByLabel(/Section 21B summary attached/)).toBeDisabled()
    await expect(page.getByLabel('Issued date')).toBeDisabled()
    await expect(page.getByLabel('Due date')).toBeDisabled()

    // Notes still editable.
    await expect(page.getByLabel('Notes')).not.toBeDisabled()
  })

  test('draft demand delete shows inline confirmation then removes row', async ({ page }) => {
    const { prop, unit, lh } = await resolveSeedTriplet()
    const note = `${NOTES_PREFIX} Del ${Date.now()}`

    await supabase.from('demands').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      unit_id: unit.id, leaseholder_id: lh.id,
      demand_type: 'service_charge', amount: 11,
      status: 'draft', notes: note,
    })

    await page.goto(`/properties/${prop.id}?tab=demands`)
    const row = rowByUnitAndAmount(page, unit.unit_ref, 11)
    await row.getByRole('button', { name: `Delete ${unit.unit_ref} service_charge demand` }).click()
    await expect(page.getByRole('button', { name: 'Confirm delete' })).toBeVisible()

    await page.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(rowByUnitAndAmount(page, unit.unit_ref, 11)).toHaveCount(0)
  })

  test('non-draft demand cannot be hard-deleted (RICS Rule 3.7 evidence trail; TPI; LTA s.20B)', async ({ page }) => {
    const { prop, unit, lh } = await resolveSeedTriplet()
    const note = `${NOTES_PREFIX} FK ${Date.now()}`

    await supabase.from('demands').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      unit_id: unit.id, leaseholder_id: lh.id,
      demand_type: 'service_charge', amount: 22,
      status: 'issued', s21b_attached: true,
      issued_date: '2026-04-01', notes: note,
    })

    await page.goto(`/properties/${prop.id}?tab=demands`)
    const row = rowByUnitAndAmount(page, unit.unit_ref, 22)
    await row.getByRole('button', { name: `Delete ${unit.unit_ref} service_charge demand` }).click()
    await page.getByRole('button', { name: 'Confirm delete' }).click()

    // Status guard fires first; message names RICS Rule 3.7 evidence trail, TPI
    // Consumer Charter & Standards Edition 3, and LTA 1985 s.20B (canonical
    // anchors per audit Tier-1 R-3 / R-4).
    await expect(page.getByText(/RICS Rule 3\.7 evidence trail/i)).toBeVisible()
    await expect(row).toBeVisible()
  })
})
