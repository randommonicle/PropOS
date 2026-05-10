/**
 * @file financial-transactions.spec.ts
 * @description Smoke tests for the per-property Transactions tab — full CRUD,
 * sign convention, the bank account balance trigger, demand auto-status,
 * dual-auth interim block, reconciled lock, statement-import lock, and
 * regulatory-message delete guards.
 *
 * Cleanup unwinds in FK-safe order: payment_authorisations (none in 1e but
 * unwound defensively) → transactions → demands → bank_accounts → leaseholders,
 * scoped to the test's seeded rows by description prefix and notes prefix.
 */
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './_env'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const TXN_PREFIX = 'Smoke TXN'
const BA_PREFIX  = 'Smoke TXN BA'
const DEM_NOTES_PREFIX = 'Smoke TXN'
const LH_NOTES_PREFIX  = 'Smoke TXN'

async function goToFirstProperty(page: Page) {
  await page.goto('/properties')
  await page.locator('a[href^="/properties/"]').first().click()
  await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible()
}

async function goToTransactionsTab(page: Page) {
  await page.getByRole('tab', { name: 'Transactions' }).click()
  await expect(page.getByRole('tab', { name: 'Transactions' })).toHaveAttribute(
    'data-state',
    'active',
  )
}

/**
 * Resolves a property + a freshly-seeded bank account + a freshly-seeded
 * leaseholder. Each test gets its own bank account so balance assertions
 * are deterministic regardless of other transactions on the property.
 *
 * - The bank account is created with `requires_dual_auth=false` by default
 *   so payments don't accidentally trigger the dual-auth gate; the dual-auth
 *   test seeds its own threshold-bearing account.
 */
async function seedScenario(opts: { dualAuth?: { threshold: number } } = {}) {
  await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
  const { data: prop } = await supabase
    .from('properties').select('id, firm_id').limit(1).single()
  if (!prop) throw new Error('No properties found for smoke test')
  const { data: unit } = await supabase
    .from('units').select('id, unit_ref').eq('property_id', prop.id).limit(1).single()
  if (!unit) throw new Error(`No unit on property ${prop.id}`)

  const accountName = `${BA_PREFIX} ${Date.now()} ${Math.random().toString(36).slice(2, 6)}`
  const { data: account, error: accErr } = await supabase
    .from('bank_accounts')
    .insert({
      firm_id: prop.firm_id, property_id: prop.id,
      account_name: accountName,
      account_type: 'service_charge',
      requires_dual_auth: opts.dualAuth != null,
      dual_auth_threshold: opts.dualAuth?.threshold ?? 0,
    })
    .select('id, account_name')
    .single()
  if (accErr || !account) throw new Error(`Failed to seed bank account: ${accErr?.message}`)

  // Reuse or seed a current leaseholder on the unit.
  const { data: existingLh } = await supabase
    .from('leaseholders')
    .select('id, full_name')
    .eq('property_id', prop.id).eq('unit_id', unit.id).eq('is_current', true)
    .like('notes', `${LH_NOTES_PREFIX}%`)
    .limit(1).maybeSingle()
  let lh = existingLh
  if (!lh) {
    const { data: created, error: lhErr } = await supabase
      .from('leaseholders')
      .insert({
        firm_id: prop.firm_id, property_id: prop.id, unit_id: unit.id,
        full_name: 'Smoke TXN Leaseholder',
        is_current: true, is_resident: false, is_company: false,
        portal_access: false,
        notes: `${LH_NOTES_PREFIX} seed leaseholder`,
      })
      .select('id, full_name').single()
    if (lhErr || !created) throw new Error(`Failed to seed leaseholder: ${lhErr?.message}`)
    lh = created
  }

  return { prop, unit, account, lh }
}

