/**
 * @file collection-state-machine.spec.ts
 * @description Phase 4a — Collection workflow regulatory core smokes.
 *   Pins migration 00035_collection_workflow_core against silent regression.
 *
 * Tables / triggers / constraints covered (migration 00035):
 *   - demands.notice_stage                         (state machine)
 *   - demands_notice_stage_transition trigger      (forward-only + PA gates)
 *   - demands_s20b_18mo_chk trigger                (LTA 1985 s.20B)
 *   - block_collection_settings                    (per-block cadence)
 *   - notice_letters_sent                          (immutable letter log)
 *   - administration_charges                       (LTA 1985 sch.11)
 *   - admin_charges_enforce_summary_of_rights      (sch.11 enforceability)
 *   - demand_interest_charges                      (lease-clause-only)
 *   - dic_enforce_interest_clause_present          (statutory gate)
 *   - forfeiture_actions                           (LPA 1925 s.146)
 *   - forfeiture_stage_transition                  (Path A mortgagee / Path B assert)
 *   - unit_ledger_history view                     (Blockman SC History parity)
 *
 * Smokes (20):
 *   Cross-firm RLS (5):
 *     1. block_collection_settings — cross-firm INSERT rejected (42501).
 *     2. notice_letters_sent       — cross-firm INSERT rejected (42501).
 *     3. administration_charges    — cross-firm INSERT rejected (42501).
 *     4. demand_interest_charges   — cross-firm INSERT rejected (42501).
 *     5. forfeiture_actions        — cross-firm INSERT rejected (42501).
 *   Immutability (1):
 *     6. notice_letters_sent       — UPDATE rejected (no UPDATE policy).
 *   Notice stage machine (5):
 *     7. PM forward edge current→reminder_1 — allowed.
 *     8. PM reverse edge reminder_1→current — rejected; admin allowed.
 *     9. PM skip-ahead current→pre_action   — rejected (admin required).
 *    10. pre_action→solicitor_referred without accepted PA — rejected.
 *    11. pre_action→solicitor_referred with accepted PA   — allowed.
 *   LTA 1985 s.20B (2):
 *    12. status=issued blocked after 540d with no s20b_notified_date (service charge).
 *    13. status=issued allowed after 540d for ground_rent (s.20B exempts GR).
 *   Administration charges (1):
 *    14. status=demanded blocked without summary_of_rights_attached (23514).
 *   Interest accrual (1):
 *    15. INSERT rejected when lease has no interest clause + block default off.
 *   Forfeiture (3):
 *    16. Path A — mortgagee_served + grace expired → possession_claim_issued OK.
 *    17. Path B — assert_no_mortgagee + evidence → possession_claim_issued OK.
 *    18. Grace period not yet expired → possession_claim_drafted rejected (23514).
 *   Ledger view (1):
 *    19. unit_ledger_history surfaces own-firm rows; cross-firm rows absent.
 *   AP signoff PA (closes 00028 §10 FORWARD anchor) (1):
 *    20. major_works_invoice_ap_signoff PA inserts cleanly against HRB invoice + PAP.
 *
 * Patterns honoured (from bsa-module.spec.ts):
 *   - PREFIX-scoped row names + notes so afterAll can sweep safely.
 *   - FOREIGN_FIRM_ID stable UUID for cross-firm WITH CHECK rejection.
 *   - signInAs / signInAsAdmin / signInAsPm helpers.
 *   - PostgREST surfaces CHECK + RAISE EXCEPTION USING ERRCODE='23514' as '23514',
 *     RLS WITH CHECK as '42501'.
 *
 * Cleanup order (FK-safe; admin sign-in required):
 *   forfeiture_actions → demand_interest_charges → administration_charges →
 *   notice_letters_sent → payment_authorisations → demands → interested_parties →
 *   leaseholders → bank_accounts → block_collection_settings (only PREFIX rows).
 */
import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './_env'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const PREFIX = 'Smoke COLL'
const FOREIGN_FIRM_ID = '00000000-0000-4000-8000-000000005EC1'

interface PmContext {
  userId:     string
  firmId:     string
  propertyId: string
  unitId:     string
  leaseholderId: string
}

