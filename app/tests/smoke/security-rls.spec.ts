/**
 * @file security-rls.spec.ts
 * @description Tier-1 security hardening smokes (commit 1i.1). Canonical scope:
 * docs/DECISIONS.md 2026-05-10 — Security-smoke pass + the §6 additions in
 * docs/SECURITY_AUDIT_2026-05-10.md (3 specific RLS/CHECK gaps the audit
 * elevated under that scope).
 *
 * What's covered here (Tier-1, 12 smokes):
 *   1.  C-1 — PM cannot UPDATE users.role on own row (column-grant rejection).
 *   2.  C-1 — PM cannot UPDATE users.firm_id on own row.
 *   3.  C-1 positive — PM CAN UPDATE permitted columns (full_name) on own row.
 *   4.  C-2 — PM cannot transfer bank_accounts to a foreign firm via firm_id
 *       mutation (WITH CHECK rejection).
 *   5.  C-2 — PM cannot transfer transactions to a foreign firm via firm_id.
 *   6.  C-2 — PM cannot INSERT bank_accounts with a foreign firm_id.
 *   7.  C-3 — PM cannot DELETE rows from reconciliation_audit_log or
 *       golden_thread_audit_log (RICS Rule 3.7 evidence trail).
 *   8.  C-3 — PM cannot DELETE rows from payment_authorisations; UPDATE still
 *       permitted (state-transition table).
 *   9.  RLS scope — every selected row from financial tables carries
 *       firm_id matching the authenticated PM's firm.
 *   10. M-1 — direct UPDATE on bank_accounts.current_balance is blocked by
 *       the bank_accounts_balance_immutable trigger (P0001).
 *   11. M-3 — transactions row with type='receipt' and amount<0 is rejected
 *       by transactions_sign_type_chk (23514).
 *   12. M-4 — payment_authorisations with authorised_at set and authorised_by
 *       NULL is rejected by pa_authorised_pair_chk (23514).
 *
 * What's NOT covered here (FORWARD: financial-rules Edge Function commit):
 *   - DECISIONS Security-smoke pass items 2 (self-auth bypass), 4 (hard-delete
 *     audit signal), 5 (authority limit bypass), 6 (storage bucket scoping).
 *     All require either the financial-rules Edge Function (items 2 + 5) or
 *     the Phase 5 leaseholder portal (item 6) or the Phase 5 audit-log table
 *     (item 4) — deferred to those commits with FORWARD anchors elsewhere.
 *   - Cross-firm read isolation (DECISIONS item 1, audit §C-2 read side):
 *     requires a second firm fixture seeded via service-role-key, which the
 *     smoke runner does not have. Approximated here by smoke 9's "every row
 *     carries my firm_id" assertion. FORWARD: full cross-firm fixture lands
 *     with the financial-rules Edge Function commit.
 *   - JWT tampering (DECISIONS item 3): requires the JWT secret to forge a
 *     signed token. The H-7 client-side trust shape is exercised indirectly
 *     by smoke 1 (the C-1 mutation that the OLD client would have reflected
 *     immediately is now rejected at the column-grant layer).
 *
 * Patterns honoured:
 *   - LESSONS Phase 3 modal-vs-DB-query race: not applicable (no UI).
 *   - LESSONS Phase 3 strict-mode locator collision: not applicable (no UI).
 *   - LESSONS Phase 1 RLS-as-single-mig: this file's smokes lock the policies
 *     written in 00026_security_hardening.sql against silent regression.
 *
 * Cleanup unwinds in FK-safe order: payment_authorisations →
 * reconciliation_audit_log → golden_thread_audit_log → transactions →
 * bank_accounts, scoped to test-prefixed rows.
 */
import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './_env'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// All seeded rows carry this prefix so afterAll can sweep them safely.
const PREFIX = 'Smoke SECRLS'

// A throwaway UUID that is not a real firm_id — used as the "foreign firm"
// for WITH CHECK rejection assertions. The string is stable across runs so
// any leak into another table can be grepped.
const FOREIGN_FIRM_ID = '00000000-0000-4000-8000-000000005EC0'

interface PmContext {
  userId:     string
  firmId:     string
  propertyId: string
  fullName:   string
}

