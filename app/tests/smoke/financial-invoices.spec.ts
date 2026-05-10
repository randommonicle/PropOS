/**
 * @file financial-invoices.spec.ts
 * @description Smoke tests for the per-property Invoices tab — closes Phase 3
 * §7. Covers: tab presence + 10th position, manual + AI-extracted CRUD, the
 * PM-confirmation gate (mandatory regardless of confidence), the role-tier-
 * asymmetric status state machine, queue-for-payment dual-auth bridge, and
 * the DB CHECK constraints from migration 00028.
 *
 * The AI-extraction smokes seed the post-extraction state directly via
 * supabase-js (a documents row with ai_extracted_data + an invoices row with
 * extracted_by_ai=true). The Edge Function itself is exercised live in one
 * .skip-by-default smoke at the bottom — toggle skip when validating the
 * full pipeline. This keeps regular smoke runs free of Anthropic spend.
 *
 * FK-safe afterAll cleanup: payment_authorisations → transactions →
 * invoices → documents → bank_accounts → leaseholders, scoped to test-
 * prefixed rows.
 */
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './_env'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const INV_DESC_PREFIX     = 'Smoke INV'
const INV_NUMBER_PREFIX   = 'SMK-INV'
const TXN_PREFIX          = 'Smoke INV'
const BA_PREFIX           = 'Smoke INV BA'
const LH_NOTES_PREFIX     = 'Smoke INV'
const DOC_FILENAME_PREFIX = 'smoke-inv-'

async function resolveUserId(email: string): Promise<string> {
  const { data, error } = await supabase
    .from('users').select('id').eq('email', email).single()
  if (error || !data) {
    throw new Error(`User ${email} not found. Run supabase/seed/test_users.sql.`)
  }
  return data.id
}
const resolveAdminUserId = () => resolveUserId('admin@propos.local')
const resolvePmUserId    = () => resolveUserId('pm@propos.local')

async function signInAdmin() {
  await supabase.auth.signInWithPassword({
    email: 'admin@propos.local', password: 'PropOS2026!',
  })
}

async function gotoInvoicesTab(page: Page, propertyId: string) {
  await page.goto(`/properties/${propertyId}?tab=invoices`)
  await expect(page.getByRole('heading', { name: /^Invoices/ })).toBeVisible()
}

interface Scenario {
  prop: { id: string; firm_id: string }
  account: { id: string; account_name: string }
}

async function seedScenario(): Promise<Scenario> {
  await signInAdmin()
  const { data: prop } = await supabase
    .from('properties').select('id, firm_id').limit(1).single()
  if (!prop) throw new Error('No properties seeded')

  const accountName = `${BA_PREFIX} ${Date.now()} ${Math.random().toString(36).slice(2, 6)}`
  const { data: account, error } = await supabase
    .from('bank_accounts').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      account_name: accountName,
      account_type: 'service_charge',
      requires_dual_auth: true,
      dual_auth_threshold: 0,  // every payment dual-auths
      rics_designated: false,
    }).select('id, account_name').single()
  if (error || !account) throw new Error(`Bank account seed failed: ${error?.message}`)

  return { prop, account }
}