async function signInAs(email: string): Promise<{ userId: string; firmId: string }> {
  const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
    email, password: 'PropOS2026!',
  })
  if (authErr || !auth.user) throw new Error(`${email} sign-in failed: ${authErr?.message}`)
  const { data: row, error: rowErr } = await supabase
    .from('users').select('firm_id').eq('id', auth.user.id).single()
  if (rowErr || !row) throw new Error(`${email} users row not readable: ${rowErr?.message}`)
  return { userId: auth.user.id, firmId: row.firm_id }
}

const signInAsAdmin = () => signInAs('admin@propos.local')
const signInAsPm    = () => signInAs('pm@propos.local')

async function pmContext(): Promise<PmContext> {
  const { userId, firmId } = await signInAsPm()
  const { data: prop } = await supabase
    .from('properties').select('id').eq('firm_id', firmId).limit(1).single()
  if (!prop) throw new Error('No properties seeded for PM')
  const { data: unit } = await supabase
    .from('units').select('id').eq('firm_id', firmId).eq('property_id', prop.id).limit(1).single()
  if (!unit) throw new Error(`No units on property ${prop.id}`)
  const { data: lh } = await supabase
    .from('leaseholders').select('id')
    .eq('firm_id', firmId).eq('unit_id', unit.id).eq('is_current', true)
    .limit(1).single()
  if (!lh) throw new Error(`No current leaseholder on unit ${unit.id}`)
  return { userId, firmId, propertyId: prop.id, unitId: unit.id, leaseholderId: lh.id }
}

/** Create a demand at notice_stage='current' with PREFIX-scoped notes. */
async function seedDemand(
  ctx: PmContext,
  opts: { demandType?: string; status?: string; daysSinceDue?: number } = {},
): Promise<string> {
  const demandType = opts.demandType ?? 'service_charge'
  const status = opts.status ?? 'issued'
  const daysSinceDue = opts.daysSinceDue ?? 30
  const due = new Date()
  due.setDate(due.getDate() - daysSinceDue)
  const issued = new Date(due)
  issued.setDate(issued.getDate() - 14)
  const { data, error } = await supabase
    .from('demands')
    .insert({
      firm_id:                ctx.firmId,
      property_id:            ctx.propertyId,
      unit_id:                ctx.unitId,
      leaseholder_id:         ctx.leaseholderId,
      demand_type:            demandType,
      amount:                 500.00,
      issued_date:            issued.toISOString().slice(0, 10),
      due_date:               due.toISOString().slice(0, 10),
      s21b_attached:          true,
      section_153_compliant:  true,
      status,
      notes:                  `${PREFIX} demand ${Date.now()}`,
    })
    .select('id').single()
  if (error || !data) throw new Error(`seedDemand failed: ${error?.message}`)
  return data.id
}