async function signInAsPm(): Promise<PmContext> {
  const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
    email: 'pm@propos.local', password: 'PropOS2026!',
  })
  if (authErr || !auth.user) throw new Error(`PM sign-in failed: ${authErr?.message}`)

  const { data: pmRow, error: pmErr } = await supabase
    .from('users').select('firm_id, full_name').eq('id', auth.user.id).single()
  if (pmErr || !pmRow) throw new Error(`PM users row not readable: ${pmErr?.message}`)

  const { data: prop, error: propErr } = await supabase
    .from('properties').select('id').eq('firm_id', pmRow.firm_id).limit(1).single()
  if (propErr || !prop) throw new Error(`No property in PM's firm: ${propErr?.message}`)

  return {
    userId:     auth.user.id,
    firmId:     pmRow.firm_id,
    propertyId: prop.id,
    fullName:   pmRow.full_name ?? 'PM',
  }
}

async function seedBankAccount(ctx: PmContext, suffix: string): Promise<string> {
  const { data, error } = await supabase
    .from('bank_accounts')
    .insert({
      firm_id:             ctx.firmId,
      property_id:         ctx.propertyId,
      account_name:        `${PREFIX} BA ${suffix} ${Date.now()}`,
      account_type:        'service_charge',
      requires_dual_auth:  false,
      dual_auth_threshold: 0,
    })
    .select('id').single()
  if (error || !data) throw new Error(`Seed bank_account failed: ${error?.message}`)
  return data.id
}

async function seedTransaction(
  ctx:       PmContext,
  accountId: string,
  fields:    { amount: number; transaction_type: 'receipt' | 'payment' | 'journal'; description?: string },
): Promise<string> {
  const { data, error } = await supabase
    .from('transactions')
    .insert({
      firm_id:          ctx.firmId,
      property_id:      ctx.propertyId,
      bank_account_id:  accountId,
      transaction_type: fields.transaction_type,
      transaction_date: '2026-04-15',
      amount:           fields.amount,
      description:      `${PREFIX} TXN ${fields.description ?? ''}`,
      reconciled:       false,
    })
    .select('id').single()
  if (error || !data) throw new Error(`Seed transaction failed: ${error?.message}`)
  return data.id
}

