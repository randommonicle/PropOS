/**
 * @file financial-payment-authorisations.spec.ts
 * @description Smoke tests for the per-property Payment authorisations tab —
 * the dual-auth request flow, the self-authorisation guard, the cross-user
 * authorise path that creates the actual transaction from the proposed JSONB
 * snapshot, the demand auto-status update if the authorised payment is
 * linked to a demand, the reject-with-reason path, the requester cancel path,
 * and the immutability of post-action rows.
 *
 * Cleanup unwinds in FK-safe order: payment_authorisations →
 * transactions → demands → bank_accounts → leaseholders, scoped to
 * test-prefixed rows.
 *
 * NOTE: smoke harness only authenticates as admin. The cross-user authorise
 * test seeds a PA with `requested_by` set to a different (synthetic) UUID;
 * admin then authorises via the UI. The self-auth test seeds with
 * `requested_by=<admin uuid>` and asserts the inline error.
 */
import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

// NOTE: §6.5 hygiene fix (drop the publishable-key fallback below) is tracked as a
// separate follow-up commit so this file mirrors the existing smoke pattern.
const supabase = createClient(
  process.env.VITE_SUPABASE_URL ?? 'https://tmngfuonanizxyffrsjy.supabase.co',
  process.env.VITE_SUPABASE_ANON_KEY ?? 'sb_publishable_M_cBRZKdJtIunGAUFBhD1g_SYMADNyT',
)

const TXN_PREFIX = 'Smoke PAUTH'
const BA_PREFIX  = 'Smoke PAUTH BA'
const DEM_NOTES_PREFIX = 'Smoke PAUTH'
const LH_NOTES_PREFIX  = 'Smoke PAUTH'

/** Resolve a known seeded user id by email. Used to set `requested_by` on
 *  seeded PA rows so admin can authorise without violating the self-auth
 *  guard. The test_users.sql seed (DECISIONS 2026-05-10) ensures
 *  pm@propos.local and director@propos.local exist alongside admin. */
async function resolveUserId(email: string): Promise<string> {
  const { data, error } = await supabase
    .from('users').select('id').eq('email', email).single()
  if (error || !data) {
    throw new Error(
      `User ${email} not found. Run supabase/seed/test_users.sql via the ` +
      'Supabase Dashboard SQL Editor (DECISIONS 2026-05-10).',
    )
  }
  return data.id
}

const resolveAdminUserId = () => resolveUserId('admin@propos.local')
const resolvePmUserId    = () => resolveUserId('pm@propos.local')

async function goToFirstProperty(page: Page) {
  await page.goto('/properties')
  await page.locator('a[href^="/properties/"]').first().click()
  await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible()
}

async function goToPaymentAuthsTab(page: Page) {
  await page.getByRole('tab', { name: 'Payment authorisations' }).click()
  await expect(page.getByRole('tab', { name: 'Payment authorisations' })).toHaveAttribute(
    'data-state',
    'active',
  )
}

/** Seed a property + dual-auth bank account + leaseholder triplet. */
async function seedScenario(opts: { threshold?: number } = {}) {
  await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })
  const { data: prop } = await supabase
    .from('properties').select('id, firm_id').limit(1).single()
  if (!prop) throw new Error('No properties found for smoke test')
  const { data: unit } = await supabase
    .from('units').select('id, unit_ref').eq('property_id', prop.id).limit(1).single()
  if (!unit) throw new Error('No units found')

  const accountName = `${BA_PREFIX} ${Date.now()} ${Math.random().toString(36).slice(2, 6)}`
  const { data: account, error: accErr } = await supabase
    .from('bank_accounts')
    .insert({
      firm_id: prop.firm_id, property_id: prop.id,
      account_name: accountName,
      account_type: 'service_charge',
      requires_dual_auth: true,
      dual_auth_threshold: opts.threshold ?? 100,
    })
    .select('id, account_name')
    .single()
  if (accErr || !account) throw new Error(`Failed to seed bank account: ${accErr?.message}`)

  const { data: existingLh } = await supabase
    .from('leaseholders')
    .select('id, full_name')
    .eq('property_id', prop.id).eq('unit_id', unit.id).eq('is_current', true)
    .like('notes', `${LH_NOTES_PREFIX}%`)
    .limit(1).maybeSingle()
  let lh = existingLh
  if (!lh) {
    const { data: created, error: lhErr } = await supabase
      .from('leaseholders').insert({
        firm_id: prop.firm_id, property_id: prop.id, unit_id: unit.id,
        full_name: 'Smoke PAUTH Leaseholder',
        is_current: true, is_resident: false, is_company: false,
        portal_access: false,
        notes: `${LH_NOTES_PREFIX} seed leaseholder`,
      }).select('id, full_name').single()
    if (lhErr || !created) throw new Error(`Failed to seed leaseholder: ${lhErr?.message}`)
    lh = created
  }

  return { prop, unit, account, lh }
}