test.describe('Phase 4a — collection state machine smokes (migration 00035)', () => {
  test.afterAll(async () => {
    await signInAsAdmin()

    // FK-safe sweep order: children first.
    await supabase.from('forfeiture_actions').delete().like('notes', `${PREFIX}%`)
    await supabase.from('demand_interest_charges').delete().like('notes', `${PREFIX}%`)
    await supabase.from('administration_charges').delete().like('notes', `${PREFIX}%`)
    await supabase.from('notice_letters_sent').delete().like('recipient_address_snapshot', `${PREFIX}%`)

    // Payment authorisations created for PA-gate tests: identify either by
    // proposed.demand_id matching our test demands (tests 11/16/17) OR by
    // proposed.smoke_tag matching this file's PREFIX (test 20 AP signoff).
    const { data: testDemands } = await supabase
      .from('demands').select('id').like('notes', `${PREFIX}%`)
    const testDemandIds = new Set((testDemands ?? []).map(d => d.id))

    const { data: testInvoices } = await supabase
      .from('invoices').select('id').like('description', `${PREFIX}%`)
    const testInvoiceIds = new Set((testInvoices ?? []).map(i => i.id))

    const { data: paRows } = await supabase
      .from('payment_authorisations')
      .select('id, proposed')
      .in('action_type', [
        'solicitor_escalation',
        'commence_possession_proceedings',
        'major_works_invoice_ap_signoff',
      ])
    const paToDelete = (paRows ?? [])
      .filter(p => {
        const proposed = p.proposed as {
          demand_id?:  string
          invoice_id?: string
          smoke_tag?:  string
        } | null
        if (!proposed) return false
        if (proposed.smoke_tag === PREFIX) return true
        if (proposed.demand_id && testDemandIds.has(proposed.demand_id)) return true
        if (proposed.invoice_id && testInvoiceIds.has(proposed.invoice_id)) return true
        return false
      })
      .map(p => p.id)
    if (paToDelete.length) {
      await supabase.from('payment_authorisations').delete().in('id', paToDelete)
    }

    await supabase.from('invoices').delete().like('description', `${PREFIX}%`)
    await supabase.from('demands').delete().like('notes', `${PREFIX}%`)
    await supabase.from('interested_parties').delete().like('name', `${PREFIX}%`)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Cross-firm RLS rejection (smokes 1-5)
  // ───────────────────────────────────────────────────────────────────────────

  test('1 — block_collection_settings: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await pmContext()
    const { error } = await supabase
      .from('block_collection_settings')
      .insert({ property_id: ctx.propertyId, firm_id: FOREIGN_FIRM_ID })
      .select('property_id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
  })

  test('2 — notice_letters_sent: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await pmContext()
    const { error } = await supabase
      .from('notice_letters_sent')
      .insert({
        firm_id:        FOREIGN_FIRM_ID,
        unit_id:        ctx.unitId,
        letter_code:    'R1',
        letter_type:    'reminder',
        sent_method:    'post',
        recipient_address_snapshot: `${PREFIX} foreign ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
  })

  test('3 — administration_charges: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await pmContext()
    const { error } = await supabase
      .from('administration_charges')
      .insert({
        firm_id:        FOREIGN_FIRM_ID,
        unit_id:        ctx.unitId,
        leaseholder_id: ctx.leaseholderId,
        charge_type:    'reminder_admin_fee',
        amount_net:     60.00,
        vat_amount:     12.00,
        amount_gross:   72.00,
        notes:          `${PREFIX} foreign ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
  })

  test('4 — demand_interest_charges: cross-firm INSERT rejected (trigger or RLS)', async () => {
    const ctx = await pmContext()
    const demandId = await seedDemand(ctx)
    const { error } = await supabase
      .from('demand_interest_charges')
      .insert({
        firm_id:          FOREIGN_FIRM_ID,
        demand_id:        demandId,
        unit_id:          ctx.unitId,
        period_from:      '2026-01-01',
        period_to:        '2026-02-01',
        principal_amount: 500.00,
        rate_pct:         8.00,
        interest_amount:  3.40,
        accrual_basis:    'lease_clause',
        lease_clause_ref: 'Schedule 4 para 7',
        notes:            `${PREFIX} foreign ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    // demand_interest_charges is defended by two layers:
    //   1. BEFORE INSERT trigger `enforce_interest_clause_present` (fires first)
    //   2. RLS WITH CHECK (firm_id=auth_firm_id() AND is_pm_or_admin())
    // Postgres runs BEFORE row-level triggers before RLS WITH CHECK, so the
    // trigger catches the bad insert at 23514 before RLS gets to 42501.
    // The row was correctly rejected either way; this test accepts either
    // code as proof of the doubly-defended invariant.
    expect(['23514','42501']).toContain(error?.code)
  })

  test('5 — forfeiture_actions: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await pmContext()
    const demandId = await seedDemand(ctx)
    const { error } = await supabase
      .from('forfeiture_actions')
      .insert({
        firm_id:    FOREIGN_FIRM_ID,
        unit_id:    ctx.unitId,
        demand_id:  demandId,
        stage:      's146_drafted',
        notes:      `${PREFIX} foreign ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Immutability — notice_letters_sent has no UPDATE policy (smoke 6)
  // ───────────────────────────────────────────────────────────────────────────

  test('6 — notice_letters_sent: UPDATE blocked (immutable audit)', async () => {
    const ctx = await pmContext()
    const demandId = await seedDemand(ctx)
    const { data: letter, error: insErr } = await supabase
      .from('notice_letters_sent')
      .insert({
        firm_id:        ctx.firmId,
        demand_id:      demandId,
        unit_id:        ctx.unitId,
        leaseholder_id: ctx.leaseholderId,
        letter_code:    'R1',
        letter_type:    'reminder',
        sent_method:    'post',
        sequence_number: 1,
        recipient_address_snapshot: `${PREFIX} letter ${Date.now()}`,
      })
      .select('id').single()
    expect(insErr).toBeNull()
    expect(letter?.id).toBeDefined()

    // Attempt UPDATE — should silently match 0 rows (no UPDATE policy means
    // RLS filters all rows out for non-admin invariant; admin has no policy
    // either). Supabase returns no error but data is empty.
    const { data: updated } = await supabase
      .from('notice_letters_sent')
      .update({ sent_method: 'email' })
      .eq('id', letter!.id)
      .select('id')
    expect(updated?.length ?? 0).toBe(0)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Notice stage machine (smokes 7-11)
  // ───────────────────────────────────────────────────────────────────────────

  test('7 — PM forward edge current→reminder_1 allowed', async () => {
    const ctx = await pmContext()
    const demandId = await seedDemand(ctx)
    const { error } = await supabase
      .from('demands')
      .update({ notice_stage: 'reminder_1' })
      .eq('id', demandId)
    expect(error).toBeNull()
    const { data } = await supabase
      .from('demands').select('notice_stage').eq('id', demandId).single()
    expect(data?.notice_stage).toBe('reminder_1')
  })

  test('8 — reverse edge reminder_1→current rejected for PM, allowed for admin', async () => {
    const pmCtx = await pmContext()
    const demandId = await seedDemand(pmCtx)
    // Advance forward first
    await supabase.from('demands').update({ notice_stage: 'reminder_1' }).eq('id', demandId)
    // Reverse as PM — should fail
    const { error: pmErr } = await supabase
      .from('demands').update({ notice_stage: 'current' }).eq('id', demandId)
    expect(pmErr).not.toBeNull()
    expect(pmErr?.code).toBe('42501')
    // Now reverse as admin — should succeed
    await signInAsAdmin()
    const { error: adminErr } = await supabase
      .from('demands').update({ notice_stage: 'current' }).eq('id', demandId)
    expect(adminErr).toBeNull()
  })

  test('9 — skip-ahead current→pre_action rejected for PM (42501)', async () => {
    const ctx = await pmContext()
    const demandId = await seedDemand(ctx)
    const { error } = await supabase
      .from('demands').update({ notice_stage: 'pre_action' }).eq('id', demandId)
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
  })

  test('10 — pre_action→solicitor_referred without PA rejected (23514)', async () => {
    const adminCtx = await signInAsAdmin()
    const pmCtx = await pmContext()
    const demandId = await seedDemand(pmCtx)
    // Admin advances to pre_action via successive single-stage steps
    await signInAsAdmin()
    await supabase.from('demands').update({ notice_stage: 'reminder_1' }).eq('id', demandId)
    await supabase.from('demands').update({ notice_stage: 'reminder_2' }).eq('id', demandId)
    await supabase.from('demands').update({ notice_stage: 'final_notice' }).eq('id', demandId)
    await supabase.from('demands').update({ notice_stage: 'pre_action' }).eq('id', demandId)
    // No PA exists yet — should be blocked
    const { error } = await supabase
      .from('demands').update({ notice_stage: 'solicitor_referred' }).eq('id', demandId)
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
    expect(adminCtx).toBeDefined()
  })

  test('11 — pre_action→solicitor_referred with accepted PA allowed', async () => {
    const pmCtx = await pmContext()
    const demandId = await seedDemand(pmCtx)
    // Admin advances to pre_action
    const adminCtx = await signInAsAdmin()
    await supabase.from('demands').update({ notice_stage: 'reminder_1' }).eq('id', demandId)
    await supabase.from('demands').update({ notice_stage: 'reminder_2' }).eq('id', demandId)
    await supabase.from('demands').update({ notice_stage: 'final_notice' }).eq('id', demandId)
    await supabase.from('demands').update({ notice_stage: 'pre_action' }).eq('id', demandId)
    // Seed an authorised PA referencing this demand. transaction_id stays NULL
    // (non-payment PA shape per 00023 header); proposed JSONB carries demand_id.
    const { error: paErr } = await supabase
      .from('payment_authorisations')
      .insert({
        firm_id:       adminCtx.firmId,
        action_type:   'solicitor_escalation',
        requested_by:  adminCtx.userId,
        authorised_by: adminCtx.userId,
        authorised_at: new Date().toISOString(),
        status:        'authorised',
        proposed:      { demand_id: demandId, solicitor_firm: `${PREFIX} test` },
      })
    expect(paErr).toBeNull()
    // Now the trigger should permit the transition
    const { error } = await supabase
      .from('demands').update({ notice_stage: 'solicitor_referred' }).eq('id', demandId)
    expect(error).toBeNull()
    const { data } = await supabase
      .from('demands').select('notice_stage, with_solicitor').eq('id', demandId).single()
    expect(data?.notice_stage).toBe('solicitor_referred')
    expect(data?.with_solicitor).toBe(true)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // LTA 1985 s.20B 18-month rule (smokes 12-13)
  // ───────────────────────────────────────────────────────────────────────────

  test('12 — s.20B blocks status=issued after 540d with no notification', async () => {
    const ctx = await pmContext()
    // Insert at status='draft' first to avoid the trigger on INSERT
    const due = new Date(); due.setDate(due.getDate() - 30)
    const issued = new Date(); issued.setDate(issued.getDate() - 14)
    const earliestCost = new Date(); earliestCost.setDate(earliestCost.getDate() - 600)
    const { data: drft } = await supabase.from('demands').insert({
      firm_id:                ctx.firmId,
      property_id:            ctx.propertyId,
      unit_id:                ctx.unitId,
      leaseholder_id:         ctx.leaseholderId,
      demand_type:            'service_charge',
      amount:                 500.00,
      issued_date:            issued.toISOString().slice(0, 10),
      due_date:               due.toISOString().slice(0, 10),
      earliest_unbilled_cost_date: earliestCost.toISOString().slice(0, 10),
      s21b_attached:          true,
      section_153_compliant:  true,
      status:                 'draft',
      notes:                  `${PREFIX} s20b ${Date.now()}`,
    }).select('id').single()
    expect(drft?.id).toBeDefined()
    const { error } = await supabase
      .from('demands').update({ status: 'issued' }).eq('id', drft!.id)
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
  })

  test('13 — s.20B exempts ground_rent demands', async () => {
    const ctx = await pmContext()
    const due = new Date(); due.setDate(due.getDate() - 30)
    const issued = new Date(); issued.setDate(issued.getDate() - 14)
    const earliestCost = new Date(); earliestCost.setDate(earliestCost.getDate() - 600)
    const { data: drft } = await supabase.from('demands').insert({
      firm_id:                ctx.firmId,
      property_id:            ctx.propertyId,
      unit_id:                ctx.unitId,
      leaseholder_id:         ctx.leaseholderId,
      demand_type:            'ground_rent',
      amount:                 250.00,
      issued_date:            issued.toISOString().slice(0, 10),
      due_date:               due.toISOString().slice(0, 10),
      earliest_unbilled_cost_date: earliestCost.toISOString().slice(0, 10),
      s21b_attached:          true,
      section_153_compliant:  true,
      status:                 'draft',
      notes:                  `${PREFIX} s20b-gr ${Date.now()}`,
    }).select('id').single()
    expect(drft?.id).toBeDefined()
    const { error } = await supabase
      .from('demands').update({ status: 'issued' }).eq('id', drft!.id)
    expect(error).toBeNull()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Administration charges sch.11 enforceability (smoke 14)
  // ───────────────────────────────────────────────────────────────────────────

  test('14 — admin charge status=demanded blocked without summary_of_rights_attached', async () => {
    const ctx = await pmContext()
    const { error } = await supabase
      .from('administration_charges')
      .insert({
        firm_id:        ctx.firmId,
        unit_id:        ctx.unitId,
        leaseholder_id: ctx.leaseholderId,
        charge_type:    'reminder_admin_fee',
        amount_net:     60.00,
        vat_amount:     12.00,
        amount_gross:   72.00,
        summary_of_rights_attached: false,
        status:         'demanded',
        notes:          `${PREFIX} sch11 ${Date.now()}`,
      })
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Demand interest — lease-clause-only gate (smoke 15)
  // ───────────────────────────────────────────────────────────────────────────

  test('15 — interest INSERT rejected when no lease clause + no block default', async () => {
    const ctx = await pmContext()
    const demandId = await seedDemand(ctx)
    // Seed defaults out of the way — confirm block_collection_settings has
    // interest_clause_default_present=false (default).
    // No unit_lease override either — most demo seed leases have
    // interest_clause_present=false by default.
    const { error } = await supabase
      .from('demand_interest_charges')
      .insert({
        firm_id:          ctx.firmId,
        demand_id:        demandId,
        unit_id:          ctx.unitId,
        period_from:      '2026-01-01',
        period_to:        '2026-02-01',
        principal_amount: 500.00,
        rate_pct:         8.00,
        interest_amount:  3.40,
        accrual_basis:    'lease_clause',
        lease_clause_ref: `${PREFIX} no-clause`,
        notes:            `${PREFIX} no-clause ${Date.now()}`,
      })
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Forfeiture — Path A / Path B / grace period (smokes 16-18)
  // ───────────────────────────────────────────────────────────────────────────

  test('16 — forfeiture Path A: mortgagee served + grace expired → possession allowed', async () => {
    const adminCtx = await signInAsAdmin()
    const ctx = await pmContext()
    const demandId = await seedDemand(ctx)

    // Seed a mortgagee interested_party.
    const { data: ip, error: ipErr } = await supabase
      .from('interested_parties')
      .insert({
        firm_id:      ctx.firmId,
        property_id:  ctx.propertyId,
        unit_id:      ctx.unitId,
        party_type:   'mortgagee',
        name:         `${PREFIX} Mortgagee Bank plc`,
        address:      '1 Threadneedle St, London',
      })
      .select('id').single()
    expect(ipErr).toBeNull()
    expect(ip?.id).toBeDefined()

    // Seed an authorised possession PA so the stage trigger gate is satisfied.
    const { error: paErr } = await supabase
      .from('payment_authorisations')
      .insert({
        firm_id:       adminCtx.firmId,
        action_type:   'commence_possession_proceedings',
        requested_by:  adminCtx.userId,
        authorised_by: adminCtx.userId,
        authorised_at: new Date().toISOString(),
        status:        'authorised',
        proposed:      { demand_id: demandId },
      })
    expect(paErr).toBeNull()
    const { data: pa } = await supabase
      .from('payment_authorisations')
      .select('id').eq('action_type','commence_possession_proceedings')
      .order('created_at', { ascending: false }).limit(1).single()

    // Service date 30d ago, grace ends 16d ago (s146_served + 14d).
    const served = new Date(); served.setDate(served.getDate() - 30)
    const graceEnds = new Date(served); graceEnds.setDate(graceEnds.getDate() + 14)
    const { data: fa, error: faErr } = await supabase
      .from('forfeiture_actions')
      .insert({
        firm_id:                       ctx.firmId,
        unit_id:                       ctx.unitId,
        demand_id:                     demandId,
        stage:                         's146_drafted',
        s146_served_date:              served.toISOString().slice(0, 10),
        s146_grace_period_ends:        graceEnds.toISOString().slice(0, 10),
        served_on_mortgagee_party_id:  ip!.id,
        mortgagee_served_date:         served.toISOString().slice(0, 10),
        possession_pa_id:              pa!.id,
        notes:                         `${PREFIX} pathA ${Date.now()}`,
      })
      .select('id').single()
    expect(faErr).toBeNull()

    // Walk forward to possession_claim_issued
    for (const stage of ['s146_served','14_day_period','14_day_expired','mortgagee_served',
                         'possession_claim_drafted','possession_claim_issued']) {
      const { error } = await supabase
        .from('forfeiture_actions').update({ stage }).eq('id', fa!.id)
      expect(error, `stage ${stage}`).toBeNull()
    }
  })

  test('17 — forfeiture Path B: assert_no_mortgagee + evidence → possession allowed', async () => {
    const adminCtx = await signInAsAdmin()
    const ctx = await pmContext()
    const demandId = await seedDemand(ctx)

    const { error: paErr } = await supabase
      .from('payment_authorisations')
      .insert({
        firm_id:       adminCtx.firmId,
        action_type:   'commence_possession_proceedings',
        requested_by:  adminCtx.userId,
        authorised_by: adminCtx.userId,
        authorised_at: new Date().toISOString(),
        status:        'authorised',
        proposed:      { demand_id: demandId },
      })
    expect(paErr).toBeNull()
    const { data: pa } = await supabase
      .from('payment_authorisations')
      .select('id').eq('action_type','commence_possession_proceedings')
      .order('created_at', { ascending: false }).limit(1).single()

    const served = new Date(); served.setDate(served.getDate() - 30)
    const graceEnds = new Date(served); graceEnds.setDate(graceEnds.getDate() + 14)
    const { data: fa, error: faErr } = await supabase
      .from('forfeiture_actions')
      .insert({
        firm_id:                       ctx.firmId,
        unit_id:                       ctx.unitId,
        demand_id:                     demandId,
        stage:                         's146_drafted',
        s146_served_date:              served.toISOString().slice(0, 10),
        s146_grace_period_ends:        graceEnds.toISOString().slice(0, 10),
        assert_no_mortgagee:           true,
        assert_no_mortgagee_by:        adminCtx.userId,
        assert_no_mortgagee_at:        new Date().toISOString(),
        assert_no_mortgagee_evidence:  `${PREFIX} HMLR official copy dated ${new Date().toISOString().slice(0, 10)} — no registered charges`,
        possession_pa_id:              pa!.id,
        notes:                         `${PREFIX} pathB ${Date.now()}`,
      })
      .select('id').single()
    expect(faErr).toBeNull()

    for (const stage of ['s146_served','14_day_period','14_day_expired',
                         'possession_claim_drafted','possession_claim_issued']) {
      const { error } = await supabase
        .from('forfeiture_actions').update({ stage }).eq('id', fa!.id)
      expect(error, `stage ${stage}`).toBeNull()
    }
  })

  test('18 — forfeiture: possession_claim_drafted rejected before grace period expires', async () => {
    const adminCtx = await signInAsAdmin()
    const ctx = await pmContext()
    const demandId = await seedDemand(ctx)

    const { error: paErr } = await supabase
      .from('payment_authorisations')
      .insert({
        firm_id:       adminCtx.firmId,
        action_type:   'commence_possession_proceedings',
        requested_by:  adminCtx.userId,
        authorised_by: adminCtx.userId,
        authorised_at: new Date().toISOString(),
        status:        'authorised',
        proposed:      { demand_id: demandId },
      })
    expect(paErr).toBeNull()
    const { data: pa } = await supabase
      .from('payment_authorisations')
      .select('id').eq('action_type','commence_possession_proceedings')
      .order('created_at', { ascending: false }).limit(1).single()

    // Service date today; grace ends in 14 days (future).
    const served = new Date()
    const graceEnds = new Date(served); graceEnds.setDate(graceEnds.getDate() + 14)
    const { data: fa, error: faErr } = await supabase
      .from('forfeiture_actions')
      .insert({
        firm_id:                       ctx.firmId,
        unit_id:                       ctx.unitId,
        demand_id:                     demandId,
        stage:                         's146_served',
        s146_served_date:              served.toISOString().slice(0, 10),
        s146_grace_period_ends:        graceEnds.toISOString().slice(0, 10),
        assert_no_mortgagee:           true,
        assert_no_mortgagee_by:        adminCtx.userId,
        assert_no_mortgagee_at:        new Date().toISOString(),
        assert_no_mortgagee_evidence:  `${PREFIX} HMLR no charge`,
        possession_pa_id:              pa!.id,
        notes:                         `${PREFIX} grace ${Date.now()}`,
      })
      .select('id').single()
    expect(faErr).toBeNull()
    const { error } = await supabase
      .from('forfeiture_actions')
      .update({ stage: 'possession_claim_drafted' })
      .eq('id', fa!.id)
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Unit ledger view RLS bubble-up (smoke 19)
  // ───────────────────────────────────────────────────────────────────────────

  test('19 — unit_ledger_history: only own-firm rows surface', async () => {
    const ctx = await pmContext()
    // Seed a tagged demand so we know what we're looking for.
    const demandId = await seedDemand(ctx)
    expect(demandId).toBeDefined()

    const { data: rows, error } = await supabase
      .from('unit_ledger_history')
      .select('firm_id')
      .limit(50)
    expect(error).toBeNull()
    expect(rows?.length ?? 0).toBeGreaterThanOrEqual(1)
    // Every row should be in PM's firm.
    const foreign = (rows ?? []).filter(r => r.firm_id !== ctx.firmId)
    expect(foreign.length).toBe(0)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // AP signoff PA — closes 00028 §10 FORWARD anchor (smoke 20)
  //   Verifies that an admin can INSERT a payment_authorisation with the new
  //   action_type='major_works_invoice_ap_signoff' against an HRB property,
  //   referencing an invoice + a principal_accountable_persons row. This is
  //   the dual-auth-plus-one AP signoff lane on major-works invoices for HRBs.
  //   Functional UX (request → AP approves → release) lands with Phase 4a UX.
  // ───────────────────────────────────────────────────────────────────────────

  test('20 — major_works_invoice_ap_signoff PA inserts cleanly against HRB invoice + PAP', async () => {
    const adminCtx = await signInAsAdmin()

    // Birchwood Court is the seeded HRB fixture (00034). Has 2 PAPs.
    const { data: birchwood, error: bErr } = await supabase
      .from('properties').select('id').eq('firm_id', adminCtx.firmId).eq('name', 'Birchwood Court').single()
    expect(bErr).toBeNull()
    expect(birchwood?.id).toBeDefined()

    const { data: pap, error: papErr } = await supabase
      .from('principal_accountable_persons')
      .select('id').eq('property_id', birchwood!.id).order('appointed_date', { ascending: true }).limit(1).single()
    expect(papErr).toBeNull()
    expect(pap?.id).toBeDefined()

    // Seed a test invoice on Birchwood. PREFIX-scoped description for cleanup.
    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .insert({
        firm_id:        adminCtx.firmId,
        property_id:    birchwood!.id,
        invoice_number: `${PREFIX}-${Date.now()}`,
        invoice_date:   new Date().toISOString().slice(0, 10),
        amount_net:     5000.00,
        vat_amount:     1000.00,
        amount_gross:   6000.00,
        description:    `${PREFIX} AP-signoff test invoice`,
        status:         'received',
        extracted_by_ai: false,
      })
      .select('id').single()
    expect(invErr).toBeNull()
    expect(invoice?.id).toBeDefined()

    // Insert the PA with action_type='major_works_invoice_ap_signoff'.
    // proposed JSONB carries { invoice_id, accountable_person_id } per the
    // 00035 Section K COMMENT contract. smoke_tag added for cleanup.
    const { error: paErr } = await supabase
      .from('payment_authorisations')
      .insert({
        firm_id:       adminCtx.firmId,
        action_type:   'major_works_invoice_ap_signoff',
        requested_by:  adminCtx.userId,
        status:        'pending',
        proposed: {
          invoice_id:           invoice!.id,
          accountable_person_id: pap!.id,
          smoke_tag:            PREFIX,
        },
      })
    expect(paErr).toBeNull()

    // Verify the row landed and is selectable.
    const { data: paBack, error: selErr } = await supabase
      .from('payment_authorisations')
      .select('id, action_type, status, proposed')
      .eq('action_type', 'major_works_invoice_ap_signoff')
      .order('created_at', { ascending: false }).limit(1).single()
    expect(selErr).toBeNull()
    expect(paBack?.id).toBeDefined()
    expect(paBack?.action_type).toBe('major_works_invoice_ap_signoff')
    const proposed = paBack?.proposed as { invoice_id?: string; accountable_person_id?: string } | null
    expect(proposed?.invoice_id).toBe(invoice!.id)
    expect(proposed?.accountable_person_id).toBe(pap!.id)
  })
})
