/**
 * @file collection-supporting.spec.ts
 * @description Phase 4a — Collection workflow supporting modules smokes.
 *   Pins migration 00036_collection_supporting_modules against silent regression.
 *
 * Tables / triggers / constraints covered (migration 00036):
 *   - charge_schedules                      (Blockman "Schedules" parity)
 *   - charge_schedule_apportionments        (per-unit share)
 *   - csa_enforce_method_coherence trigger  (method↔column coherence)
 *   - charge_schedules DELETE policy        (current_period=0 gate)
 *   - payment_mandates                      (G18; one-active-per-pair)
 *   - uq_pm_one_active_per_unit_charge_type partial-unique index
 *   - ground_rent_remittances               (G20; client-money trail)
 *   - issue_categories                      (G27 firm-level taxonomy)
 *   - issues                                (G27 main row)
 *   - issues_unit_required_for_lh_chk       (leaseholder→unit invariant)
 *   - issue_actions                         (G27 append-only audit)
 *   - demands.scheduled_issue_date          (G24 advance scheduling)
 *
 * Smokes (14):
 *   Cross-firm RLS (7):
 *     1. charge_schedules                — cross-firm INSERT rejected.
 *     2. charge_schedule_apportionments  — cross-firm INSERT rejected.
 *     3. payment_mandates                — cross-firm INSERT rejected.
 *     4. ground_rent_remittances         — cross-firm INSERT rejected.
 *     5. issue_categories                — cross-firm INSERT rejected.
 *     6. issues                          — cross-firm INSERT rejected.
 *     7. issue_actions                   — cross-firm INSERT rejected.
 *   Immutability (1):
 *     8. issue_actions                   — UPDATE silently matches 0 rows.
 *   Method coherence (2):
 *     9. csa method=percentage      requires apportionment_pct (23514).
 *    10. csa method=fixed_per_unit  requires fixed_amount (23514).
 *   Partial-unique mandates (2):
 *    11. Two active payment_mandates per (unit, charge_type) — 23505.
 *    12. Retire (effective_to set) + insert new active — allowed.
 *   DELETE policy (1):
 *    13. charge_schedules DELETE with current_period>0 — 0 rows affected.
 *   CHECK constraint (1):
 *    14. issues from_party=leaseholder + unit_id=NULL rejected (23514).
 *
 * Patterns honoured (from bsa-module.spec.ts + collection-state-machine.spec.ts):
 *   - PREFIX-scoped row names for safe cleanup.
 *   - FOREIGN_FIRM_ID stable UUID for cross-firm WITH CHECK rejection.
 *   - Either-code tolerance on doubly-defended tables (see
 *     feedback_trigger_fires_before_rls memory).
 *
 * Cleanup order (FK-safe; admin sign-in required):
 *   issue_actions → issues → seeded issue_categories (PREFIX only — leaves
 *   migration seeded categories alone) → ground_rent_remittances →
 *   payment_mandates → charge_schedule_apportionments → charge_schedules →
 *   PREFIX-tagged demands.
 */
import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './_env'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const PREFIX = 'Smoke SUPP'
const FOREIGN_FIRM_ID = '00000000-0000-4000-8000-000000005EC2'

interface PmContext {
  userId:        string
  firmId:        string
  propertyId:    string
  unitId:        string
  leaseholderId: string
  landlordId:    string
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
  const { data: landlord } = await supabase
    .from('landlords').select('id').eq('firm_id', firmId).limit(1).single()
  if (!landlord) throw new Error(`No landlord seeded in firm ${firmId}`)
  return {
    userId, firmId,
    propertyId: prop.id, unitId: unit.id,
    leaseholderId: lh.id, landlordId: landlord.id,
  }
}

/** Create a charge_schedule and return its id. method defaults to 'percentage'. */
async function seedSchedule(
  ctx: PmContext,
  opts: { method?: string; chargeType?: string } = {},
): Promise<string> {
  const method = opts.method ?? 'percentage'
  const chargeType = opts.chargeType ?? 'service_charge'
  const { data, error } = await supabase
    .from('charge_schedules')
    .insert({
      firm_id:              ctx.firmId,
      property_id:          ctx.propertyId,
      schedule_name:        `${PREFIX} ${method} ${Date.now()}`,
      charge_type:          chargeType,
      frequency:            'yearly',
      apportionment_method: method,
      period_start:         '2026-01-01',
      period_end:           '2026-12-31',
      total_periods:        1,
      total_budget_amount:  10000.00,
    })
    .select('id').single()
  if (error || !data) throw new Error(`seedSchedule failed: ${error?.message}`)
  return data.id
}

