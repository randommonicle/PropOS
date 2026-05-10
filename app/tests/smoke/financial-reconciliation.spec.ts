/**
 * @file financial-reconciliation.spec.ts
 * @description Smoke tests for the per-property Reconciliation tab — the
 * statement import pipeline (1h.1), three-pass matching engine + review UI
 * actions (1h.2), and completion + £0.01 balance gate (1h.3 — to come).
 * Spec §5.3 — Bank Reconciliation Engine.
 *
 * 1h.1 coverage:
 *   1. Reconciliation tab renders 9th and lists per-account periods.
 *   2. PM starts a new reconciliation period — reconciliation_periods row
 *      created with status='open'.
 *   3. CSV statement upload parses and writes bank_statement_imports.raw_data
 *      with status='processing'.
 *   4. Unsupported format (OFX) surfaces FORWARD note rather than crashing.
 *
 * 1h.2 coverage:
 *   5. Pass-1 exact match auto-matches with confidence 1.00 + audit row.
 *   6. Pass-2 strong match shows in Suggested with 80% — Confirm + audit row.
 *   7. Pass-3 weak match (amount-to-penny + ±30 days subclause) shows in
 *      Review carefully with 50% — Confirm + audit row.
 *   7b. Pass-3 weak match (£0.50 tolerance + ±7 days subclause) — separate
 *       code path; locks the foreign-card-rounding tolerance branch.
 *   8. Dedup property — pass-1 match removes its txn from pass-2/pass-3
 *      candidate pools.
 *   9. Unmatched — Create new transaction prefills + saves with reconciled.
 *  10. Unmatched — Match manually picker filters to unreconciled txns.
 *  11. Unmatched — Mark as suspense inserts suspense_items row.
 *  12. Unmatched — Reject writes audit row citing RICS Rule 3.7.
 *
 * 1h.3 coverage:
 *  13. Completion blocked when unreconciled transactions remain in period.
 *  14. Completion blocked with >£0.01 balance discrepancy (smoke injects
 *      corrupted current_balance via direct UPDATE — bypassing the trigger).
 *  15. Completion succeeds with no suspense — last_reconciled_at stamped,
 *      period marked completed, audit row written, import status complete.
 *  16. Completion with open suspense in period requires completion_notes —
 *      saves with suspense_carried_forward=true.
 *  17. Completed period is immutable — Mark complete button absent on
 *      completed rows.
 *  2b. Cannot create a second open period for a bank account — partial
 *      unique index returns 23505 on direct DB insert.
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

const BA_PREFIX  = 'Smoke RECON BA'
const TXN_PREFIX = 'Smoke RECON TXN'

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
    // Transactions get reconciled / created during 1h.2 smokes — sweep them.
    await supabase.from('transactions').delete().in('bank_account_id', accountIds)
    await supabase.from('reconciliation_periods').delete().in('bank_account_id', accountIds)
    await supabase.from('bank_statement_imports').delete().in('bank_account_id', accountIds)
    await supabase.from('bank_accounts').delete().in('id', accountIds)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 1h.2 — matching engine + review UI helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Seed a transactions row used as a matching candidate. amountP is the
   *  signed pence value the spec uses (positive = receipt). */
  async function seedTransaction(
    prop: { id: string; firm_id: string },
    accountId: string,
    fields: { amountP: number; date: string; description: string; reference?: string; payee?: string },
  ): Promise<{ id: string }> {
    const amountPounds = fields.amountP / 100
    const txnType = fields.amountP > 0 ? 'receipt' : 'payment'
    const { data, error } = await supabase
      .from('transactions')
      .insert({
        firm_id:          prop.firm_id,
        property_id:      prop.id,
        bank_account_id:  accountId,
        transaction_type: txnType,
        transaction_date: fields.date,
        amount:           amountPounds,
        description:      `${TXN_PREFIX} ${fields.description}`,
        reference:        fields.reference ?? null,
        payee_payer:      fields.payee ?? null,
        reconciled:       false,
      })
      .select('id').single()
    if (error || !data) throw new Error(`Failed to seed transaction: ${error?.message}`)
    return data
  }

  /** Seed an open reconciliation_period + a bank_statement_imports row with
   *  raw_data populated, ready for the review modal to consume. */
  async function seedOpenPeriodWithImport(
    prop: { id: string; firm_id: string },
    accountId: string,
    rows: Array<{ index: number; date: string; amountP: number; description: string; reference?: string | null; payee?: string | null }>,
    period?: { period_start: string; period_end: string },
  ): Promise<{ periodId: string; importId: string }> {
    const periodDates = period ?? { period_start: '2026-04-01', period_end: '2026-04-30' }
    const { data: imp, error: impErr } = await supabase
      .from('bank_statement_imports')
      .insert({
        firm_id:         prop.firm_id,
        bank_account_id: accountId,
        filename:        'smoke-recon.csv',
        row_count:       rows.length,
        matched_count:   0,
        unmatched_count: rows.length,
        raw_data:        rows.map(r => ({
          index:       r.index,
          date:        r.date,
          amountP:     r.amountP,
          description: r.description,
          reference:   r.reference ?? null,
          payee:       r.payee ?? null,
          raw:         {},
        })) as never,
        status:          'processing',
      })
      .select('id').single()
    if (impErr || !imp) throw new Error(`Failed to seed import: ${impErr?.message}`)

    const { data: per, error: perErr } = await supabase
      .from('reconciliation_periods')
      .insert({
        firm_id:                  prop.firm_id,
        bank_account_id:          accountId,
        period_start:             periodDates.period_start,
        period_end:               periodDates.period_end,
        status:                   'open',
        bank_statement_import_id: imp.id,
      })
      .select('id').single()
    if (perErr || !per) throw new Error(`Failed to seed period: ${perErr?.message}`)
    return { periodId: per.id, importId: imp.id }
  }

  async function openReviewModal(page: Page, propertyId: string, accountId: string) {
    await page.goto(`/properties/${propertyId}?tab=reconciliation`)
    await goToReconciliationTab(page)
    await page.getByTestId(`recon-start-${accountId}`).click()
    await expect(page.getByRole('dialog', { name: /Reconciliation review/i })).toBeVisible()
  }


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

  // ─────────────────────────────────────────────────────────────────────────
  // 1h.2 — three-pass matching engine + review UI
  // ─────────────────────────────────────────────────────────────────────────

  test('Pass-1 exact match — auto-matched with confidence 1.00 + audit row', async ({ page }) => {
    const { prop, account } = await seedAccount()
    const txn = await seedTransaction(prop, account.id, {
      amountP: 10000, date: '2026-04-15', description: 'Pass-1 candidate', reference: 'INV-PASS1',
    })
    await seedOpenPeriodWithImport(prop, account.id, [
      { index: 0, date: '2026-04-16', amountP: 10000, description: 'Smoke pass-1 stmt row', reference: 'INV-PASS1' },
    ])

    await openReviewModal(page, prop.id, account.id)
    // Pass-1 auto-applies on modal open. Wait for the matched row to render in
    // the auto-matched section (UI signal before DB query — race pattern).
    await expect(page.getByText('Auto-matched (pass 1)')).toBeVisible()
    await expect(page.getByTestId('stmt-row-0')).toBeVisible()

    // DB: transaction.reconciled = true.
    const { data: reload } = await supabase
      .from('transactions').select('reconciled, statement_import_id, reconciled_by').eq('id', txn.id).single()
    expect(reload!.reconciled).toBe(true)
    expect(reload!.statement_import_id).not.toBeNull()

    // DB: audit row exists with action=auto_match and confidence in notes.
    const { data: audit } = await supabase
      .from('reconciliation_audit_log').select('action, notes')
      .eq('bank_account_id', account.id).eq('action', 'auto_match')
    expect(audit).toHaveLength(1)
    expect(audit![0].notes).toContain('RICS Rule 3.7')
    expect(audit![0].notes).toContain('confidence 1.00')

    // Import status moved to 'matched'.
    const { data: imp } = await supabase
      .from('bank_statement_imports').select('status, matched_count, unmatched_count')
      .eq('bank_account_id', account.id).single()
    expect(imp!.status).toBe('matched')
    expect(imp!.matched_count).toBe(1)
    expect(imp!.unmatched_count).toBe(0)
  })

  test('Pass-2 strong match — Suggested with 80% badge — Confirm + audit row', async ({ page }) => {
    const { prop, account } = await seedAccount()
    const txn = await seedTransaction(prop, account.id, {
      amountP: 20000, date: '2026-04-10', description: 'Pass-2 candidate', reference: 'OTHER-REF',
    })
    await seedOpenPeriodWithImport(prop, account.id, [
      // Same amount, 5 days apart, different reference => pass 2 (not 1).
      { index: 0, date: '2026-04-15', amountP: 20000, description: 'Smoke pass-2 stmt row', reference: 'STMT-REF' },
    ])

    await openReviewModal(page, prop.id, account.id)
    await expect(page.getByText('Suggested matches (pass 2)')).toBeVisible()
    await expect(page.getByTestId('confirm-pass-0')).toBeVisible()
    await page.getByTestId('confirm-pass-0').click()

    // Wait for Suggested section to empty (UI signal before DB).
    await expect(page.getByTestId('confirm-pass-0')).toHaveCount(0)

    const { data: reload } = await supabase
      .from('transactions').select('reconciled').eq('id', txn.id).single()
    expect(reload!.reconciled).toBe(true)

    const { data: audit } = await supabase
      .from('reconciliation_audit_log').select('action, notes')
      .eq('bank_account_id', account.id).eq('action', 'manual_match')
    expect(audit!.length).toBeGreaterThanOrEqual(1)
    expect(audit![0].notes).toContain('RICS Rule 3.7')
    expect(audit![0].notes).toContain('confidence 0.80')
  })

  test('Pass-3 weak match (amount-to-penny + ±30 days subclause) — Review carefully + Confirm', async ({ page }) => {
    const { prop, account } = await seedAccount()
    const txn = await seedTransaction(prop, account.id, {
      amountP: 30000, date: '2026-04-01', description: 'Pass-3 subclause-A candidate',
    })
    await seedOpenPeriodWithImport(prop, account.id, [
      // Same amount-to-penny, 24 days apart (within 30, > 7) => pass 3 subclause A.
      { index: 0, date: '2026-04-25', amountP: 30000, description: 'Smoke pass-3a stmt row' },
    ])

    await openReviewModal(page, prop.id, account.id)
    await expect(page.getByText('Review carefully (pass 3)')).toBeVisible()
    await page.getByTestId('confirm-pass-0').click()
    await expect(page.getByTestId('confirm-pass-0')).toHaveCount(0)

    const { data: reload } = await supabase
      .from('transactions').select('reconciled').eq('id', txn.id).single()
    expect(reload!.reconciled).toBe(true)

    const { data: audit } = await supabase
      .from('reconciliation_audit_log').select('notes')
      .eq('bank_account_id', account.id).eq('action', 'manual_match')
    expect(audit!.some(a => a.notes!.includes('confidence 0.50'))).toBe(true)
  })

  test('Pass-3 weak match (£0.50 tolerance + ±7 days subclause — foreign card rounding)', async ({ page }) => {
    // Smoke 7b — locks the disjunctive Pass-3 subclause B path. Different
    // code branch from smoke 7's amount-to-penny + ±30-day path.
    const { prop, account } = await seedAccount()
    const txn = await seedTransaction(prop, account.id, {
      amountP: 10000, date: '2026-04-15', description: 'Pass-3 subclause-B candidate',
    })
    await seedOpenPeriodWithImport(prop, account.id, [
      // Amount differs by 30p (within 50p), date 2 days apart (within 7) =>
      // pass 3 subclause B. Pass 1 / 2 require amount-to-penny so cannot match.
      { index: 0, date: '2026-04-17', amountP: 10030, description: 'Smoke pass-3b stmt row' },
    ])

    await openReviewModal(page, prop.id, account.id)
    await expect(page.getByText('Review carefully (pass 3)')).toBeVisible()
    await page.getByTestId('confirm-pass-0').click()
    await expect(page.getByTestId('confirm-pass-0')).toHaveCount(0)

    const { data: reload } = await supabase
      .from('transactions').select('reconciled').eq('id', txn.id).single()
    expect(reload!.reconciled).toBe(true)
  })

  test('Dedup — pass-1 match removes its txn from pass-2 candidate pool', async ({ page }) => {
    const { prop, account } = await seedAccount()
    // Two txns at £100 on 2026-04-15. txnA has ref "A"; txnB has different ref.
    const txnA = await seedTransaction(prop, account.id, {
      amountP: 10000, date: '2026-04-15', description: 'Dedup A', reference: 'DEDUP-A',
    })
    const txnB = await seedTransaction(prop, account.id, {
      amountP: 10000, date: '2026-04-15', description: 'Dedup B', reference: 'DEDUP-B',
    })
    // Two stmt rows, both £100, both 2026-04-15. Row 0 ref "DEDUP-A" pass-1
    // matches txnA. Row 1 has no ref — pass-2 must match txnB (txnA already used).
    await seedOpenPeriodWithImport(prop, account.id, [
      { index: 0, date: '2026-04-15', amountP: 10000, description: 'Dedup stmt 0', reference: 'DEDUP-A' },
      { index: 1, date: '2026-04-15', amountP: 10000, description: 'Dedup stmt 1' },
    ])

    await openReviewModal(page, prop.id, account.id)
    // Wait for both sections to populate.
    await expect(page.getByText('Auto-matched (pass 1)')).toBeVisible()
    await expect(page.getByText('Suggested matches (pass 2)')).toBeVisible()

    // After auto-apply: txnA reconciled (pass 1). txnB not yet reconciled.
    const { data: a } = await supabase
      .from('transactions').select('reconciled').eq('id', txnA.id).single()
    expect(a!.reconciled).toBe(true)
    const { data: b } = await supabase
      .from('transactions').select('reconciled').eq('id', txnB.id).single()
    expect(b!.reconciled).toBe(false)

    // Click Confirm on row 1 — should match txnB (only remaining candidate).
    await page.getByTestId('confirm-pass-1').click()
    await expect(page.getByTestId('confirm-pass-1')).toHaveCount(0)

    const { data: bAfter } = await supabase
      .from('transactions').select('reconciled, statement_import_id').eq('id', txnB.id).single()
    expect(bAfter!.reconciled).toBe(true)
  })

  test('Unmatched — Create new transaction prefills + saves with reconciled=true', async ({ page }) => {
    const { prop, account } = await seedAccount()
    // No candidate transactions seeded — stmt row will be unmatched.
    await seedOpenPeriodWithImport(prop, account.id, [
      { index: 0, date: '2026-04-15', amountP: 50000, description: 'Smoke create-new stmt row', reference: 'CREATE-001' },
    ])

    await openReviewModal(page, prop.id, account.id)
    await expect(page.getByText('Unmatched rows')).toBeVisible()
    await expect(page.getByTestId('unmatched-row-0')).toBeVisible()

    await page.getByTestId('action-create-0').click()
    // Sub-form opens prefilled with row description.
    await expect(page.getByTestId('create-description')).toHaveValue(/Smoke create-new stmt row/)
    await page.getByTestId('action-submit').click()

    // Action form closes (UI signal before DB).
    await expect(page.getByTestId('action-submit')).toHaveCount(0)

    const { data: txns } = await supabase
      .from('transactions').select('id, amount, reconciled, statement_import_id, description')
      .eq('bank_account_id', account.id)
    expect(txns).toHaveLength(1)
    expect(txns![0].reconciled).toBe(true)
    expect(txns![0].statement_import_id).not.toBeNull()
    expect(Number(txns![0].amount)).toBe(500)
  })

  test('Unmatched — Match manually picker filters to unreconciled txns and links on select', async ({ page }) => {
    const { prop, account } = await seedAccount()
    // Seed a txn with mismatched amount/date so it doesn't auto-match anything.
    const txn = await seedTransaction(prop, account.id, {
      amountP: 75000, date: '2026-01-01', description: 'Smoke manual-pick candidate', reference: 'OFFCYCLE',
    })
    await seedOpenPeriodWithImport(prop, account.id, [
      // Wildly different amount + far-from-date so no automatic pass matches.
      { index: 0, date: '2026-04-15', amountP: 99999, description: 'Smoke manual-pick stmt row', reference: 'STMT-MAN' },
    ])

    await openReviewModal(page, prop.id, account.id)
    await page.getByTestId('action-manual-0').click()

    // Picker shows the seeded txn.
    const picker = page.getByTestId('manual-pick-txn')
    await expect(picker).toBeVisible()
    await picker.selectOption(txn.id)
    await page.getByTestId('action-submit').click()
    await expect(page.getByTestId('action-submit')).toHaveCount(0)

    const { data: reload } = await supabase
      .from('transactions').select('reconciled, statement_import_id').eq('id', txn.id).single()
    expect(reload!.reconciled).toBe(true)

    const { data: audit } = await supabase
      .from('reconciliation_audit_log').select('notes')
      .eq('bank_account_id', account.id).eq('action', 'manual_match')
    expect(audit!.some(a => a.notes!.includes('manual match of unmatched statement row'))).toBe(true)
  })

  test('Unmatched — Mark as suspense inserts suspense_items row + audit row', async ({ page }) => {
    const { prop, account } = await seedAccount()
    const { importId } = await seedOpenPeriodWithImport(prop, account.id, [
      { index: 0, date: '2026-04-15', amountP: 88800, description: 'Smoke suspense stmt row' },
    ])

    await openReviewModal(page, prop.id, account.id)
    await page.getByTestId('action-suspense-0').click()
    await page.getByTestId('suspense-reason').fill('Unidentified incoming transfer — investigating with the bank')
    await page.getByTestId('suspense-target-date').fill('2026-05-15')
    await page.getByTestId('action-submit').click()
    await expect(page.getByTestId('action-submit')).toHaveCount(0)

    const { data: si } = await supabase
      .from('suspense_items').select('amount, description, status, target_resolution_date, resolution_notes')
      .eq('bank_statement_import_id', importId)
    expect(si).toHaveLength(1)
    expect(si![0].status).toBe('open')
    expect(Number(si![0].amount)).toBe(888)
    expect(si![0].target_resolution_date).toBe('2026-05-15')

    const { data: audit } = await supabase
      .from('reconciliation_audit_log').select('notes')
      .eq('bank_account_id', account.id).eq('action', 'suspense')
    expect(audit).toHaveLength(1)
    expect(audit![0].notes).toContain('RICS Rule 3.7')
    expect(audit![0].notes).toContain('investigating with the bank')
  })

  test('Unmatched — Reject statement row writes audit row citing RICS Rule 3.7', async ({ page }) => {
    const { prop, account } = await seedAccount()
    await seedOpenPeriodWithImport(prop, account.id, [
      { index: 0, date: '2026-04-15', amountP: 12345, description: 'Smoke reject stmt row' },
    ])

    await openReviewModal(page, prop.id, account.id)
    await page.getByTestId('action-reject-0').click()
    await page.getByTestId('reject-reason').fill('Duplicate of an earlier statement row')
    await page.getByTestId('action-submit').click()
    await expect(page.getByTestId('action-submit')).toHaveCount(0)

    const { data: audit } = await supabase
      .from('reconciliation_audit_log').select('notes, action')
      .eq('bank_account_id', account.id).eq('action', 'reject')
    expect(audit).toHaveLength(1)
    expect(audit![0].notes).toContain('RICS Rule 3.7')
    expect(audit![0].notes).toContain('Duplicate of an earlier statement row')

    // No transactions row should be created on reject.
    const { data: txns } = await supabase
      .from('transactions').select('id').eq('bank_account_id', account.id)
    expect(txns ?? []).toHaveLength(0)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 1h.3 — completion + £0.01 balance gate + suspense override + 2b
  // ─────────────────────────────────────────────────────────────────────────

  /** Open the per-account "Mark complete" modal from the Reconciliation tab. */
  async function openCompleteModal(page: Page, propertyId: string, accountId: string) {
    await page.goto(`/properties/${propertyId}?tab=reconciliation`)
    await goToReconciliationTab(page)
    await page.getByTestId(`recon-complete-${accountId}`).click()
    await expect(page.getByRole('dialog', { name: /Mark reconciliation complete/i })).toBeVisible()
  }

  /** Seed a period + import in 'matched' status (i.e. ready for completion).
   *  Convenience wrapper around seedOpenPeriodWithImport — additionally flips
   *  the import to 'matched' since 1h.3 only surfaces "Mark complete" past
   *  that boundary. Caller is responsible for any txns that should sit in the
   *  period reconciled. */
  async function seedMatchedPeriod(
    prop: { id: string; firm_id: string },
    accountId: string,
    rows: Array<{ index: number; date: string; amountP: number; description: string }>,
    period?: { period_start: string; period_end: string },
  ): Promise<{ periodId: string; importId: string }> {
    const r = await seedOpenPeriodWithImport(prop, accountId, rows, period)
    await supabase.from('bank_statement_imports')
      .update({ status: 'matched', matched_count: rows.length, unmatched_count: 0 })
      .eq('id', r.importId)
    return r
  }

  test('Completion blocked when unreconciled transactions remain in period', async ({ page }) => {
    const { prop, account } = await seedAccount()
    // Seed a transaction in the period that's unreconciled.
    await seedTransaction(prop, account.id, {
      amountP: 50000, date: '2026-04-15', description: 'Period txn (unreconciled)',
    })
    await seedMatchedPeriod(prop, account.id, [
      { index: 0, date: '2026-04-15', amountP: 50000, description: 'Smoke 13 stmt row' },
    ])

    await openCompleteModal(page, prop.id, account.id)

    // Pre-flight surfaces the unreconciled-txn block.
    await expect(page.getByTestId('pf-unreconciled')).toHaveAttribute('data-ok', 'false')
    await expect(page.getByTestId('pf-unreconciled')).toContainText(/transaction\(s\) in \[2026-04-01, 2026-04-30\] are not yet reconciled/)
    await expect(page.getByTestId('complete-submit')).toBeDisabled()

    // No completion happened.
    const { data: per } = await supabase
      .from('reconciliation_periods').select('status').eq('bank_account_id', account.id).single()
    expect(per!.status).toBe('open')
  })

  test('Completion blocked with >£0.01 balance discrepancy (corrupted current_balance)', async ({ page }) => {
    const { prop, account } = await seedAccount()
    // Seed a reconciled transaction so the unreconciled-count check passes.
    const { error: txnInsertErr, data: txn } = await supabase.from('transactions').insert({
      firm_id: prop.firm_id, property_id: prop.id, bank_account_id: account.id,
      transaction_type: 'receipt', transaction_date: '2026-04-15',
      amount: 250.00,
      description: `${TXN_PREFIX} balance-check txn`,
      reconciled: true, reconciled_at: new Date().toISOString(),
    }).select('id').single()
    if (txnInsertErr || !txn) throw new Error(txnInsertErr?.message)

    // Inject a balance divergence via direct UPDATE — the trigger only fires
    // on transactions changes, so a direct UPDATE on bank_accounts is allowed
    // and creates the divergence the £0.01 gate is designed to catch.
    const { error: corruptErr } = await supabase
      .from('bank_accounts').update({ current_balance: 251.00 }).eq('id', account.id)
    if (corruptErr) throw new Error(corruptErr.message)

    await seedMatchedPeriod(prop, account.id, [
      { index: 0, date: '2026-04-15', amountP: 25000, description: 'Smoke 14 stmt row' },
    ])

    await openCompleteModal(page, prop.id, account.id)
    await expect(page.getByTestId('pf-balance')).toHaveAttribute('data-ok', 'false')
    await expect(page.getByTestId('pf-balance')).toContainText(/Discrepancy of £1\.00/)
    await expect(page.getByTestId('pf-balance')).toContainText(/Spec §5\.3 blocks completion/)
    await expect(page.getByTestId('complete-submit')).toBeDisabled()

    const { data: per } = await supabase
      .from('reconciliation_periods').select('status').eq('bank_account_id', account.id).single()
    expect(per!.status).toBe('open')
  })

  test('Completion succeeds with no suspense — period completed + audit row + last_reconciled_at', async ({ page }) => {
    const { prop, account } = await seedAccount()
    // Reconciled transaction so unreconciled-count = 0; balance trigger keeps current_balance in sync.
    const { error: txnErr } = await supabase.from('transactions').insert({
      firm_id: prop.firm_id, property_id: prop.id, bank_account_id: account.id,
      transaction_type: 'receipt', transaction_date: '2026-04-15',
      amount: 100.00,
      description: `${TXN_PREFIX} smoke 15 reconciled`,
      reconciled: true, reconciled_at: new Date().toISOString(),
    })
    if (txnErr) throw new Error(txnErr.message)

    const { periodId, importId } = await seedMatchedPeriod(prop, account.id, [
      { index: 0, date: '2026-04-15', amountP: 10000, description: 'Smoke 15 stmt row' },
    ])

    await openCompleteModal(page, prop.id, account.id)
    await expect(page.getByTestId('pf-unmatched')).toHaveAttribute('data-ok', 'true')
    await expect(page.getByTestId('pf-unreconciled')).toHaveAttribute('data-ok', 'true')
    await expect(page.getByTestId('pf-balance')).toHaveAttribute('data-ok', 'true')
    await page.getByTestId('complete-submit').click()

    // Modal closes after completion.
    await expect(page.getByRole('dialog', { name: /Mark reconciliation complete/i })).toHaveCount(0)

    // Period marked completed with the audit columns stamped.
    const { data: per } = await supabase
      .from('reconciliation_periods')
      .select('status, completed_at, completed_by, closing_balance_snapshot, suspense_carried_forward')
      .eq('id', periodId).single()
    expect(per!.status).toBe('completed')
    expect(per!.completed_at).not.toBeNull()
    expect(per!.completed_by).not.toBeNull()
    expect(Number(per!.closing_balance_snapshot)).toBe(100)
    expect(per!.suspense_carried_forward).toBe(false)

    // bank_accounts.last_reconciled_at stamped.
    const { data: acc } = await supabase
      .from('bank_accounts').select('last_reconciled_at').eq('id', account.id).single()
    expect(acc!.last_reconciled_at).not.toBeNull()

    // Import status final.
    const { data: imp } = await supabase
      .from('bank_statement_imports').select('status').eq('id', importId).single()
    expect(imp!.status).toBe('complete')

    // Audit row.
    const { data: audit } = await supabase
      .from('reconciliation_audit_log').select('action, notes, after_state')
      .eq('bank_account_id', account.id).eq('action', 'completion')
    expect(audit).toHaveLength(1)
    expect(audit![0].notes).toContain('RICS Rule 3.7')
    expect(audit![0].notes).toContain('no carried-forward suspense')
  })

  test('Completion with open suspense in period requires completion_notes — saves with suspense_carried_forward=true', async ({ page }) => {
    const { prop, account } = await seedAccount()
    // Reconciled txn for the no-unreconciled-txn check.
    await supabase.from('transactions').insert({
      firm_id: prop.firm_id, property_id: prop.id, bank_account_id: account.id,
      transaction_type: 'receipt', transaction_date: '2026-04-15',
      amount: 50.00,
      description: `${TXN_PREFIX} smoke 16 reconciled`,
      reconciled: true, reconciled_at: new Date().toISOString(),
    })

    const { periodId, importId } = await seedMatchedPeriod(prop, account.id, [
      { index: 0, date: '2026-04-15', amountP: 5000, description: 'Smoke 16 stmt row' },
    ])

    // Seed an open suspense item dated within the period.
    await supabase.from('suspense_items').insert({
      firm_id: prop.firm_id,
      bank_statement_import_id: importId,
      statement_row_index: 0,
      amount: 99.99,
      statement_date: '2026-04-20',
      description: 'Smoke 16 suspense row',
      target_resolution_date: '2026-05-30',
      status: 'open',
      resolution_notes: 'Pending bank confirmation',
    })

    await openCompleteModal(page, prop.id, account.id)

    // Override card visible. Submit disabled until checkbox + notes complete.
    await expect(page.getByTestId('carry-forward-checkbox')).toBeVisible()
    await expect(page.getByTestId('completion-notes')).toBeVisible()
    await expect(page.getByTestId('complete-submit')).toBeDisabled()

    await page.getByTestId('carry-forward-checkbox').check()
    // Still disabled until notes are filled.
    await expect(page.getByTestId('complete-submit')).toBeDisabled()
    await page.getByTestId('completion-notes').fill('Awaiting clearing-bank confirmation; carried into next period per agreed treatment.')
    await expect(page.getByTestId('complete-submit')).toBeEnabled()
    await page.getByTestId('complete-submit').click()
    await expect(page.getByRole('dialog', { name: /Mark reconciliation complete/i })).toHaveCount(0)

    const { data: per } = await supabase
      .from('reconciliation_periods')
      .select('status, suspense_carried_forward, completion_notes')
      .eq('id', periodId).single()
    expect(per!.status).toBe('completed')
    expect(per!.suspense_carried_forward).toBe(true)
    expect(per!.completion_notes).toContain('Awaiting clearing-bank confirmation')

    const { data: audit } = await supabase
      .from('reconciliation_audit_log').select('notes')
      .eq('bank_account_id', account.id).eq('action', 'completion')
    expect(audit).toHaveLength(1)
    expect(audit![0].notes).toContain('1 suspense item(s) carried forward')
  })

  test('Completed period is immutable — Mark complete button absent on completed rows', async ({ page }) => {
    const { prop, account } = await seedAccount()
    await supabase.from('transactions').insert({
      firm_id: prop.firm_id, property_id: prop.id, bank_account_id: account.id,
      transaction_type: 'receipt', transaction_date: '2026-04-15',
      amount: 100.00,
      description: `${TXN_PREFIX} smoke 17 reconciled`,
      reconciled: true, reconciled_at: new Date().toISOString(),
    })
    const { periodId } = await seedMatchedPeriod(prop, account.id, [
      { index: 0, date: '2026-04-15', amountP: 10000, description: 'Smoke 17 stmt row' },
    ])

    // Drive the period to completed via direct DB writes (faster than UI).
    const userIdRow = await supabase.from('users').select('id').eq('email', 'admin@propos.local').single()
    await supabase.from('reconciliation_periods').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      completed_by: userIdRow.data!.id,
      closing_balance_snapshot: 100,
      suspense_carried_forward: false,
    }).eq('id', periodId)
    await supabase.from('bank_statement_imports')
      .update({ status: 'complete' })
      .eq('bank_account_id', account.id)
    await supabase.from('bank_accounts')
      .update({ last_reconciled_at: new Date().toISOString() })
      .eq('id', account.id)

    await page.goto(`/properties/${prop.id}?tab=reconciliation`)
    await goToReconciliationTab(page)

    // Reconciled-to date badge visible (replaces the "in progress" / never).
    await expect(page.getByTestId(`recon-status-${account.id}`)).toContainText(/Reconciled to/)
    // Mark complete button is gone (no openPeriod after completion → canComplete=false).
    await expect(page.getByTestId(`recon-complete-${account.id}`)).toHaveCount(0)
    // Start reconciliation button is back (lets PM open a fresh period).
    await expect(page.getByTestId(`recon-start-${account.id}`)).toContainText(/Start reconciliation/)
  })

  test('2b — cannot create a second open reconciliation_period for the same bank account', async () => {
    // Pure-DB smoke. Verifies the partial unique index in 00025
    // (uq_recperiod_one_open_per_account WHERE status='open') rejects a
    // second open row with code 23505. UI-level protection rides on this
    // (StatementImportModal surfaces a friendly message on 23505).
    const { prop, account } = await seedAccount()
    const { error: firstErr } = await supabase
      .from('reconciliation_periods')
      .insert({
        firm_id: prop.firm_id, bank_account_id: account.id,
        period_start: '2026-04-01', period_end: '2026-04-30', status: 'open',
      })
    expect(firstErr).toBeNull()

    const { error: secondErr } = await supabase
      .from('reconciliation_periods')
      .insert({
        firm_id: prop.firm_id, bank_account_id: account.id,
        period_start: '2026-05-01', period_end: '2026-05-31', status: 'open',
      })
    expect(secondErr).not.toBeNull()
    expect(secondErr!.code).toBe('23505')
  })
})