test.describe('Property detail — transactions', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })

    // FK-safe order: payment_authorisations → transactions → demands → bank_accounts → leaseholders.
    const { data: txns } = await supabase
      .from('transactions').select('id, demand_id').like('description', `${TXN_PREFIX}%`)
    const txnIds = (txns ?? []).map(r => r.id)
    if (txnIds.length) {
      await supabase.from('payment_authorisations').delete().in('transaction_id', txnIds)
    }
    await supabase.from('transactions').delete().like('description', `${TXN_PREFIX}%`)
    await supabase.from('demands').delete().like('notes', `${DEM_NOTES_PREFIX}%`)
    await supabase.from('bank_accounts').delete().like('account_name', `${BA_PREFIX}%`)
    await supabase.from('leaseholders').delete().like('notes', `${LH_NOTES_PREFIX}%`)
  })

  test('Transactions tab updates the URL to ?tab=transactions', async ({ page }) => {
    await goToFirstProperty(page)
    await goToTransactionsTab(page)
    await expect(page).toHaveURL(/\?tab=transactions/)
    await expect(page.getByRole('button', { name: 'Add transaction' })).toBeVisible()
  })

  test('Heading and add button are visible', async ({ page }) => {
    await goToFirstProperty(page)
    await goToTransactionsTab(page)
    await expect(page.getByRole('heading', { name: /^Transactions/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add transaction' })).toBeVisible()
  })

  test('receipt create round-trip — positive amount, balance trigger updates', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const description = `${TXN_PREFIX} Receipt ${Date.now()}`
    await page.goto(`/properties/${prop.id}?tab=transactions`)

    await page.getByLabel('Filter by bank account').selectOption(account.id)
    await page.getByRole('button', { name: 'Add transaction' }).click()
    await expect(page.getByRole('heading', { name: 'New transaction' })).toBeVisible()

    await page.getByLabel('Bank account *').selectOption(account.id)
    await page.getByLabel('Type *').selectOption('Receipt')
    await page.getByLabel('Amount *').fill('100.00')
    await page.getByLabel('Description *').fill(description)
    await page.getByRole('button', { name: 'Save transaction' }).click()
    await expect(page.getByRole('heading', { name: 'New transaction' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(description)).toBeVisible()

    // The balance trigger maintains bank_accounts.current_balance from the SUM
    // of transactions. After a £100 receipt the seeded account should be at £100.
    const { data: refreshed } = await supabase
      .from('bank_accounts').select('current_balance').eq('id', account.id).single()
    expect(Number(refreshed?.current_balance)).toBeCloseTo(100, 2)
  })

  test('payment create round-trip — sign flipped to negative on save', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const description = `${TXN_PREFIX} Payment ${Date.now()}`
    await page.goto(`/properties/${prop.id}?tab=transactions`)

    await page.getByLabel('Filter by bank account').selectOption(account.id)
    await page.getByRole('button', { name: 'Add transaction' }).click()
    await page.getByLabel('Bank account *').selectOption(account.id)
    await page.getByLabel('Type *').selectOption('Payment')
    await page.getByLabel('Amount *').fill('50.00')
    await page.getByLabel('Description *').fill(description)
    await page.getByRole('button', { name: 'Save transaction' }).click()
    await expect(page.getByRole('heading', { name: 'New transaction' })).not.toBeVisible()
    await expect(page.getByRole('main').getByText(description)).toBeVisible()

    // DB row stores the signed value: payment → negative amount.
    const { data: row } = await supabase
      .from('transactions').select('amount').eq('description', description).single()
    expect(Number(row?.amount)).toBeCloseTo(-50, 2)
  })

  test('demand auto-status — receipt covering full amount marks demand paid', async ({ page }) => {
    const { prop, unit, account, lh } = await seedScenario()
    const description = `${TXN_PREFIX} ReceiptForDemand ${Date.now()}`
    const note = `${DEM_NOTES_PREFIX} demand for autopay ${Date.now()}`

    // Seed an issued demand for £30.
    const { data: dem, error: dErr } = await supabase
      .from('demands').insert({
        firm_id: prop.firm_id, property_id: prop.id,
        unit_id: unit.id, leaseholder_id: lh.id,
        demand_type: 'service_charge', amount: 30,
        status: 'issued', s21b_attached: true,
        issued_date: '2026-04-01', notes: note,
      }).select('id').single()
    if (dErr || !dem) throw new Error(`Failed to seed demand: ${dErr?.message}`)

    await page.goto(`/properties/${prop.id}?tab=transactions`)
    await page.getByRole('button', { name: 'Add transaction' }).click()
    await page.getByLabel('Bank account *').selectOption(account.id)
    await page.getByLabel('Type *').selectOption('Receipt')
    await page.getByLabel('Amount *').fill('30.00')
    await page.getByLabel('Description *').fill(description)
    // Demand picker only appears for receipts; pick the seeded demand by id.
    await page.getByLabel('Link to demand (optional)').selectOption(dem.id)
    await page.getByRole('button', { name: 'Save transaction' }).click()
    await expect(page.getByRole('heading', { name: 'New transaction' })).not.toBeVisible()

    // The linked demand should auto-update to paid (cumulative receipts ≥ amount).
    const { data: refreshed } = await supabase
      .from('demands').select('status').eq('id', dem.id).single()
    expect(refreshed?.status).toBe('paid')
  })

  // The 1e dual-auth "block" test was removed when 1f introduced the proper
  // request flow. Coverage for the new behaviour (payment over threshold
  // creates a pending payment_authorisation row, no transaction inserted)
  // lives in financial-payment-authorisations.spec.ts.

  test('reconciled lock — opening a reconciled txn locks all fields', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const description = `${TXN_PREFIX} Reconciled ${Date.now()}`

    await supabase.from('transactions').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      bank_account_id: account.id,
      transaction_type: 'receipt', transaction_date: '2026-04-01',
      amount: 75, description,
      reconciled: true, reconciled_at: new Date().toISOString(),
    })

    await page.goto(`/properties/${prop.id}?tab=transactions`)
    await page.getByLabel('Filter by bank account').selectOption(account.id)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(description) })
    await row.getByRole('button', { name: /Edit .* Receipt £75\.00/ }).click()
    await expect(page.getByRole('heading', { name: 'Edit transaction' })).toBeVisible()

    // Lock note + every field disabled.
    await expect(page.getByText(/reconciled transactions cannot be edited/i)).toBeVisible()
    await expect(page.getByLabel('Bank account *')).toBeDisabled()
    await expect(page.getByLabel('Type *')).toBeDisabled()
    await expect(page.getByLabel('Transaction date *')).toBeDisabled()
    await expect(page.getByLabel('Amount *')).toBeDisabled()
    await expect(page.getByLabel('Description *')).toBeDisabled()
    await expect(page.getByLabel('Payee / payer')).toBeDisabled()
    await expect(page.getByLabel('Reference')).toBeDisabled()
  })

  test('reconciled delete blocked — regulatory message surfaces', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const description = `${TXN_PREFIX} ReconDel ${Date.now()}`

    await supabase.from('transactions').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      bank_account_id: account.id,
      transaction_type: 'receipt', transaction_date: '2026-04-01',
      amount: 12, description,
      reconciled: true, reconciled_at: new Date().toISOString(),
    })

    await page.goto(`/properties/${prop.id}?tab=transactions`)
    await page.getByLabel('Filter by bank account').selectOption(account.id)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(description) })
    // The Delete button is disabled (locked); assert that and the tooltip.
    const deleteBtn = row.getByRole('button', { name: /Delete .* Receipt £12\.00/ })
    await expect(deleteBtn).toBeDisabled()
    await expect(deleteBtn).toHaveAttribute('title', /reconciled/i)
  })

  test('statement-import lock — fields disabled and source label visible', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const description = `${TXN_PREFIX} ImportLock ${Date.now()}`

    // Seed a bank_statement_imports row first, then a transaction tied to it.
    const { data: imp, error: impErr } = await supabase
      .from('bank_statement_imports').insert({
        firm_id: prop.firm_id, bank_account_id: account.id,
        filename: 'smoke-import.csv', row_count: 1,
        status: 'matched',
      }).select('id').single()
    if (impErr || !imp) throw new Error(`Failed to seed statement import: ${impErr?.message}`)

    await supabase.from('transactions').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      bank_account_id: account.id,
      transaction_type: 'receipt', transaction_date: '2026-04-01',
      amount: 22, description,
      statement_import_id: imp.id,
    })

    await page.goto(`/properties/${prop.id}?tab=transactions`)
    await page.getByLabel('Filter by bank account').selectOption(account.id)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(description) })
    // Source column shows "Statement import".
    await expect(row.getByText('Statement import')).toBeVisible()

    await row.getByRole('button', { name: /Edit .* Receipt £22\.00/ }).click()
    await expect(page.getByText(/upstream audit chain/i)).toBeVisible()
    await expect(page.getByLabel('Amount *')).toBeDisabled()
    await expect(page.getByLabel('Description *')).toBeDisabled()

    // Cleanup the seeded import row (FK: transactions delete first via afterAll).
    // The afterAll deletes transactions with TXN_PREFIX which clears the FK so
    // the import row can also be removed manually here.
    await supabase.from('transactions').delete().eq('description', description)
    await supabase.from('bank_statement_imports').delete().eq('id', imp.id)
  })

  test('draft delete — unreconciled, non-imported txn deletes; balance updates', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const description = `${TXN_PREFIX} Del ${Date.now()}`

    await supabase.from('transactions').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      bank_account_id: account.id,
      transaction_type: 'receipt', transaction_date: '2026-04-01',
      amount: 11, description,
    })

    // Pre-delete the balance trigger should have raised it to £11.
    const { data: pre } = await supabase
      .from('bank_accounts').select('current_balance').eq('id', account.id).single()
    expect(Number(pre?.current_balance)).toBeCloseTo(11, 2)

    await page.goto(`/properties/${prop.id}?tab=transactions`)
    await page.getByLabel('Filter by bank account').selectOption(account.id)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(description) })
    await row.getByRole('button', { name: /Delete .* Receipt £11\.00/ }).click()
    await page.getByRole('button', { name: 'Confirm delete' }).click()

    // Row removed from the list.
    await expect(page.getByText(description)).not.toBeVisible()

    // Balance trigger reverses to £0.
    const { data: post } = await supabase
      .from('bank_accounts').select('current_balance').eq('id', account.id).single()
    expect(Number(post?.current_balance)).toBeCloseTo(0, 2)
  })
})
