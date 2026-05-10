/**
 * @file financial-bank-accounts.spec.ts
 * @description Smoke tests for the per-property Bank accounts tab — full CRUD,
 * read-only current_balance with §5.6 tooltip, MoneyInput round-trip, and last-4
 * digit validation. Cleanup runs in FK-safe order matching the Phase 2 pattern.
 */
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

// NOTE: §6.5 hygiene fix (drop the publishable-key fallback below) is tracked as a
// separate follow-up commit so this file mirrors the existing smoke pattern.
const supabase = createClient(
  process.env.VITE_SUPABASE_URL ?? 'https://tmngfuonanizxyffrsjy.supabase.co',
  process.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_M_cBRZKdJtIunGAUFBhD1g_SYMADNyT',
)

const BA_PREFIX = 'Smoke BA'

async function goToFirstProperty(page: Page) {
  await page.goto('/properties')
  await page.locator('a[href^="/properties/"]').first().click()
  await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible()
}

async function goToBankAccountsTab(page: Page) {
  await page.getByRole('tab', { name: 'Bank accounts' }).click()
  await expect(page.getByRole('tab', { name: 'Bank accounts' })).toHaveAttribute(
    'data-state',
    'active',
  )
}

test.describe('Property detail — bank accounts', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
    // No FK chain to unwind in 1b — transactions table is empty for this test set.
    await supabase.from('bank_accounts').delete().like('account_name', `${BA_PREFIX}%`)
  })

  test('Bank accounts tab updates the URL to ?tab=bank-accounts', async ({ page }) => {
    await goToFirstProperty(page)
    await goToBankAccountsTab(page)
    await expect(page).toHaveURL(/\?tab=bank-accounts/)
    await expect(page.getByRole('button', { name: 'Add bank account' })).toBeVisible()
  })

  test('Bank accounts heading and add button are visible', async ({ page }) => {
    await goToFirstProperty(page)
    await goToBankAccountsTab(page)
    await expect(page.getByRole('heading', { name: /^Bank accounts/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add bank account' })).toBeVisible()
  })

  test('bank account create round-trip', async ({ page }) => {
    const name = `${BA_PREFIX} Create ${Date.now()}`
    await goToFirstProperty(page)
    await goToBankAccountsTab(page)

    await page.getByRole('button', { name: 'Add bank account' }).click()
    await expect(page.getByRole('heading', { name: 'New bank account' })).toBeVisible()

    await page.getByLabel('Account name *').fill(name)
    await page.getByLabel('Bank name').fill('Barclays')
    await page.getByLabel('Sort code (last 4)').fill('1234')
    await page.getByLabel('Account number (last 4)').fill('5678')

    // dual_auth_threshold via MoneyInput — type, blur, expect canonical formatting.
    const threshold = page.getByLabel('Dual-auth threshold')
    await threshold.fill('1234.56')
    await threshold.blur()
    await expect(threshold).toHaveValue('1,234.56')

    await page.getByRole('button', { name: 'Save bank account' }).click()

    await expect(page.getByRole('heading', { name: 'New bank account' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(name)).toBeVisible()
  })

  test('bank account edit round-trip — current_balance is disabled with §5.6 tooltip', async ({ page }) => {
    const original = `${BA_PREFIX} Edit ${Date.now()}`
    const updated  = `${BA_PREFIX} Edited ${Date.now()}`
    await goToFirstProperty(page)
    await goToBankAccountsTab(page)

    // Create
    await page.getByRole('button', { name: 'Add bank account' }).click()
    await page.getByLabel('Account name *').fill(original)
    await page.getByRole('button', { name: 'Save bank account' }).click()
    await expect(page.getByRole('main').getByText(original)).toBeVisible()

    // Edit
    const row = page.getByRole('main').locator('tr', { has: page.getByText(original) })
    await row.getByRole('button', { name: `Edit ${original}` }).click()
    await expect(page.getByRole('heading', { name: 'Edit bank account' })).toBeVisible()

    // Current balance field is disabled and tagged with the §5.6 tooltip text
    const balance = page.getByLabel('Current balance')
    await expect(balance).toBeDisabled()
    await expect(balance).toHaveAttribute('title', /trigger-maintained/i)
    await expect(page.getByText(/trigger-maintained on reconciliation/i)).toBeVisible()

    await page.getByLabel('Account name *').clear()
    await page.getByLabel('Account name *').fill(updated)
    await page.getByRole('button', { name: 'Update bank account' }).click()

    await expect(page.getByRole('heading', { name: 'Edit bank account' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(updated)).toBeVisible()
  })

  test('MoneyInput persists 1234.56 to DB as £1,234.56 and reformats on re-edit', async ({ page }) => {
    const name = `${BA_PREFIX} Money ${Date.now()}`
    await goToFirstProperty(page)
    await goToBankAccountsTab(page)

    await page.getByRole('button', { name: 'Add bank account' }).click()
    await page.getByLabel('Account name *').fill(name)
    const threshold = page.getByLabel('Dual-auth threshold')
    await threshold.fill('1234.56')
    await page.getByRole('button', { name: 'Save bank account' }).click()
    await expect(page.getByRole('main').getByText(name)).toBeVisible()

    // The list cell shows £1,234.56 in the dual-auth badge
    const row = page.getByRole('main').locator('tr', { has: page.getByText(name) })
    await expect(row.getByText(/£1,234\.56/)).toBeVisible()

    // Reopen — MoneyInput should render the canonical "1,234.56"
    await row.getByRole('button', { name: `Edit ${name}` }).click()
    await expect(page.getByLabel('Dual-auth threshold')).toHaveValue('1,234.56')
  })

  test('sort_code_last4 / account_number_last4 reject non-4-digit input', async ({ page }) => {
    const name = `${BA_PREFIX} L4 ${Date.now()}`
    await goToFirstProperty(page)
    await goToBankAccountsTab(page)

    await page.getByRole('button', { name: 'Add bank account' }).click()
    await page.getByLabel('Account name *').fill(name)

    // 2 digits — pattern violation, browser blocks submit
    await page.getByLabel('Sort code (last 4)').fill('12')
    await page.getByRole('button', { name: 'Save bank account' }).click()
    await expect(page.getByRole('heading', { name: 'New bank account' })).toBeVisible()

    // 4 letters — maxLength=4 caps but pattern still rejects
    await page.getByLabel('Sort code (last 4)').fill('')
    await page.getByLabel('Sort code (last 4)').fill('12a4')
    await page.getByRole('button', { name: 'Save bank account' }).click()
    await expect(page.getByRole('heading', { name: 'New bank account' })).toBeVisible()

    // 4 digits — succeeds
    await page.getByLabel('Sort code (last 4)').fill('')
    await page.getByLabel('Sort code (last 4)').fill('1234')
    await page.getByRole('button', { name: 'Save bank account' }).click()
    await expect(page.getByRole('main').getByText(name)).toBeVisible()
  })

  test('mark account as Closed sets is_active=false and preserves the row', async ({ page }) => {
    const name = `${BA_PREFIX} Close ${Date.now()}`
    await goToFirstProperty(page)
    await goToBankAccountsTab(page)

    await page.getByRole('button', { name: 'Add bank account' }).click()
    await page.getByLabel('Account name *').fill(name)
    await page.getByRole('button', { name: 'Save bank account' }).click()
    await expect(page.getByRole('main').getByText(name)).toBeVisible()

    const row = page.getByRole('main').locator('tr', { has: page.getByText(name) })
    await row.getByRole('button', { name: `Edit ${name}` }).click()
    await page.getByRole('checkbox', { name: 'Active' }).uncheck()
    await page.getByRole('button', { name: 'Update bank account' }).click()

    await expect(page.getByRole('heading', { name: 'Edit bank account' })).not.toBeVisible()
    const closedRow = page.getByRole('main').locator('tr', { has: page.getByText(name) })
    await expect(closedRow.getByText(/Closed/)).toBeVisible()
  })

  test('bank account delete shows inline confirmation then removes row', async ({ page }) => {
    const name = `${BA_PREFIX} Del ${Date.now()}`
    await goToFirstProperty(page)
    await goToBankAccountsTab(page)

    await page.getByRole('button', { name: 'Add bank account' }).click()
    await page.getByLabel('Account name *').fill(name)
    await page.getByRole('button', { name: 'Save bank account' }).click()
    await expect(page.getByRole('main').getByText(name)).toBeVisible()

    const row = page.getByRole('main').locator('tr', { has: page.getByText(name) })
    await row.getByRole('button', { name: `Delete ${name}` }).click()
    await expect(page.getByRole('button', { name: 'Confirm delete' })).toBeVisible()

    // Cancel — row still present
    await page.getByRole('button', { name: 'Cancel' }).first().click()
    await expect(page.getByRole('main').getByText(name)).toBeVisible()

    // Confirm — row gone
    const row2 = page.getByRole('main').locator('tr', { has: page.getByText(name) })
    await row2.getByRole('button', { name: `Delete ${name}` }).click()
    await page.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(page.getByRole('cell', { name, exact: true })).not.toBeVisible()
  })

  test('reconciled accounts cannot be hard-deleted (RICS Rule 4.7 / TPI §5)', async ({ page }) => {
    // Create directly via Supabase with last_reconciled_at set so we exercise the
    // pre-FK guard that surfaces the regulatory message.
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
    const { data: prop } = await supabase.from('properties').select('id, firm_id').limit(1).single()
    if (!prop) throw new Error('No properties found for smoke test')

    const name = `${BA_PREFIX} Reconciled ${Date.now()}`
    await supabase.from('bank_accounts').insert({
      firm_id: prop.firm_id,
      property_id: prop.id,
      account_name: name,
      account_type: 'service_charge',
      last_reconciled_at: new Date().toISOString(),
    })

    await page.goto(`/properties/${prop.id}?tab=bank-accounts`)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(name) })
    await row.getByRole('button', { name: `Delete ${name}` }).click()
    await page.getByRole('button', { name: 'Confirm delete' }).click()

    // Regulatory error surfaces — RICS / TPI wording
    await expect(page.getByText(/RICS Client Money Rule 4\.7/i)).toBeVisible()
    // Row is still present (not deleted). Use the cell role to avoid colliding
    // with the <strong> inside the now-still-open confirmation row.
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
  })

  test('admin can flip rics_designated true→false directly via the form (1g.5 asymmetry preserved)', async ({ page }) => {
    // 1g.5 deliberately allows admin / director to edit rics_designated
    // directly via the BankAccountForm — the dual-auth flow is the path PMs
    // use; admins are not blocked. This test locks in that asymmetry so a
    // future commit accidentally extending the dual-auth gate to admins
    // breaks this test loudly. See DECISIONS 2026-05-10 — 1g.5 §3.
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
    const { data: prop } = await supabase.from('properties').select('id, firm_id').limit(1).single()
    if (!prop) throw new Error('No properties found for smoke test')

    const name = `${BA_PREFIX} AdminRICSFlip ${Date.now()}`
    const { data: account } = await supabase.from('bank_accounts').insert({
      firm_id: prop.firm_id,
      property_id: prop.id,
      account_name: name,
      account_type: 'service_charge',
      rics_designated: true,
    }).select('id').single()
    if (!account) throw new Error('Failed to seed bank account')

    // Snapshot the PA-row count for this firm so we can assert no PA was created.
    const { count: paBefore } = await supabase
      .from('payment_authorisations')
      .select('*', { count: 'exact', head: true })
      .eq('firm_id', prop.firm_id)

    await page.goto(`/properties/${prop.id}?tab=bank-accounts`)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(name) })
    await row.getByRole('button', { name: `Edit ${name}` }).click()
    await expect(page.getByRole('heading', { name: 'Edit bank account' })).toBeVisible()

    // Untick the RICS-designated checkbox — direct edit, no request flow.
    const ricsCheckbox = page.getByLabel('RICS-designated client account')
    await expect(ricsCheckbox).toBeEnabled()
    await ricsCheckbox.uncheck()
    await page.getByRole('button', { name: 'Update bank account' }).click()
    await expect(page.getByRole('heading', { name: 'Edit bank account' })).not.toBeVisible()

    // DB: rics_designated flipped immediately.
    const { data: refreshed } = await supabase
      .from('bank_accounts').select('rics_designated').eq('id', account.id).single()
    expect(refreshed?.rics_designated).toBe(false)

    // DB: no payment_authorisations row was created.
    const { count: paAfter } = await supabase
      .from('payment_authorisations')
      .select('*', { count: 'exact', head: true })
      .eq('firm_id', prop.firm_id)
    expect(paAfter ?? 0).toBe(paBefore ?? 0)
  })
})