/** Seed a demand with PREFIX notes; demand_type defaults to ground_rent for GR remit tests. */
async function seedDemand(
  ctx: PmContext,
  opts: { demandType?: string } = {},
): Promise<string> {
  const demandType = opts.demandType ?? 'ground_rent'
  const due = new Date(); due.setDate(due.getDate() - 30)
  const issued = new Date(due); issued.setDate(issued.getDate() - 14)
  const { data, error } = await supabase
    .from('demands')
    .insert({
      firm_id:                ctx.firmId,
      property_id:            ctx.propertyId,
      unit_id:                ctx.unitId,
      leaseholder_id:         ctx.leaseholderId,
      demand_type:            demandType,
      amount:                 250.00,
      issued_date:            issued.toISOString().slice(0, 10),
      due_date:               due.toISOString().slice(0, 10),
      s21b_attached:          true,
      section_153_compliant:  true,
      status:                 'issued',
      notes:                  `${PREFIX} demand ${Date.now()}`,
    })
    .select('id').single()
  if (error || !data) throw new Error(`seedDemand failed: ${error?.message}`)
  return data.id
}

test.describe('Phase 4a — collection supporting modules smokes (migration 00036)', () => {
  test.afterAll(async () => {
    await signInAsAdmin()

    // FK-safe sweep, child rows first.
    await supabase.from('issue_actions').delete().like('action_text', `${PREFIX}%`)
    await supabase.from('issues').delete().like('brief_description', `${PREFIX}%`)
    // Seeded issue_categories (3 default) are left in place; only PREFIX-tagged
    // categories created by test #5 are swept.
    await supabase.from('issue_categories').delete().like('name', `${PREFIX}%`)
    await supabase.from('ground_rent_remittances').delete().like('notes', `${PREFIX}%`)
    await supabase.from('payment_mandates').delete().like('notes', `${PREFIX}%`)
    await supabase.from('charge_schedule_apportionments').delete().like('notes', `${PREFIX}%`)
    await supabase.from('charge_schedules').delete().like('schedule_name', `${PREFIX}%`)
    await supabase.from('demands').delete().like('notes', `${PREFIX}%`)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Cross-firm RLS rejection (smokes 1-7)
  // ───────────────────────────────────────────────────────────────────────────

  test('1 — charge_schedules: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await pmContext()
    const { error } = await supabase
      .from('charge_schedules')
      .insert({
        firm_id:              FOREIGN_FIRM_ID,
        property_id:          ctx.propertyId,
        schedule_name:        `${PREFIX} foreign ${Date.now()}`,
        charge_type:          'service_charge',
        frequency:            'yearly',
        apportionment_method: 'percentage',
        period_start:         '2026-01-01',
        period_end:           '2026-12-31',
        total_periods:        1,
        total_budget_amount:  100.00,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
  })

  test('2 — charge_schedule_apportionments: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await pmContext()
    const scheduleId = await seedSchedule(ctx)
    const { error } = await supabase
      .from('charge_schedule_apportionments')
      .insert({
        firm_id:           FOREIGN_FIRM_ID,
        schedule_id:       scheduleId,
        unit_id:           ctx.unitId,
        apportionment_pct: 4.7619,
        notes:             `${PREFIX} foreign ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
  })

  test('3 — payment_mandates: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await pmContext()
    const { error } = await supabase
      .from('payment_mandates')
      .insert({
        firm_id:        FOREIGN_FIRM_ID,
        unit_id:        ctx.unitId,
        leaseholder_id: ctx.leaseholderId,
        charge_type:    'service_charge',
        mandate_type:   'direct_debit',
        effective_from: '2026-01-01',
        notes:          `${PREFIX} foreign ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
  })

  test('4 — ground_rent_remittances: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await pmContext()
    const demandId = await seedDemand(ctx, { demandType: 'ground_rent' })
    const { error } = await supabase
      .from('ground_rent_remittances')
      .insert({
        firm_id:           FOREIGN_FIRM_ID,
        demand_id:         demandId,
        landlord_id:       ctx.landlordId,
        amount_remitted:   250.00,
        remittance_method: 'bank_transfer',
        notes:             `${PREFIX} foreign ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
  })

  test('5 — issue_categories: cross-firm INSERT rejected (42501)', async () => {
    await pmContext()  // sign in as PM
    const { error } = await supabase
      .from('issue_categories')
      .insert({
        firm_id:    FOREIGN_FIRM_ID,
        name:       `${PREFIX} Foreign Category ${Date.now()}`,
        sort_order: 99,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
  })

  test('6 — issues: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await pmContext()
    const { error } = await supabase
      .from('issues')
      .insert({
        firm_id:           FOREIGN_FIRM_ID,
        property_id:       ctx.propertyId,
        unit_id:           ctx.unitId,
        from_party:        'pm',
        from_user_id:      ctx.userId,
        brief_description: `${PREFIX} foreign issue ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
  })

  test('7 — issue_actions: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await pmContext()
    // Seed an issue in PM's firm to FK against.
    const { data: issue, error: issueErr } = await supabase
      .from('issues')
      .insert({
        firm_id:           ctx.firmId,
        property_id:       ctx.propertyId,
        unit_id:           ctx.unitId,
        from_party:        'pm',
        from_user_id:      ctx.userId,
        from_text:         'Smoke SUPP PM',
        brief_description: `${PREFIX} parent for action smoke ${Date.now()}`,
      })
      .select('id').single()
    expect(issueErr).toBeNull()
    expect(issue?.id).toBeDefined()

    const { error } = await supabase
      .from('issue_actions')
      .insert({
        firm_id:     FOREIGN_FIRM_ID,
        issue_id:    issue!.id,
        action_text: `${PREFIX} foreign action ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Immutability — issue_actions has no UPDATE policy (smoke 8)
  // ───────────────────────────────────────────────────────────────────────────

  test('8 — issue_actions: UPDATE blocked (immutable audit)', async () => {
    const ctx = await pmContext()
    const { data: issue } = await supabase
      .from('issues')
      .insert({
        firm_id:           ctx.firmId,
        property_id:       ctx.propertyId,
        unit_id:           ctx.unitId,
        from_party:        'pm',
        from_user_id:      ctx.userId,
        from_text:         'Smoke SUPP PM',
        brief_description: `${PREFIX} immutable test ${Date.now()}`,
      })
      .select('id').single()
    expect(issue?.id).toBeDefined()

    const { data: action, error: insErr } = await supabase
      .from('issue_actions')
      .insert({
        firm_id:     ctx.firmId,
        issue_id:    issue!.id,
        action_type: 'note',
        action_text: `${PREFIX} action ${Date.now()}`,
      })
      .select('id').single()
    expect(insErr).toBeNull()

    const { data: updated } = await supabase
      .from('issue_actions')
      .update({ action_text: `${PREFIX} MUTATED` })
      .eq('id', action!.id)
      .select('id')
    expect(updated?.length ?? 0).toBe(0)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // csa method-coherence trigger (smokes 9-10)
  // ───────────────────────────────────────────────────────────────────────────

  test('9 — csa: method=percentage requires apportionment_pct (23514)', async () => {
    const ctx = await pmContext()
    const scheduleId = await seedSchedule(ctx, { method: 'percentage' })
    const { error } = await supabase
      .from('charge_schedule_apportionments')
      .insert({
        firm_id:      ctx.firmId,
        schedule_id:  scheduleId,
        unit_id:      ctx.unitId,
        // apportionment_pct omitted → trigger should raise 23514
        notes:        `${PREFIX} no-pct ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
  })

  test('10 — csa: method=fixed_per_unit requires fixed_amount (23514)', async () => {
    const ctx = await pmContext()
    const scheduleId = await seedSchedule(ctx, { method: 'fixed_per_unit' })
    const { error } = await supabase
      .from('charge_schedule_apportionments')
      .insert({
        firm_id:      ctx.firmId,
        schedule_id:  scheduleId,
        unit_id:      ctx.unitId,
        // fixed_amount omitted → trigger should raise 23514
        notes:        `${PREFIX} no-fixed ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // payment_mandates partial-unique (smokes 11-12)
  // ───────────────────────────────────────────────────────────────────────────

  test('11 — payment_mandates: two active per (unit, charge_type) rejected (23505)', async () => {
    const ctx = await pmContext()
    const chargeType = `${PREFIX}-uniq-${Date.now()}`  // not a real demand_type, just a unique tag
    // Workaround: payment_mandates.charge_type is TEXT free-form; we use a
    // PREFIX-tagged value to avoid collision with real seed mandates.

    const { data: first, error: e1 } = await supabase
      .from('payment_mandates')
      .insert({
        firm_id:        ctx.firmId,
        unit_id:        ctx.unitId,
        leaseholder_id: ctx.leaseholderId,
        charge_type:    chargeType,
        mandate_type:   'direct_debit',
        effective_from: '2026-01-01',
        notes:          `${PREFIX} first ${Date.now()}`,
      })
      .select('id').single()
    expect(e1).toBeNull()
    expect(first?.id).toBeDefined()

    const { error: e2 } = await supabase
      .from('payment_mandates')
      .insert({
        firm_id:        ctx.firmId,
        unit_id:        ctx.unitId,
        leaseholder_id: ctx.leaseholderId,
        charge_type:    chargeType,
        mandate_type:   'standing_order',
        effective_from: '2026-02-01',
        notes:          `${PREFIX} second ${Date.now()}`,
      })
      .select('id').single()
    expect(e2).not.toBeNull()
    expect(e2?.code).toBe('23505')
  })

  test('12 — payment_mandates: retire + insert new active for same pair allowed', async () => {
    const ctx = await pmContext()
    const chargeType = `${PREFIX}-rotate-${Date.now()}`

    const { data: first } = await supabase
      .from('payment_mandates')
      .insert({
        firm_id:        ctx.firmId,
        unit_id:        ctx.unitId,
        leaseholder_id: ctx.leaseholderId,
        charge_type:    chargeType,
        mandate_type:   'direct_debit',
        effective_from: '2026-01-01',
        notes:          `${PREFIX} rotate-old ${Date.now()}`,
      })
      .select('id').single()
    expect(first?.id).toBeDefined()

    // Retire the first (effective_to set + cancelled audit fields).
    const { error: retireErr } = await supabase
      .from('payment_mandates')
      .update({
        effective_to:     '2026-03-31',
        cancelled_at:     new Date().toISOString(),
        cancelled_by:     ctx.userId,
        cancelled_reason: 'rotated for smoke 12',
      })
      .eq('id', first!.id)
    expect(retireErr).toBeNull()

    // Insert new active for same (unit, charge_type) — partial-unique idx
    // only counts rows where effective_to IS NULL, so this must succeed.
    const { data: second, error: e2 } = await supabase
      .from('payment_mandates')
      .insert({
        firm_id:        ctx.firmId,
        unit_id:        ctx.unitId,
        leaseholder_id: ctx.leaseholderId,
        charge_type:    chargeType,
        mandate_type:   'standing_order',
        effective_from: '2026-04-01',
        notes:          `${PREFIX} rotate-new ${Date.now()}`,
      })
      .select('id').single()
    expect(e2).toBeNull()
    expect(second?.id).toBeDefined()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // charge_schedules DELETE policy (smoke 13)
  // ───────────────────────────────────────────────────────────────────────────

  test('13 — charge_schedules: admin DELETE blocked when current_period>0 (0 rows)', async () => {
    const ctx = await pmContext()
    const scheduleId = await seedSchedule(ctx)

    // Admin advances current_period to simulate materialisation.
    await signInAsAdmin()
    const { error: bumpErr } = await supabase
      .from('charge_schedules')
      .update({ current_period: 1 })
      .eq('id', scheduleId)
    expect(bumpErr).toBeNull()

    // Attempt DELETE as admin — policy includes `AND current_period = 0`,
    // so the row is invisible to the DELETE policy.
    const { data: deleted, error: delErr } = await supabase
      .from('charge_schedules')
      .delete()
      .eq('id', scheduleId)
      .select('id')
    expect(delErr).toBeNull()
    expect(deleted?.length ?? 0).toBe(0)

    // Verify still exists.
    const { data: stillThere } = await supabase
      .from('charge_schedules')
      .select('id, current_period')
      .eq('id', scheduleId).single()
    expect(stillThere?.id).toBe(scheduleId)
    expect(stillThere?.current_period).toBe(1)

    // Reset current_period to 0 so afterAll can sweep it.
    await supabase.from('charge_schedules').update({ current_period: 0 }).eq('id', scheduleId)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // issues unit-required CHECK for leaseholder (smoke 14)
  // ───────────────────────────────────────────────────────────────────────────

  test('14 — issues: from_party=leaseholder + unit_id=NULL rejected (23514)', async () => {
    const ctx = await pmContext()
    const { error } = await supabase
      .from('issues')
      .insert({
        firm_id:           ctx.firmId,
        property_id:       ctx.propertyId,
        // unit_id deliberately omitted
        from_party:        'leaseholder',
        from_text:         `${PREFIX} leaseholder name`,
        brief_description: `${PREFIX} unit-missing ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
  })
})