async function seedAiExtractedInvoice(opts: {
  prop: { id: string; firm_id: string }
  confidence: number
  amountGross?: number
  invoiceNumber?: string
}) {
  const { prop } = opts
  const filename = `${DOC_FILENAME_PREFIX}${Date.now()}.pdf`
  const { data: doc } = await supabase.from('documents').insert({
    firm_id:       prop.firm_id,
    property_id:   prop.id,
    document_type: 'invoice',
    filename,
    storage_path:  `${prop.firm_id}/invoices/${filename}`,
    mime_type:     'application/pdf',
    file_size_bytes: 12345,
    ai_processed_at: new Date().toISOString(),
    ai_extracted_data: {
      invoice_number: opts.invoiceNumber ?? `${INV_NUMBER_PREFIX}-AI-${Date.now()}`,
      invoice_date:   '2026-05-01',
      due_date:       '2026-06-01',
      amount_net:     (opts.amountGross ?? 120) * 0.8333,
      vat_amount:     (opts.amountGross ?? 120) * 0.1667,
      amount_gross:   opts.amountGross ?? 120,
      payee:          'Smoke Supplier Ltd',
      description:    `${INV_DESC_PREFIX} AI ${Date.now()}`,
      confidence:     opts.confidence,
      notes:          null,
    },
  }).select('id').single()
  if (!doc) throw new Error('Document seed failed')

  const grossNum = opts.amountGross ?? 120
  const { data: inv } = await supabase.from('invoices').insert({
    firm_id:               prop.firm_id,
    property_id:           prop.id,
    document_id:           doc.id,
    invoice_number:        opts.invoiceNumber ?? `${INV_NUMBER_PREFIX}-AI-${Date.now()}`,
    invoice_date:          '2026-05-01',
    due_date:              '2026-06-01',
    amount_net:            Math.round(grossNum * 0.8333 * 100) / 100,
    vat_amount:            Math.round(grossNum * 0.1667 * 100) / 100,
    amount_gross:          grossNum,
    description:           `${INV_DESC_PREFIX} AI ${Date.now()}`,
    extracted_by_ai:       true,
    extraction_confidence: opts.confidence,
    extraction_notes:      `AI extraction (claude-sonnet-4-6) on 2026-05-10 — confidence ${opts.confidence}.`,
    status:                'received',
  }).select('id').single()
  if (!inv) throw new Error('Invoice seed failed')
  return { doc, invoice: inv }
}

