/**
 * @file financial-reconciliation.spec.ts
 * @description Smoke tests for the per-property Reconciliation tab and
 * statement import pipeline. Spec §5.3 — Bank Reconciliation Engine.
 *
 * 1h.1 coverage (this file at this commit):
 *   1. Reconciliation tab renders 9th and lists per-account periods.
 *   2. PM starts a new reconciliation period — reconciliation_periods row
 *      created with status='open'.
 *   3. CSV statement upload parses and writes bank_statement_imports.raw_data
 *      with status='processing'.
 *   4. Unsupported format (OFX) surfaces FORWARD note rather than crashing.
 *
 * 1h.2 / 1h.3 smokes (matching engine + completion) extend this file in
 * subsequent commits.
 *
 * Cleanup unwinds in FK-safe order: reconciliation_audit_log →
 * suspense_items → bank_statement_imports → reconciliation_periods →
 * bank_accounts, scoped to test-prefixed rows.
 */
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

// NOTE: §6.5 hygiene fix (drop the publishable-key fallback below) is tracked as
// a separate follow-up commit so this file mirrors the existing smoke pattern.
const supabase = createClient(
  process.env.VITE_SUPABASE_URL ?? 'https://tmngfuonanizxyffrsjy.supabase.co',
  process.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_M_cBRZKdJtIunGAUFBhD1g_SYMADNyT',
)

const BA_PREFIX = 'Smoke RECON BA'

async function goToFirstProperty(page: Page) {
  await page.goto('/properties')
  await page.locator('a[href^="/properties/"]').first().click()
  await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible()
}

async function goToReconciliationTab(page: Page) {
  await page.getByRole('tab', { name: 'Reconciliation' }).click()
  await expect(page.getByRole('tab', { name: 'Reconciliation' })).toHaveAttribute(
    'data-state',
    'active',
  )
}

interface SeededAccount {
  prop:    { id: string; firm_id: string }
  account: { id: string; account_name: string }
}

async function seedAccount(): Promise<SeededAccount> {
  await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
  const { data: prop } = await supabase
    .from('properties').select('id, firm_id').limit(1).single()
  if (!prop) throw new Error('No properties found for smoke test')

  const accountName = `${BA_PREFIX} ${Date.now()} ${Math.random().toString(36).slice(2, 6)}`
  const { data: account, error: accErr } = await supabase
    .from('bank_accounts')
    .insert({
      firm_id: prop.firm_id, property_id: prop.id,
      account_name: accountName,
      account_type: 'service_charge',
      requires_dual_auth: false,
      dual_auth_threshold: 0,
    })
    .select('id, account_name')
    .single()
  if (accErr || !account) throw new Error(`Failed to seed bank account: ${accErr?.message}`)
  return { prop, account }
}

const SAMPLE_CSV = [
  'Date,Description,Amount,Reference',
  '01/04/2026,Service charge receipt — Flat 1,1500.00,SC-Q1-001',
  '03/04/2026,Building insurance premium,-2400.50,INS-2026',
  '07/04/2026,Cleaning contractor invoice,-180.00,INV-CLN-119',
].join('\n')

const SAMPLE_OFX = '<?xml version="1.0"?>\n<OFX>\n  <BANKMSGSRSV1></BANKMSGSRSV1>\n</OFX>\n'

async function uploadCsvFile(page: Page, filename: string, content: string) {
  await page.locator('[data-testid="statement-file-input"]').setInputFiles({
    name:     filename,
    mimeType: 'text/csv',
    buffer:   Buffer.from(content, 'utf8'),
  })
}

async function configureCsvMappingForSample(page: Page) {
  // Headers: Date, Description, Amount, Reference. Single-amount mode.
  await page.getByTestId('map-date').selectOption('Date')
  await page.getByTestId('map-description').selectOption('Description')
  await page.getByTestId('map-date-format').selectOption('DD/MM/YYYY')
  await page.getByTestId('map-amount-mode').selectOption('one')
  await page.getByTestId('map-amount').selectOption('Amount')
  await page.getByTestId('map-reference').selectOption('Reference')
}