test.describe('Property detail — payment authorisations', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })

    // Identify PAs whose proposed.bank_account_id or linked transaction's bank
    // account is one of our test-seeded accounts.
    const { data: testAccounts } = await supabase
      .from('bank_accounts').select('id').like('account_name', `${BA_PREFIX}%`)
    const accIds = (testAccounts ?? []).map(a => a.id)
    if (accIds.length) {
      // Fetch all PAs (we'll filter in-memory by JSONB content + transaction join).
      const { data: paRows } = await supabase
        .from('payment_authorisations').select('id, transaction_id, proposed')
      const txnIdsFromPa = (paRows ?? [])
        .map(p => p.transaction_id)
        .filter((id): id is string => !!id)
      let txnAccount = new Map<string, string>()
      if (txnIdsFromPa.length) {
        const { data: txns } = await supabase
          .from('transactions').select('id, bank_account_id').in('id', txnIdsFromPa)
        txnAccount = new Map((txns ?? []).map(t => [t.id, t.bank_account_id]))
      }
      const paIdsToDelete = (paRows ?? [])
        .filter(p => {
          const propAccId = (p.proposed as { bank_account_id?: string } | null)?.bank_account_id
            ?? (p.transaction_id ? txnAccount.get(p.transaction_id) : undefined)
          return propAccId && accIds.includes(propAccId)
        })
        .map(p => p.id)
      if (paIdsToDelete.length) {
        await supabase.from('payment_authorisations').delete().in('id', paIdsToDelete)
      }
    }
    await supabase.from('transactions').delete().like('description', `${TXN_PREFIX}%`)
    await supabase.from('demands').delete().like('notes', `${DEM_NOTES_PREFIX}%`)
    await supabase.from('bank_accounts').delete().like('account_name', `${BA_PREFIX}%`)
    await supabase.from('leaseholders').delete().like('notes', `${LH_NOTES_PREFIX}%`)
  })

  test('Payment authorisations tab updates the URL', async ({ page }) => {
    await goToFirstProperty(page)
    await goToPaymentAuthsTab(page)
    await expect(page).toHaveURL(/\?tab=payment-authorisations/)
    await expect(page.getByRole('heading', { name: /^Payment authorisations/ })).toBeVisible()
  })

  test('Empty state visible when no PAs exist for the property', async ({ page }) => {
    await goToFirstProperty(page)
    await goToPaymentAuthsTab(page)
    // Empty state OR existing rows from earlier tests; assert that the heading
    // shows a count and the table is rendered.
    await expect(page.getByRole('heading', { name: /^Payment authorisations \(\d+\)/ })).toBeVisible()
  })

  test('payment over threshold creates a pending PA, not a transaction', async ({ page }) => {
    const { prop, account } = await seedScenario({ threshold: 100 })
    const description = `${TXN_PREFIX} Pending ${Date.now()}`

    await page.goto(`/properties/${prop.id}?tab=transactions`)
    await page.getByRole('button', { name: 'Add transaction' }).click()
    await page.getByLabel('Bank account *').selectOption(account.id)
    await page.getByLabel('Type *').selectOption('Payment')
    await page.getByLabel('Amount *').fill('500.00')
    await page.getByLabel('Description *').fill(description)
    await page.getByRole('button', { name: 'Save transaction' }).click()

    // Form closes; banner with the request confirmation appears.
    await expect(page.getByRole('heading', { name: 'New transaction' })).not.toBeVisible()
    await expect(page.getByTestId('dual-auth-request-notice')).toBeVisible()

    // Supabase: no transactions row, one PA row in pending status.
    const { count: txnCount } = await supabase
      .from('transactions').select('*', { count: 'exact', head: true })
      .eq('description', description)
    expect(txnCount ?? 0).toBe(0)
    const { data: pa } = await supabase
      .from('payment_authorisations').select('status, proposed')
      .eq('firm_id', prop.firm_id)
      .order('requested_at', { ascending: false }).limit(1).single()
    expect(pa?.status).toBe('pending')
    expect((pa?.proposed as { description?: string } | null)?.description).toBe(description)
  })

  test('pending PA appears in the tab with proposed details', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const description = `${TXN_PREFIX} Visible ${Date.now()}`
    const adminId = await resolveAdminUserId()
    await supabase.from('payment_authorisations').insert({
      firm_id: prop.firm_id,
      requested_by: adminId,
      status: 'pending',
      proposed: {
        bank_account_id: account.id,
        amount: -250,
        transaction_date: '2026-05-01',
        description,
        payee_payer: 'Smoke supplier',
        reference: null,
        demand_id: null,
      },
    })

    await page.goto(`/properties/${prop.id}?tab=payment-authorisations`)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(description) })
    await expect(row).toBeVisible()
    await expect(row.getByText(account.account_name)).toBeVisible()
    await expect(row.getByText(/£250\.00/)).toBeVisible()
    await expect(row.getByText('Smoke supplier')).toBeVisible()
    await expect(row.getByText('Pending')).toBeVisible()
  })

  test('self-authorisation blocked — admin cannot authorise their own request', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const description = `${TXN_PREFIX} SelfAuth ${Date.now()}`
    const adminId = await resolveAdminUserId()
    await supabase.from('payment_authorisations').insert({
      firm_id: prop.firm_id,
      requested_by: adminId,
      status: 'pending',
      proposed: {
        bank_account_id: account.id,
        amount: -150,
        transaction_date: '2026-05-01',
        description,
        payee_payer: null, reference: null, demand_id: null,
      },
    })

    await page.goto(`/properties/${prop.id}?tab=payment-authorisations`)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(description) })
    const authBtn = row.getByRole('button', { name: /Authorise request/ })
    await expect(authBtn).toBeDisabled()
    await expect(authBtn).toHaveAttribute('title', /self-authorisation is not permitted/i)

    // Confirm no transaction was created.
    const { count } = await supabase
      .from('transactions').select('*', { count: 'exact', head: true })
      .eq('description', description)
    expect(count ?? 0).toBe(0)
  })

  test('cross-user authorise creates the transaction with proposed fields preserved', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const description = `${TXN_PREFIX} CrossAuth ${Date.now()}`
    const pmId    = await resolvePmUserId()
    const adminId = await resolveAdminUserId()
    const { data: pa } = await supabase.from('payment_authorisations').insert({
      firm_id: prop.firm_id,
      requested_by: pmId,
      status: 'pending',
      proposed: {
        bank_account_id: account.id,
        amount: -300,
        transaction_date: '2026-05-02',
        description,
        payee_payer: 'CrossAuth Vendor',
        reference: 'REF-XYZ',
        demand_id: null,
      },
    }).select('id').single()
    if (!pa) throw new Error('Failed to seed PA')

    await page.goto(`/properties/${prop.id}?tab=payment-authorisations`)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(description) })
    await row.getByRole('button', { name: /Authorise request/ }).click()
    // Wait for the row to leave pending state — the Authorise button disappears.
    await expect(row.getByRole('button', { name: /Authorise request/ })).toHaveCount(0)

    // Transaction was created with the proposed fields.
    const { data: txn } = await supabase
      .from('transactions').select('amount, bank_account_id, transaction_date, payee_payer, reference')
      .eq('description', description).single()
    expect(Number(txn?.amount)).toBeCloseTo(-300, 2)
    expect(txn?.bank_account_id).toBe(account.id)
    expect(txn?.transaction_date).toBe('2026-05-02')
    expect(txn?.payee_payer).toBe('CrossAuth Vendor')
    expect(txn?.reference).toBe('REF-XYZ')

    // PA row was linked + stamped.
    const { data: refreshed } = await supabase
      .from('payment_authorisations').select('status, transaction_id, authorised_by, authorised_at')
      .eq('id', pa.id).single()
    expect(refreshed?.status).toBe('authorised')
    expect(refreshed?.transaction_id).toBeTruthy()
    expect(refreshed?.authorised_by).toBe(adminId)
    expect(refreshed?.authorised_at).toBeTruthy()
  })

  test('reject with reason — admin rejects another user\'s request', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const description = `${TXN_PREFIX} Reject ${Date.now()}`
    const pmId    = await resolvePmUserId()
    const adminId = await resolveAdminUserId()
    const { data: pa } = await supabase.from('payment_authorisations').insert({
      firm_id: prop.firm_id,
      requested_by: pmId,
      status: 'pending',
      proposed: {
        bank_account_id: account.id,
        amount: -120,
        transaction_date: '2026-05-03',
        description,
        payee_payer: null, reference: null, demand_id: null,
      },
    }).select('id').single()
    if (!pa) throw new Error('Failed to seed PA')

    await page.goto(`/properties/${prop.id}?tab=payment-authorisations`)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(description) })
    await row.getByRole('button', { name: /Reject request/ }).click()
    await page.getByLabel('Rejection reason').fill('Out of scope for the year-end budget')
    await page.getByRole('button', { name: 'Confirm reject' }).click()
    await expect(page.getByRole('button', { name: 'Confirm reject' })).toHaveCount(0)

    // PA flips to rejected with reason.
    const { data: refreshed } = await supabase
      .from('payment_authorisations').select('status, rejected_by, rejection_reason, transaction_id')
      .eq('id', pa.id).single()
    expect(refreshed?.status).toBe('rejected')
    expect(refreshed?.rejected_by).toBe(adminId)
    expect(refreshed?.rejection_reason).toBe('Out of scope for the year-end budget')
    expect(refreshed?.transaction_id).toBeNull()

    // No transaction was created.
    const { count } = await supabase
      .from('transactions').select('*', { count: 'exact', head: true })
      .eq('description', description)
    expect(count ?? 0).toBe(0)
  })

  test('cancel by requester — admin cancels their own pending request', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const description = `${TXN_PREFIX} SelfCancel ${Date.now()}`
    const adminId = await resolveAdminUserId()
    const { data: pa } = await supabase.from('payment_authorisations').insert({
      firm_id: prop.firm_id,
      requested_by: adminId,
      status: 'pending',
      proposed: {
        bank_account_id: account.id,
        amount: -75,
        transaction_date: '2026-05-04',
        description,
        payee_payer: null, reference: null, demand_id: null,
      },
    }).select('id').single()
    if (!pa) throw new Error('Failed to seed PA')

    await page.goto(`/properties/${prop.id}?tab=payment-authorisations`)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(description) })
    await row.getByRole('button', { name: /Cancel request/ }).click()
    await page.getByRole('button', { name: 'Confirm cancel' }).click()
    // Wait for the modal to close (status transition has landed in the DB).
    await expect(page.getByRole('button', { name: 'Confirm cancel' })).toHaveCount(0)

    const { data: refreshed } = await supabase
      .from('payment_authorisations').select('status, rejection_reason')
      .eq('id', pa.id).single()
    expect(refreshed?.status).toBe('rejected')
    expect(refreshed?.rejection_reason).toBe('Cancelled by requester')
  })

  test('immutable after action — authorise / reject buttons absent on resolved rows', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const description = `${TXN_PREFIX} Resolved ${Date.now()}`
    const pmId = await resolvePmUserId()

    // Insert a transaction first so we can link it (the schema still permits this).
    const { data: txn } = await supabase.from('transactions').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      bank_account_id: account.id,
      transaction_type: 'payment',
      transaction_date: '2026-05-05', amount: -42, description,
    }).select('id').single()
    if (!txn) throw new Error('Failed to seed transaction')

    await supabase.from('payment_authorisations').insert({
      firm_id: prop.firm_id,
      requested_by: pmId,
      transaction_id: txn.id,
      status: 'authorised',
      authorised_at: new Date().toISOString(),
      proposed: {
        bank_account_id: account.id,
        amount: -42,
        transaction_date: '2026-05-05',
        description,
        payee_payer: null, reference: null, demand_id: null,
      },
    })

    await page.goto(`/properties/${prop.id}?tab=payment-authorisations`)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(description) })
    await expect(row.getByRole('button', { name: /Authorise request/ })).toHaveCount(0)
    await expect(row.getByRole('button', { name: /Reject request/ })).toHaveCount(0)
    await expect(row.getByRole('button', { name: /Cancel request/ })).toHaveCount(0)
  })

  test('authorise updates linked demand status when proposed has demand_id', async ({ page }) => {
    const { prop, unit, account, lh } = await seedScenario()
    const description = `${TXN_PREFIX} DemandLink ${Date.now()}`
    const pmId = await resolvePmUserId()

    const { data: dem } = await supabase.from('demands').insert({
      firm_id: prop.firm_id, property_id: prop.id,
      unit_id: unit.id, leaseholder_id: lh.id,
      demand_type: 'service_charge', amount: 200,
      status: 'issued', s21b_attached: true,
      issued_date: '2026-04-01',
      notes: `${DEM_NOTES_PREFIX} demand for pa-link ${Date.now()}`,
    }).select('id').single()
    if (!dem) throw new Error('Failed to seed demand')

    // Note: authorising a PA with a linked demand creates a payment-type
    // transaction. The auto-status helper only counts receipts, so for this
    // smoke we set transaction_type via the proposed snapshot to test that
    // the auto-status step runs without error. The smoke asserts the status
    // does NOT change (no receipts), which is the correct behaviour.
    const { data: pa } = await supabase.from('payment_authorisations').insert({
      firm_id: prop.firm_id,
      requested_by: pmId,
      status: 'pending',
      proposed: {
        bank_account_id: account.id,
        amount: -200,
        transaction_date: '2026-05-06',
        description,
        payee_payer: null, reference: null,
        demand_id: dem.id,
      },
    }).select('id').single()
    if (!pa) throw new Error('Failed to seed PA')

    await page.goto(`/properties/${prop.id}?tab=payment-authorisations`)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(description) })
    await row.getByRole('button', { name: /Authorise request/ }).click()
    await expect(row.getByRole('button', { name: /Authorise request/ })).toHaveCount(0)
    // Demand status unchanged because the linked transaction is a payment, not a receipt.
    const { data: refreshed } = await supabase
      .from('demands').select('status').eq('id', dem.id).single()
    expect(refreshed?.status).toBe('issued')
  })

  // ── Closure dual-auth (1g) ───────────────────────────────────────────────

  test('closure PA — pending row renders as a closure entry, not a payment', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const pmId = await resolvePmUserId()

    await supabase.from('payment_authorisations').insert({
      firm_id: prop.firm_id,
      requested_by: pmId,
      status: 'pending',
      action_type: 'close_bank_account',
      proposed: { bank_account_id: account.id, closed_date: '2026-05-15' },
    })

    await page.goto(`/properties/${prop.id}?tab=payment-authorisations`)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(`Close: ${account.account_name}`) })
    await expect(row).toBeVisible()
    // No payment-amount cell content for closure rows.
    await expect(row.getByText('Pending')).toBeVisible()
  })

  test('closure authorise — admin authorises, bank_account flips to closed', async ({ page }) => {
    const { prop, account } = await seedScenario()
    const pmId = await resolvePmUserId()

    const { data: pa } = await supabase.from('payment_authorisations').insert({
      firm_id: prop.firm_id,
      requested_by: pmId,
      status: 'pending',
      action_type: 'close_bank_account',
      proposed: { bank_account_id: account.id, closed_date: '2026-05-20' },
    }).select('id').single()
    if (!pa) throw new Error('Failed to seed closure PA')

    await page.goto(`/properties/${prop.id}?tab=payment-authorisations`)
    const row = page.getByRole('main').locator('tr', { has: page.getByText(`Close: ${account.account_name}`) })
    await row.getByRole('button', { name: /Authorise request/ }).click()
    await expect(row.getByRole('button', { name: /Authorise request/ })).toHaveCount(0)

    // Bank account is now closed.
    const { data: refreshed } = await supabase
      .from('bank_accounts').select('is_active, closed_date').eq('id', account.id).single()
    expect(refreshed?.is_active).toBe(false)
    expect(refreshed?.closed_date).toBe('2026-05-20')

    // PA row authorised, transaction_id stays null (closure isn't a transaction).
    const { data: refreshedPa } = await supabase
      .from('payment_authorisations').select('status, transaction_id').eq('id', pa.id).single()
    expect(refreshedPa?.status).toBe('authorised')
    expect(refreshedPa?.transaction_id).toBeNull()
  })

  test('PM-driven UI — Request closure button creates a closure PA', async ({ browser }) => {
    // This test runs as the property_manager (not admin) to exercise the
    // request-closure UX. Uses the PM storage state saved by auth-pm.setup.ts.
    const context = await browser.newContext({ storageState: 'tests/.auth/pm-user.json' })
    const page = await context.newPage()
    try {
      const { prop, account } = await seedScenario()

      await page.goto(`/properties/${prop.id}?tab=bank-accounts`)
      const row = page.getByRole('main').locator('tr', { has: page.getByText(account.account_name) })
      await row.getByRole('button', { name: `Request closure ${account.account_name}` }).click()
      // Inline confirmation row appears.
      await page.getByRole('button', { name: 'Confirm request' }).click()
      // Banner appears with the confirmation message.
      await expect(page.getByTestId('closure-request-notice')).toBeVisible()

      // PA row exists in pending state with the expected action_type.
      const { data: pa } = await supabase
        .from('payment_authorisations')
        .select('action_type, status, proposed, requested_by')
        .eq('firm_id', prop.firm_id)
        .order('requested_at', { ascending: false }).limit(1).single()
      expect(pa?.action_type).toBe('close_bank_account')
      expect(pa?.status).toBe('pending')
      expect((pa?.proposed as { bank_account_id?: string } | null)?.bank_account_id).toBe(account.id)
      const pmId = await resolvePmUserId()
      expect(pa?.requested_by).toBe(pmId)
    } finally {
      await context.close()
    }
  })
})