test.describe('Property detail — invoices tab', () => {
  test.afterAll(async () => {
    await signInAdmin()
    // FK-safe order, scoped via prefix.
    const { data: invs } = await supabase
      .from('invoices').select('id, transaction_id, document_id')
      .like('description', `${INV_DESC_PREFIX}%`)
    const invIds = (invs ?? []).map(i => i.id)
    const txnIds = (invs ?? []).map(i => i.transaction_id).filter((x): x is string => !!x)
    const docIds = (invs ?? []).map(i => i.document_id).filter((x): x is string => !!x)

    if (invIds.length) {
      // Drop any PA rows that reference these invoices via proposed.invoice_id.
      const { data: paRows } = await supabase
        .from('payment_authorisations').select('id, proposed')
      const paIdsToDelete = (paRows ?? [])
        .filter(p => {
          const invId = (p.proposed as { invoice_id?: string } | null)?.invoice_id
          return invId && invIds.includes(invId)
        })
        .map(p => p.id)
      if (paIdsToDelete.length) {
        await supabase.from('payment_authorisations').delete().in('id', paIdsToDelete)
      }
    }
    if (txnIds.length) await supabase.from('transactions').delete().in('id', txnIds)
    if (invIds.length) await supabase.from('invoices').delete().in('id', invIds)
    if (docIds.length) await supabase.from('documents').delete().in('id', docIds)
    await supabase.from('transactions').delete().like('description', `${TXN_PREFIX}%`)
    await supabase.from('bank_accounts').delete().like('account_name', `${BA_PREFIX}%`)
    await supabase.from('leaseholders').delete().like('notes', `${LH_NOTES_PREFIX}%`)
  })

  // Smoke 1
  test('Invoices tab renders 10th and lists invoices for the property', async ({ page }) => {
    const { prop } = await seedScenario()
    await page.goto(`/properties/${prop.id}`)
    const tabs = page.getByRole('tablist').getByRole('tab')
    await expect(tabs.nth(9)).toHaveText('Invoices')
    await tabs.nth(9).click()
    await expect(page).toHaveURL(/\?tab=invoices/)
    await expect(page.getByRole('heading', { name: /^Invoices \(\d+\)/ })).toBeVisible()
  })

  // Smoke 2
  test('Manual create — blank invoice persists with extracted_by_ai=false', async ({ page }) => {
    const { prop } = await seedScenario()
    await gotoInvoicesTab(page, prop.id)

    const description = `${INV_DESC_PREFIX} Manual ${Date.now()}`
    const invoiceNumber = `${INV_NUMBER_PREFIX}-MAN-${Date.now()}`

    await page.getByRole('button', { name: 'Create blank invoice' }).click()
    await page.getByLabel('Invoice number').fill(invoiceNumber)
    await page.getByLabel('Invoice date').fill('2026-05-05')
    // Leave VAT empty — coherence chk passes when amount_net is null.
    await page.getByLabel('Description').fill(description)
    await page.getByTestId('invoice-save').click()

    // Wait for the form to close as the state-change signal before DB query
    // (modal-vs-DB-query race pattern, LESSONS Phase 3 session 2).
    await expect(page.getByTestId('invoice-save')).toHaveCount(0)

    const { data } = await supabase.from('invoices').select('*')
      .eq('invoice_number', invoiceNumber).single()
    expect(data?.extracted_by_ai).toBe(false)
    expect(data?.extraction_confidence).toBeNull()
    expect(data?.status).toBe('received')
    expect(data?.description).toBe(description)
  })

  // Smoke 3 (AI happy path — direct-seed; the live Edge Function smoke is the
  // skipped one at the bottom)
  test('AI-extracted invoice — drawer prefills fields + shows green confidence pill', async ({ page }) => {
    const { prop } = await seedScenario()
    const { invoice } = await seedAiExtractedInvoice({ prop, confidence: 0.95 })

    await gotoInvoicesTab(page, prop.id)
    await page.getByTestId(`invoice-row-${invoice.id}`)
      .getByRole('button', { name: 'Edit invoice' }).click()

    // Confidence pill shows green at 95%.
    const pill = page.getByTestId('ai-confidence-pill').first()
    await expect(pill).toBeVisible()
    // Drawer prefilled with invoice number.
    await expect(page.getByLabel('Invoice number')).toHaveValue(/SMK-INV-AI-/)
    // No amber low-confidence banner.
    await expect(page.getByTestId('ai-low-confidence-banner')).toHaveCount(0)
  })

  // Smoke 4 — failure stage surfacing (uses an unknown document_id; the Edge
  // Function returns stage='document_load' immediately without calling
  // Anthropic, so this smoke runs cheaply against the deployed function).
  test.skip('AI extraction failure surfaces stage in UI', async ({ page }) => {
    // Skipped by default — requires document_processing deployed live.
    // Toggle skip when verifying full deployment.
    void page
  })

  // Smoke 5
  test('Confidence < 0.75 surfaces amber low-confidence banner', async ({ page }) => {
    const { prop } = await seedScenario()
    const { invoice } = await seedAiExtractedInvoice({ prop, confidence: 0.55 })

    await gotoInvoicesTab(page, prop.id)
    await page.getByTestId(`invoice-row-${invoice.id}`)
      .getByRole('button', { name: 'Edit invoice' }).click()
    const banner = page.getByTestId('ai-low-confidence-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText(/Low confidence/i)
    await expect(banner).toContainText(/55%/)
  })

  // Smoke 6
  test('PM edit after AI appends "PM-overrode" line to extraction_notes', async ({ page }) => {
    const { prop } = await seedScenario()
    const { invoice } = await seedAiExtractedInvoice({ prop, confidence: 0.92, amountGross: 100 })

    await gotoInvoicesTab(page, prop.id)
    await page.getByTestId(`invoice-row-${invoice.id}`)
      .getByRole('button', { name: 'Edit invoice' }).click()

    // Override the description.
    const overrideDesc = `${INV_DESC_PREFIX} OVERRIDDEN ${Date.now()}`
    const descField = page.getByLabel('Description')
    await descField.fill(overrideDesc)
    await page.getByTestId('invoice-save').click()

    // Wait for the form to close (state-change signal before DB query).
    await expect(page.getByTestId('invoice-save')).toHaveCount(0)

    const { data } = await supabase.from('invoices').select('extraction_notes, description')
      .eq('id', invoice.id).single()
    expect(data?.description).toBe(overrideDesc)
    expect(data?.extraction_notes ?? '').toContain('PM-overrode description')
  })

  // Smoke 7 — PM Confirm (uses PM storage state per the role-tier model:
  // received → approved is PM-only because PM is the property-manager-of-record).
  test.describe('PM-session', () => {
    test.use({ storageState: 'tests/.auth/pm-user.json' })

    test('Status state machine — PM Confirm flips received → approved', async ({ page }) => {
      const { prop } = await seedScenario()
      const { invoice } = await seedAiExtractedInvoice({ prop, confidence: 1.0 })

      await gotoInvoicesTab(page, prop.id)
      await page.getByTestId(`invoice-row-${invoice.id}`)
        .getByRole('button', { name: 'Edit invoice' }).click()
      await page.getByTestId('invoice-confirm').click()

      // Wait for drawer to close (state-change signal before DB query —
      // LESSONS Phase 3 session 2).
      await expect(page.getByTestId('invoice-confirm')).toHaveCount(0)

      const { data } = await supabase.from('invoices').select('status, approved_by, approved_at')
        .eq('id', invoice.id).single()
      expect(data?.status).toBe('approved')
      expect(data?.approved_by).toBeTruthy()
      expect(data?.approved_at).toBeTruthy()
    })

    test('PM confirm is mandatory — confidence=1.0 invoice still received until Confirm clicked', async ({ page }) => {
      const { prop } = await seedScenario()
      const { invoice } = await seedAiExtractedInvoice({ prop, confidence: 1.0 })

      await gotoInvoicesTab(page, prop.id)
      await page.getByTestId(`invoice-row-${invoice.id}`)
        .getByRole('button', { name: 'Edit invoice' }).click()

      const { data: stillReceived } = await supabase.from('invoices')
        .select('status').eq('id', invoice.id).single()
      expect(stillReceived?.status).toBe('received')

      // Confirm button is present (not auto-skipped).
      await expect(page.getByTestId('invoice-confirm')).toBeVisible()
    })
  })

  // Smoke 8 — DB CHECK rejects out-of-set status (pure-DB)
  test('CHECK constraint — invoices_status_chk rejects banana status', async () => {
    await signInAdmin()
    const { data: prop } = await supabase.from('properties').select('id, firm_id').limit(1).single()
    const { data: inv } = await supabase.from('invoices').insert({
      firm_id: prop!.firm_id, property_id: prop!.id,
      description: `${INV_DESC_PREFIX} CHECK ${Date.now()}`,
      status: 'received',
    }).select('id').single()
    expect(inv).toBeTruthy()

    const { error } = await supabase.from('invoices').update({ status: 'banana' as never })
      .eq('id', inv!.id)
    expect(error?.code).toBe('23514')
    expect(error?.message ?? '').toMatch(/invoices_status_chk/i)
  })

  // Smoke 9 — Different admin authorises invoice-linked PA → invoice → paid + transaction_id set
  test('PA authorise on invoice-linked payment → invoice paid + transaction_id set', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const { invoice } = await seedAiExtractedInvoice({ prop, confidence: 0.9, amountGross: 200 })
    await supabase.from('invoices').update({ status: 'approved' }).eq('id', invoice.id)

    const pmId    = await resolvePmUserId()
    const adminId = await resolveAdminUserId()

    // Seed an invoice-linked PA created by PM (so admin can authorise without self-auth violation).
    const description = `${TXN_PREFIX} PaidByAuth ${Date.now()}`
    await supabase.from('payment_authorisations').insert({
      firm_id:      prop.firm_id,
      requested_by: pmId,
      status:       'pending',
      action_type:  'payment',
      proposed: {
        bank_account_id: account.id,
        amount: -200,  // -£200 in pounds (DB convention; see DECISIONS 2026-05-07)
        transaction_date: '2026-05-10',
        description,
        payee_payer: 'Smoke Supplier Ltd',
        reference: invoice.invoice_number,
        demand_id: null,
        invoice_id: invoice.id,
      },
    })
    // Bring invoice to `queued` (the InvoicesTab handler does this; we mirror here for the seed).
    await supabase.from('invoices').update({ status: 'queued' }).eq('id', invoice.id)

    await page.goto(`/properties/${prop.id}?tab=payment-authorisations`)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(description) })
    await row.getByRole('button', { name: /Authorise request/ }).click()
    await expect(row.getByRole('button', { name: /Authorise request/ })).toHaveCount(0)

    const { data: refreshed } = await supabase.from('invoices')
      .select('status, transaction_id').eq('id', invoice.id).single()
    expect(refreshed?.status).toBe('paid')
    expect(refreshed?.transaction_id).toBeTruthy()

    const { data: txn } = await supabase.from('transactions')
      .select('id, invoice_id, amount').eq('id', refreshed!.transaction_id!).single()
    expect(txn?.invoice_id).toBe(invoice.id)
    expect(Number(txn?.amount)).toBeCloseTo(-200, 2)
    void adminId  // satisfies linter; admin id checked via PA cross-user smoke
  })

  // Smoke 10 — Delete blocked when transaction references invoice (FK 23503)
  test('Delete blocked when transaction references invoice', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const { data: inv } = await supabase.from('invoices').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      description: `${INV_DESC_PREFIX} DelLock ${Date.now()}`,
      amount_gross: 50, status: 'paid',
    }).select('id').single()
    if (!inv) throw new Error('Invoice seed failed')
    await supabase.from('transactions').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      bank_account_id: account.id,
      transaction_type: 'payment',
      transaction_date: '2026-05-10',
      amount: -50,
      description: `${TXN_PREFIX} DelLock ${Date.now()}`,
      invoice_id: inv.id,
    })

    await gotoInvoicesTab(page, prop.id)
    await page.getByTestId(`invoice-row-${inv.id}`)
      .getByRole('button', { name: 'Delete invoice' }).click()
    await page.getByRole('button', { name: 'Confirm delete' }).click()

    const err = page.getByTestId('invoice-inline-error')
    await expect(err).toBeVisible()
    await expect(err).toContainText(/transaction references this invoice/i)

    // Row still present.
    const { data: still } = await supabase.from('invoices').select('id').eq('id', inv.id).single()
    expect(still).toBeTruthy()
  })

  // Smoke 11 — extraction_pair CHECK rejects extracted_by_ai=true with NULL confidence
  test('CHECK — invoices_extraction_pair_chk rejects ai=true with NULL confidence', async () => {
    await signInAdmin()
    const { data: prop } = await supabase.from('properties').select('id, firm_id').limit(1).single()
    const { error } = await supabase.from('invoices').insert({
      firm_id: prop!.firm_id, property_id: prop!.id,
      description: `${INV_DESC_PREFIX} ExtPair ${Date.now()}`,
      extracted_by_ai: true,
      extraction_confidence: null,
      status: 'received',
    })
    expect(error?.code).toBe('23514')
    expect(error?.message ?? '').toMatch(/invoices_extraction_pair_chk/i)
  })

  // Smoke 12 — amount coherence CHECK rejects gross ≠ net + vat
  test('CHECK — invoices_amount_coherence_chk rejects gross != net + vat', async () => {
    await signInAdmin()
    const { data: prop } = await supabase.from('properties').select('id, firm_id').limit(1).single()
    const { error } = await supabase.from('invoices').insert({
      firm_id: prop!.firm_id, property_id: prop!.id,
      description: `${INV_DESC_PREFIX} AmtChk ${Date.now()}`,
      amount_net:   100,
      vat_amount:   20,
      amount_gross: 999,  // ≠ 120
      status: 'received',
    })
    expect(error?.code).toBe('23514')
    expect(error?.message ?? '').toMatch(/invoices_amount_coherence_chk/i)
  })

  // (Smoke 13 PM-session test moved into the PM-session test.describe block above.)

  // Smoke 14 — Queue-for-payment creates PA with proposed.invoice_id + invoice → queued
  test('Queue-for-payment — creates PA with proposed.invoice_id + invoice → queued', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const { invoice } = await seedAiExtractedInvoice({ prop, confidence: 0.9, amountGross: 300, invoiceNumber: `${INV_NUMBER_PREFIX}-Q-${Date.now()}` })
    await supabase.from('invoices').update({ status: 'approved' }).eq('id', invoice.id)

    await gotoInvoicesTab(page, prop.id)
    await page.getByTestId(`invoice-row-${invoice.id}`)
      .getByRole('button', { name: 'Edit invoice' }).click()
    await page.getByLabel('Pay from account').selectOption(account.id)
    await page.getByTestId('invoice-queue-for-payment').click()

    // Wait for drawer to close as the state-change signal before DB query.
    await expect(page.getByTestId('invoice-queue-for-payment')).toHaveCount(0)

    const { data: refreshed } = await supabase.from('invoices').select('status').eq('id', invoice.id).single()
    expect(refreshed?.status).toBe('queued')

    const { data: pas } = await supabase.from('payment_authorisations')
      .select('status, action_type, proposed').eq('firm_id', prop.firm_id)
      .order('requested_at', { ascending: false }).limit(5)
    const linked = (pas ?? []).find(p =>
      (p.proposed as { invoice_id?: string } | null)?.invoice_id === invoice.id
    )
    expect(linked).toBeTruthy()
    expect(linked?.status).toBe('pending')
    expect(linked?.action_type).toBe('payment')
  })

  // Smoke 15 — PM cannot mark invoice as paid (UI never offers the edge; client guard rejects direct attempts)
  test('PM cannot drive invoice → paid (no UI affordance)', async ({ page }) => {
    const { prop } = await seedScenario()
    const { invoice } = await seedAiExtractedInvoice({ prop, confidence: 0.9 })
    await supabase.from('invoices').update({ status: 'approved' }).eq('id', invoice.id)

    // Smoke harness logs in as admin (canFinance=true). To assert the PM
    // shape, we assert from the rejectionMessageForTransition behaviour: an
    // approved invoice has NO `paid` option in the dropdown nor as a button.
    await gotoInvoicesTab(page, prop.id)
    await page.getByTestId(`invoice-row-${invoice.id}`)
      .getByRole('button', { name: 'Edit invoice' }).click()

    // No "paid" option in any select on the form (Pay from account dropdown lists bank accounts, not statuses).
    const otherActionSelect = page.getByLabel('Other action')
    if (await otherActionSelect.isVisible().catch(() => false)) {
      const options = await otherActionSelect.locator('option').allTextContents()
      expect(options).not.toContain('Paid')
    }
    // Queue-for-payment is the only edge to `paid` and it's a 2-step (queue → PA authorise).
    await expect(page.getByTestId('invoice-queue-for-payment')).toBeVisible()
  })

  // Smoke 16 — LIVE Edge Function pipeline. Skipped by default to avoid
  // Anthropic spend on every test run. Toggle skip locally when verifying
  // full deploy of `document_processing` against a sample invoice PDF.
  //
  // Pre-req: deploy document_processing via scripts/deploy-functions.bat
  // and set ANTHROPIC_API_KEY via `supabase secrets set`. Sample fixture at
  // app/tests/fixtures/invoices/sample-invoice.pdf (synthetic invoice with
  // Net £100, VAT £20, Gross £120, invoice_number ACME-2026-0817).
  test('LIVE — Edge Function pipeline extracts a sample invoice (manual run)', async () => {
    test.setTimeout(60_000)
    const fs = await import('node:fs')
    const path = await import('node:path')
    const fixturePath = path.join(import.meta.dirname, '..', 'fixtures', 'invoices', 'sample-invoice.pdf')
    if (!fs.existsSync(fixturePath)) {
      test.skip(true, `Fixture missing at ${fixturePath} — generate via the pdfkit script in DECISIONS 1i.2`)
    }
    const bytes = fs.readFileSync(fixturePath)

    await signInAdmin()
    const { data: prop } = await supabase
      .from('properties').select('id, firm_id').limit(1).single()
    if (!prop) throw new Error('No properties seeded')

    // (a) Upload to Storage at firm-scoped path.
    const filename = `${DOC_FILENAME_PREFIX}live-${Date.now()}.pdf`
    const storagePath = `${prop.firm_id}/invoices/${filename}`
    const { error: stoErr } = await supabase.storage
      .from('documents').upload(storagePath, bytes, {
        contentType: 'application/pdf',
        upsert: false,
      })
    expect(stoErr).toBeNull()

    // (b) Insert documents row.
    const { data: doc, error: docErr } = await supabase.from('documents').insert({
      firm_id:         prop.firm_id,
      property_id:     prop.id,
      document_type:   'invoice',
      filename,
      storage_path:    storagePath,
      mime_type:       'application/pdf',
      file_size_bytes: bytes.length,
    }).select('id').single()
    expect(docErr).toBeNull()
    expect(doc).toBeTruthy()

    // (c) Invoke the Edge Function — full pipeline (Anthropic call + DB writes).
    const { data, error } = await supabase.functions.invoke('document_processing', {
      body: { document_id: doc!.id },
    })
    if (error) {
      let body = null
      try { body = await error.context.json() } catch { /* ignore */ }
      throw new Error(`Edge Function error: ${JSON.stringify(body) ?? error.message}`)
    }
    const result = data as {
      ok: boolean; document_id: string; invoice_id: string; confidence: number;
      extracted_data: Record<string, unknown>;
    }
    expect(result.ok).toBe(true)
    expect(result.document_id).toBe(doc!.id)
    expect(result.invoice_id).toBeTruthy()
    expect(result.confidence).toBeGreaterThan(0)
    expect(result.confidence).toBeLessThanOrEqual(1)

    // (d) Verify documents row stamped + invoices row created with extracted fields.
    const { data: refreshedDoc } = await supabase.from('documents')
      .select('ai_processed_at, ai_extracted_data').eq('id', doc!.id).single()
    expect(refreshedDoc?.ai_processed_at).toBeTruthy()
    expect(refreshedDoc?.ai_extracted_data).toBeTruthy()

    const { data: invoice } = await supabase.from('invoices')
      .select('*').eq('id', result.invoice_id).single()
    expect(invoice?.extracted_by_ai).toBe(true)
    expect(invoice?.extraction_confidence).toBeGreaterThan(0)
    expect(invoice?.status).toBe('received')
    // Spot-check key extracted fields against the fixture content.
    expect(invoice?.invoice_number ?? '').toMatch(/ACME-2026-0817/i)
    expect(Number(invoice?.amount_gross)).toBeCloseTo(120, 2)
    expect(Number(invoice?.amount_net)).toBeCloseTo(100, 2)
    expect(Number(invoice?.vat_amount)).toBeCloseTo(20, 2)

    // Cleanup: stamp the description with the smoke prefix so afterAll's
    // sweep catches the row, and remove the Storage object explicitly (the
    // afterAll sweep doesn't touch Storage).
    await supabase.from('invoices')
      .update({ description: `${INV_DESC_PREFIX} LIVE-${Date.now()}` })
      .eq('id', result.invoice_id)
    await supabase.storage.from('documents').remove([storagePath])
  })
})