test.describe('Property detail — reconciliation', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })

    // FK-safe order: audit log → suspense items → statement imports →
    // reconciliation periods → bank accounts.
    const { data: accounts } = await supabase
      .from('bank_accounts').select('id').like('account_name', `${BA_PREFIX}%`)
    const accountIds = (accounts ?? []).map(a => a.id)
    if (!accountIds.length) return

    await supabase.from('reconciliation_audit_log').delete().in('bank_account_id', accountIds)
    const { data: imports } = await supabase
      .from('bank_statement_imports').select('id').in('bank_account_id', accountIds)
    const importIds = (imports ?? []).map(i => i.id)
    if (importIds.length) {
      await supabase.from('suspense_items').delete().in('bank_statement_import_id', importIds)
    }
    await supabase.from('reconciliation_periods').delete().in('bank_account_id', accountIds)
    await supabase.from('bank_statement_imports').delete().in('bank_account_id', accountIds)
    await supabase.from('bank_accounts').delete().in('id', accountIds)
  })

  test('Reconciliation tab renders 9th and lists per-account state', async ({ page }) => {
    const { prop, account } = await seedAccount()
    await page.goto(`/properties/${prop.id}?tab=reconciliation`)
    await goToReconciliationTab(page)

    // The seeded account's name is rendered as a row.
    await expect(page.getByText(account.account_name)).toBeVisible()
    // A status badge is present for the seeded account (never reconciled).
    await expect(page.getByTestId(`recon-status-${account.id}`)).toBeVisible()
    await expect(page.getByTestId(`recon-status-${account.id}`)).toContainText(/Never reconciled/i)
    // Start reconciliation button exists.
    await expect(page.getByTestId(`recon-start-${account.id}`)).toBeVisible()
    await expect(page.getByTestId(`recon-start-${account.id}`)).toContainText(/Start reconciliation/i)
  })

  test('PM starts a new reconciliation period — period row created with status=open', async ({ page }) => {
    const { prop, account } = await seedAccount()
    await page.goto(`/properties/${prop.id}?tab=reconciliation`)
    await goToReconciliationTab(page)

    await page.getByTestId(`recon-start-${account.id}`).click()
    await expect(page.getByRole('dialog', { name: /Reconciliation —/ })).toBeVisible()

    // Default dates pre-populated. Override period_start for determinism.
    await page.getByLabel('Period start *').fill('2026-04-01')
    await page.getByLabel('Period end *').fill('2026-04-30')

    await uploadCsvFile(page, 'sample.csv', SAMPLE_CSV)
    await expect(page.getByTestId('map-date')).toBeVisible()
    await configureCsvMappingForSample(page)

    // Preview should report 3 rows ready before submit.
    await expect(page.getByText(/3 rows ready to import/)).toBeVisible()

    await page.getByTestId('statement-import-submit').click()

    // Wait for modal to close before querying DB (modal-vs-DB-query race
    // pattern from LESSONS Phase 3 session 2).
    await expect(page.getByRole('dialog', { name: /Reconciliation —/ })).toHaveCount(0)

    const { data: periods } = await supabase
      .from('reconciliation_periods')
      .select('id, status, period_start, period_end, bank_statement_import_id')
      .eq('bank_account_id', account.id)
    expect(periods).toHaveLength(1)
    expect(periods![0].status).toBe('open')
    expect(periods![0].period_start).toBe('2026-04-01')
    expect(periods![0].period_end).toBe('2026-04-30')
    expect(periods![0].bank_statement_import_id).not.toBeNull()
  })

  test('CSV statement upload parses and writes raw_data with status=processing', async ({ page }) => {
    const { prop, account } = await seedAccount()
    await page.goto(`/properties/${prop.id}?tab=reconciliation`)
    await goToReconciliationTab(page)

    await page.getByTestId(`recon-start-${account.id}`).click()
    await expect(page.getByRole('dialog', { name: /Reconciliation —/ })).toBeVisible()

    await page.getByLabel('Period start *').fill('2026-04-01')
    await page.getByLabel('Period end *').fill('2026-04-30')

    await uploadCsvFile(page, 'lloyds-export.csv', SAMPLE_CSV)
    await configureCsvMappingForSample(page)
    await page.getByTestId('statement-import-submit').click()
    await expect(page.getByRole('dialog', { name: /Reconciliation —/ })).toHaveCount(0)

    // Verify the bank_statement_imports row.
    const { data: imports } = await supabase
      .from('bank_statement_imports')
      .select('id, status, filename, row_count, raw_data')
      .eq('bank_account_id', account.id)
    expect(imports).toHaveLength(1)
    const imp = imports![0]
    expect(imp.status).toBe('processing')
    expect(imp.filename).toBe('lloyds-export.csv')
    expect(imp.row_count).toBe(3)

    // raw_data is the parsed canonical rows. Spot-check the first row's
    // amount in pence (1500.00 => 150000) and the date normalisation.
    const rows = imp.raw_data as Array<{
      index: number; date: string; amountP: number; description: string
    }>
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBe(3)
    expect(rows[0].date).toBe('2026-04-01')
    expect(rows[0].amountP).toBe(150000)
    expect(rows[1].amountP).toBe(-240050)

    // The bank_accounts.csv_column_map is cached for re-use.
    const { data: acc } = await supabase
      .from('bank_accounts').select('csv_column_map').eq('id', account.id).single()
    expect(acc!.csv_column_map).not.toBeNull()
  })

  test('OFX upload surfaces format-not-yet-supported note rather than crashing', async ({ page }) => {
    const { prop, account } = await seedAccount()
    await page.goto(`/properties/${prop.id}?tab=reconciliation`)
    await goToReconciliationTab(page)

    await page.getByTestId(`recon-start-${account.id}`).click()
    await expect(page.getByRole('dialog', { name: /Reconciliation —/ })).toBeVisible()

    await page.locator('[data-testid="statement-file-input"]').setInputFiles({
      name:     'export.ofx',
      mimeType: 'application/x-ofx',
      buffer:   Buffer.from(SAMPLE_OFX, 'utf8'),
    })

    // Parse error surfaced inline; the FORWARD anchor is named explicitly.
    await expect(page.getByTestId('parse-error')).toBeVisible()
    await expect(page.getByTestId('parse-error')).toContainText(/OFX format is not yet supported/i)
    await expect(page.getByTestId('parse-error')).toContainText(/FORWARD: 1h\.4/)

    // Submit button stays disabled (no preview parse).
    await expect(page.getByTestId('statement-import-submit')).toBeDisabled()

    // Cancel cleanly — no period or import rows persisted.
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('dialog', { name: /Reconciliation —/ })).toHaveCount(0)

    const { data: periods } = await supabase
      .from('reconciliation_periods').select('id').eq('bank_account_id', account.id)
    expect(periods).toHaveLength(0)
    const { data: imports } = await supabase
      .from('bank_statement_imports').select('id').eq('bank_account_id', account.id)
    expect(imports).toHaveLength(0)
  })
})