test.describe('Security RLS — Tier-1 hardening (commit 1i.1)', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })

    // Sweep test-prefixed rows in FK-safe order.
    const { data: accounts } = await supabase
      .from('bank_accounts').select('id').like('account_name', `${PREFIX}%`)
    const accountIds = (accounts ?? []).map(a => a.id)

    if (accountIds.length) {
      const { data: txns } = await supabase
        .from('transactions').select('id').in('bank_account_id', accountIds)
      const txnIds = (txns ?? []).map(t => t.id)

      if (txnIds.length) {
        // Admin can DELETE from payment_authorisations? No — C-3 split it to
        // SELECT+INSERT+UPDATE only. Cleanup must defer to service-role-only
        // or simply leave PA rows in place (they FK to transactions which we'd
        // then have to leave too). Pragmatic: the PA seed in smoke 8 sets
        // transaction_id to a value we'll keep around; admin updates the PA
        // status to 'rejected' so it doesn't pollute review queues.
        await supabase
          .from('payment_authorisations')
          .update({ status: 'rejected', rejected_at: new Date().toISOString(),
                    rejected_by: (await supabase.auth.getUser()).data.user?.id,
                    rejection_reason: 'smoke cleanup' })
          .in('transaction_id', txnIds)
      }

      // reconciliation_audit_log + golden_thread_audit_log: C-3 made them
      // append-only at the RLS layer (no DELETE policy), even for admin.
      // Test rows will accumulate; they're scoped by notes prefix and harmless.
      // Production would clear via service-role + retention cron (PROD-GATE).

      await supabase.from('transactions').delete().in('id', txnIds)
    }
    await supabase.from('bank_accounts').delete().in('id', accountIds)
  })

  // ── C-1 — users column-grant restriction ──────────────────────────────────

  test('C-1 — PM cannot UPDATE users.role on own row', async () => {
    const ctx = await signInAsPm()
    const { error } = await supabase.from('users')
      .update({ role: 'admin' }).eq('id', ctx.userId)
    expect(error).not.toBeNull()
    // Column-level GRANT failure surfaces as 42501 "permission denied for column role".
    expect(error?.code).toBe('42501')

    // Verify role unchanged.
    const { data: row } = await supabase.from('users').select('role').eq('id', ctx.userId).single()
    expect(row?.role).toBe('property_manager')
  })

  test('C-1 — PM cannot UPDATE users.firm_id on own row', async () => {
    const ctx = await signInAsPm()
    const { error } = await supabase.from('users')
      .update({ firm_id: FOREIGN_FIRM_ID }).eq('id', ctx.userId)
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')

    const { data: row } = await supabase.from('users').select('firm_id').eq('id', ctx.userId).single()
    expect(row?.firm_id).toBe(ctx.firmId)
  })

  test('C-1 positive — PM CAN UPDATE full_name on own row', async () => {
    const ctx = await signInAsPm()
    const newName = `${PREFIX} ${ctx.fullName} ${Date.now()}`
    const { error } = await supabase.from('users')
      .update({ full_name: newName }).eq('id', ctx.userId)
    expect(error).toBeNull()

    // Restore for subsequent runs (idempotent + leaves no test-prefixed name).
    await supabase.from('users').update({ full_name: ctx.fullName }).eq('id', ctx.userId)
  })

  // ── C-2 — RLS WITH CHECK on FOR ALL policies ──────────────────────────────

  test('C-2 — PM cannot transfer bank_accounts to a foreign firm via firm_id', async () => {
    const ctx = await signInAsPm()
    const accountId = await seedBankAccount(ctx, 'C2-BA')

    const { error } = await supabase.from('bank_accounts')
      .update({ firm_id: FOREIGN_FIRM_ID }).eq('id', accountId)
    expect(error).not.toBeNull()
    // WITH CHECK rejection: 42501 "new row violates row-level security policy".
    expect(error?.code).toBe('42501')

    // Account remains in PM's firm.
    const { data: row } = await supabase
      .from('bank_accounts').select('firm_id').eq('id', accountId).single()
    expect(row?.firm_id).toBe(ctx.firmId)
  })

  test('C-2 — PM cannot transfer transactions to a foreign firm via firm_id', async () => {
    const ctx = await signInAsPm()
    const accountId = await seedBankAccount(ctx, 'C2-TXN')
    const txnId = await seedTransaction(ctx, accountId, {
      amount: 100, transaction_type: 'receipt', description: 'C2',
    })

    const { error } = await supabase.from('transactions')
      .update({ firm_id: FOREIGN_FIRM_ID }).eq('id', txnId)
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')

    const { data: row } = await supabase
      .from('transactions').select('firm_id').eq('id', txnId).single()
    expect(row?.firm_id).toBe(ctx.firmId)
  })

  test('C-2 — PM cannot INSERT bank_accounts with a foreign firm_id', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('bank_accounts')
      .insert({
        firm_id:             FOREIGN_FIRM_ID,
        property_id:         ctx.propertyId,
        account_name:        `${PREFIX} BA C2-INS ${Date.now()}`,
        account_type:        'service_charge',
        requires_dual_auth:  false,
        dual_auth_threshold: 0,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
    expect(data).toBeNull()
  })

  // ── C-3 — append-only audit-trail tables ──────────────────────────────────

  test('C-3 — PM cannot DELETE from reconciliation_audit_log or golden_thread_audit_log', async () => {
    const ctx = await signInAsPm()
    const accountId = await seedBankAccount(ctx, 'C3-AUDIT')

    // Insert a reconciliation_audit_log row (PM has INSERT permission via recaudit_insert).
    const { data: recRow, error: recErr } = await supabase
      .from('reconciliation_audit_log')
      .insert({
        firm_id:         ctx.firmId,
        bank_account_id: accountId,
        action:          'auto_match',
        actor_id:        ctx.userId,
        notes:           `${PREFIX} RICS Rule 3.7 evidence trail — C-3 smoke`,
      })
      .select('id').single()
    expect(recErr).toBeNull()
    expect(recRow?.id).toBeTruthy()

    // Attempt DELETE — RLS rejects silently (no DELETE policy means no rows match).
    await supabase.from('reconciliation_audit_log').delete().eq('id', recRow!.id)

    // Verify the row still exists.
    const { data: stillThere } = await supabase
      .from('reconciliation_audit_log').select('id').eq('id', recRow!.id).single()
    expect(stillThere?.id).toBe(recRow!.id)

    // Same shape for golden_thread_audit_log.
    const { data: gtRow, error: gtErr } = await supabase
      .from('golden_thread_audit_log')
      .insert({
        firm_id:      ctx.firmId,
        property_id:  ctx.propertyId,
        action:       'created',
        performed_by: ctx.userId,
        notes:        `${PREFIX} BSA evidence — C-3 smoke`,
      })
      .select('id').single()
    expect(gtErr).toBeNull()
    expect(gtRow?.id).toBeTruthy()

    await supabase.from('golden_thread_audit_log').delete().eq('id', gtRow!.id)
    const { data: gtStill } = await supabase
      .from('golden_thread_audit_log').select('id').eq('id', gtRow!.id).single()
    expect(gtStill?.id).toBe(gtRow!.id)
  })

  test('C-3 — PM cannot DELETE payment_authorisations; UPDATE still permitted', async () => {
    const ctx = await signInAsPm()
    const accountId = await seedBankAccount(ctx, 'C3-PA')
    const txnId     = await seedTransaction(ctx, accountId, {
      amount: -50, transaction_type: 'payment', description: 'C3-PA',
    })

    const { data: paRow, error: paErr } = await supabase
      .from('payment_authorisations')
      .insert({
        firm_id:        ctx.firmId,
        transaction_id: txnId,
        requested_by:   ctx.userId,
        status:         'pending',
      })
      .select('id, status').single()
    expect(paErr).toBeNull()
    expect(paRow?.status).toBe('pending')

    // DELETE rejected silently.
    await supabase.from('payment_authorisations').delete().eq('id', paRow!.id)
    const { data: stillThere } = await supabase
      .from('payment_authorisations').select('id, status').eq('id', paRow!.id).single()
    expect(stillThere?.id).toBe(paRow!.id)

    // UPDATE still permitted (state transitions: pending → rejected).
    const { error: updErr } = await supabase
      .from('payment_authorisations')
      .update({ status: 'rejected', rejected_at: new Date().toISOString(),
                rejected_by: ctx.userId, rejection_reason: 'C-3 smoke' })
      .eq('id', paRow!.id)
    expect(updErr).toBeNull()
    const { data: updated } = await supabase
      .from('payment_authorisations').select('status').eq('id', paRow!.id).single()
    expect(updated?.status).toBe('rejected')
  })

  // ── RLS read-scope ────────────────────────────────────────────────────────

  test('RLS read scope — every row returned from financial tables carries firm_id = my firm', async () => {
    const ctx = await signInAsPm()
    const tables = [
      'bank_accounts', 'transactions', 'payment_authorisations', 'demands',
      'service_charge_accounts', 'compliance_items',
    ] as const

    for (const table of tables) {
      const { data, error } = await supabase.from(table).select('firm_id').limit(50)
      expect(error, `${table} select`).toBeNull()
      const foreign = (data ?? []).filter((r: { firm_id: string }) => r.firm_id !== ctx.firmId)
      expect(foreign, `${table} should return zero rows with foreign firm_id`).toEqual([])
    }
  })

  // ── M-1 — bank_accounts.current_balance trigger ───────────────────────────

  test('M-1 — direct UPDATE on bank_accounts.current_balance is blocked by trigger', async () => {
    const ctx = await signInAsPm()
    const accountId = await seedBankAccount(ctx, 'M1-TRIG')

    const { error } = await supabase.from('bank_accounts')
      .update({ current_balance: 999999.99 }).eq('id', accountId)
    expect(error).not.toBeNull()
    // Custom RAISE EXCEPTION in block_balance_writes() uses ERRCODE 'P0001'.
    expect(error?.code).toBe('P0001')
    expect(error?.message ?? '').toContain('bank_accounts.current_balance is trigger-maintained')
  })

  // ── M-3 — transactions sign-vs-type CHECK ─────────────────────────────────

  test('M-3 — transactions row with type=receipt and amount<0 is rejected by CHECK', async () => {
    const ctx = await signInAsPm()
    const accountId = await seedBankAccount(ctx, 'M3-CHK')

    const { error } = await supabase.from('transactions').insert({
      firm_id:          ctx.firmId,
      property_id:      ctx.propertyId,
      bank_account_id:  accountId,
      transaction_type: 'receipt',
      transaction_date: '2026-04-15',
      amount:           -75,                 // ← invalid: receipt requires > 0
      description:      `${PREFIX} TXN M3-invalid`,
      reconciled:       false,
    })
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')        // CHECK constraint violation
    expect(error?.message ?? '').toContain('transactions_sign_type_chk')
  })

  // ── M-4 — payment_authorisations audit-stamp coherence CHECK ──────────────

  test('M-4 — payment_authorisations with authorised_at set but authorised_by NULL is rejected', async () => {
    const ctx = await signInAsPm()
    const accountId = await seedBankAccount(ctx, 'M4-CHK')
    const txnId     = await seedTransaction(ctx, accountId, {
      amount: -25, transaction_type: 'payment', description: 'M4',
    })

    const { error } = await supabase.from('payment_authorisations').insert({
      firm_id:        ctx.firmId,
      transaction_id: txnId,
      requested_by:   ctx.userId,
      status:         'authorised',
      authorised_at:  new Date().toISOString(),
      authorised_by:  null,                  // ← invalid: pair must be both-or-neither
    })
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
    expect(error?.message ?? '').toContain('pa_authorised_pair_chk')
  })
})
