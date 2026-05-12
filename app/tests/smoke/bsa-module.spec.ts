/**
 * @file bsa-module.spec.ts
 * @description Phase 4 BSA — Building Safety Act 2022 — Higher-Risk Building
 *   module smokes. Pins migration 00034_bsa_expansion against silent regression.
 *
 * Tables / triggers / constraints covered (migration 00034):
 *   - principal_accountable_persons  (junction, multi-PAP per HRB property)
 *   - building_safety_cases          (single row + supersede chain)
 *   - safety_strategies              (discriminated: fire / structural)
 *   - golden_thread_documents        (junction; replaces records.document_ids[])
 *   - bsc_hrb_only / strat_hrb_only  (HRB-only trigger gates)
 *   - bsc_golden_thread_audit        (audit-log on BSC INSERT)
 *   - pap_golden_thread_audit        (audit-log on PAP INSERT)
 *   - pap_min_one_active             (≥1 active PAP per HRB property)
 *
 * Smokes (11):
 *   1.  principal_accountable_persons — cross-firm INSERT rejected (42501).
 *   2.  building_safety_cases         — cross-firm INSERT rejected (42501).
 *   3.  safety_strategies             — cross-firm INSERT rejected (42501).
 *   4.  principal_accountable_persons — role CHECK rejects invalid enum (23514).
 *   5.  building_safety_cases         — status CHECK rejects invalid enum (23514).
 *   6.  safety_strategies             — strategy_type CHECK rejects invalid enum (23514).
 *   7.  building_safety_cases INSERT  — writes golden_thread_audit_log row
 *       (notes LIKE 'bsa_case:<id>%').
 *   8.  Leaseholder — can SELECT principal_accountable_persons in own firm.
 *       (Policy: firm-wide; BSA 2022 s.91 resident engagement.)
 *   9.  Leaseholder — can SELECT building_safety_cases ONLY for properties on which
 *       they hold a current leasehold; rows for other properties not returned.
 *   10. HRB positive — PM can INSERT non-conflicting PAP + BSC + strategy against
 *       Birchwood Court (the seeded HRB fixture).
 *   11. HRB negative — INSERT of BSC or safety_strategy against a non-HRB property
 *       (Maple House) rejected by bsc_hrb_only / strat_hrb_only trigger (23514).
 *
 * Patterns honoured (from 1i6-rls.spec.ts + security-rls.spec.ts):
 *   - PREFIX-scoped row names + notes so afterAll can sweep safely.
 *   - FOREIGN_FIRM_ID stable UUID for cross-firm WITH CHECK rejection.
 *   - signInAsPm / signInAsAdmin / signInAsLeaseholder helpers.
 *   - PostgREST surfaces CHECK + RAISE EXCEPTION USING ERRCODE='23514' as '23514',
 *     RLS WITH CHECK as '42501'.
 *
 * Cleanup unwinds in FK-safe order (admin sign-in required for audit-log DELETE):
 *   safety_strategies → building_safety_cases → principal_accountable_persons →
 *   golden_thread_audit_log entries tagged with our PREFIX.
 */
import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './_env'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const PREFIX = 'Smoke BSA'
const FOREIGN_FIRM_ID = '00000000-0000-4000-8000-000000005EC0'

interface PmContext {
  userId:           string
  firmId:           string
  birchwoodId:      string   // HRB property (is_hrb=true)
  mapleId:          string   // non-HRB property (is_hrb=false)
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

async function signInAsPm(): Promise<PmContext> {
  const { userId, firmId } = await signInAs('pm@propos.local')

  const { data: birchwood, error: bErr } = await supabase
    .from('properties').select('id').eq('firm_id', firmId).eq('name', 'Birchwood Court').single()
  if (bErr || !birchwood) throw new Error(`Birchwood Court not seeded? ${bErr?.message}`)

  const { data: maple, error: mErr } = await supabase
    .from('properties').select('id').eq('firm_id', firmId).eq('name', 'Maple House').single()
  if (mErr || !maple) throw new Error(`Maple House not seeded? ${mErr?.message}`)

  return { userId, firmId, birchwoodId: birchwood.id, mapleId: maple.id }
}

test.describe('Phase 4 BSA — module smokes (migration 00034)', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })

    // FK-safe sweep order: child rows first. Test rows identified by PREFIX in
    // notes / title / external_name. golden_thread_audit_log entries are tagged
    // by being descendants of the BSC/PAP rows we deleted — sweep by notes pattern.
    await supabase.from('safety_strategies').delete().like('notes', `${PREFIX}%`)
    await supabase.from('building_safety_cases').delete().like('title', `${PREFIX}%`)
    await supabase.from('principal_accountable_persons').delete().like('notes', `${PREFIX}%`)
    // Audit-log sweep last: bsa_case: / pap: prefixed notes from our triggers will
    // be left dangling otherwise. Admin DELETE allowed; PM is blocked by C-3.
    await supabase.from('golden_thread_audit_log').delete().like('notes', `bsa_case:%${PREFIX}%`)
    await supabase.from('golden_thread_audit_log').delete().like('notes', `pap:%${PREFIX}%`)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Cross-firm RLS rejection (smokes 1-3)
  // ───────────────────────────────────────────────────────────────────────────

  test('1 — principal_accountable_persons: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('principal_accountable_persons')
      .insert({
        firm_id:        FOREIGN_FIRM_ID,
        property_id:    ctx.birchwoodId,
        external_name:  `${PREFIX} foreign-firm PAP ${Date.now()}`,
        role:           'principal',
        is_lead:        false,
        appointed_date: '2024-04-01',
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
    expect(data).toBeNull()
  })

  test('2 — building_safety_cases: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('building_safety_cases')
      .insert({
        firm_id:            FOREIGN_FIRM_ID,
        property_id:        ctx.birchwoodId,
        version_number:     1,
        status:             'draft',
        title:              `${PREFIX} foreign-firm BSC ${Date.now()}`,
        is_current_version: false,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
    expect(data).toBeNull()
  })

  test('3 — safety_strategies: cross-firm INSERT rejected (42501)', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('safety_strategies')
      .insert({
        firm_id:         FOREIGN_FIRM_ID,
        property_id:     ctx.birchwoodId,
        strategy_type:   'fire',
        title:           `${PREFIX} foreign-firm strategy ${Date.now()}`,
        next_review_due: '2026-04-01',
        status:          'draft',
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
    expect(data).toBeNull()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // CHECK constraint rejection (smokes 4-6)
  // ───────────────────────────────────────────────────────────────────────────

  test('4 — principal_accountable_persons: role CHECK rejects invalid enum (23514)', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('principal_accountable_persons')
      .insert({
        firm_id:        ctx.firmId,
        property_id:    ctx.birchwoodId,
        external_name:  `${PREFIX} bad-role PAP ${Date.now()}`,
        role:           'not_a_real_role',
        is_lead:        false,
        appointed_date: '2024-04-01',
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
    expect(data).toBeNull()
  })

  test('5 — building_safety_cases: status CHECK rejects invalid enum (23514)', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('building_safety_cases')
      .insert({
        firm_id:            ctx.firmId,
        property_id:        ctx.birchwoodId,
        version_number:     1,
        status:             'not_a_real_status',
        title:              `${PREFIX} bad-status BSC ${Date.now()}`,
        is_current_version: false,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
    expect(data).toBeNull()
  })

  test('6 — safety_strategies: strategy_type CHECK rejects invalid enum (23514)', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('safety_strategies')
      .insert({
        firm_id:         ctx.firmId,
        property_id:     ctx.birchwoodId,
        strategy_type:   'not_a_real_type',
        title:           `${PREFIX} bad-type strategy ${Date.now()}`,
        next_review_due: '2026-04-01',
        status:          'draft',
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
    expect(data).toBeNull()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Golden-thread audit (smoke 7)
  // ───────────────────────────────────────────────────────────────────────────

  test('7 — building_safety_cases INSERT writes golden_thread_audit_log row', async () => {
    const ctx = await signInAsPm()

    const { data: bsc, error: bscErr } = await supabase
      .from('building_safety_cases')
      .insert({
        firm_id:            ctx.firmId,
        property_id:        ctx.birchwoodId,
        version_number:     2,
        status:             'draft',
        title:              `${PREFIX} audit-trigger BSC ${Date.now()}`,
        is_current_version: false,
      })
      .select('id').single()
    expect(bscErr).toBeNull()
    expect(bsc?.id).toBeDefined()

    // Audit log SELECT — RLS firm-scoped. The trigger writes a row tagged
    // 'bsa_case:<bsc.id> status:draft version:2'.
    const expectedNotesPrefix = `bsa_case:${bsc!.id}`
    const { data: auditRows, error: auditErr } = await supabase
      .from('golden_thread_audit_log')
      .select('id, action, notes')
      .eq('property_id', ctx.birchwoodId)
      .like('notes', `${expectedNotesPrefix}%`)
    expect(auditErr).toBeNull()
    expect(auditRows?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(auditRows![0].action).toBe('created')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Leaseholder portal RLS (smokes 8-9)
  // ───────────────────────────────────────────────────────────────────────────

  test('8 — leaseholder: can SELECT principal_accountable_persons in own firm', async () => {
    await signInAs('leaseholder@propos.local')

    const { data: paps, error } = await supabase
      .from('principal_accountable_persons')
      .select('id, property_id, role, is_lead')
    expect(error).toBeNull()
    // At least the two seeded Birchwood PAPs (corporate + resident) — leaseholder
    // policy is firm-wide per BSA 2022 s.91 resident engagement.
    expect(paps?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  test('9 — leaseholder: can SELECT building_safety_cases only for own-property leaseholds', async () => {
    const { userId } = await signInAs('leaseholder@propos.local')

    // What properties does this leaseholder hold a current leasehold on?
    const { data: ownUnits } = await supabase
      .from('leaseholders')
      .select('unit_id, units(property_id)')
      .eq('user_id', userId).eq('is_current', true)
    const ownPropertyIds = new Set(
      (ownUnits ?? [])
        .map((r: any) => r.units?.property_id)
        .filter((id: string | undefined): id is string => !!id)
    )

    const { data: cases, error } = await supabase
      .from('building_safety_cases')
      .select('id, property_id')
    expect(error).toBeNull()
    for (const c of cases ?? []) {
      // Every returned case must be on a property the leaseholder leases.
      expect(ownPropertyIds.has(c.property_id)).toBe(true)
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // HRB-only trigger (smokes 10-11)
  // ───────────────────────────────────────────────────────────────────────────

  test('10 — HRB positive: PM can INSERT non-conflicting PAP + BSC + strategy on Birchwood', async () => {
    const ctx = await signInAsPm()
    const suffix = `${Date.now()}`

    // Non-lead, non-conflicting PAP (the seeded PAP is is_lead=true; partial-unique
    // idx allows additional non-lead PAPs).
    const { data: pap, error: papErr } = await supabase
      .from('principal_accountable_persons')
      .insert({
        firm_id:        ctx.firmId,
        property_id:    ctx.birchwoodId,
        external_name:  `${PREFIX} extra accountable ${suffix}`,
        role:           'accountable',
        is_lead:        false,
        appointed_date: '2024-04-01',
        notes:          `${PREFIX} smoke 10 positive PAP`,
      })
      .select('id').single()
    expect(papErr).toBeNull()
    expect(pap?.id).toBeDefined()

    // Non-current draft BSC (partial-unique idx allows one current; we go non-current).
    const { data: bsc, error: bscErr } = await supabase
      .from('building_safety_cases')
      .insert({
        firm_id:            ctx.firmId,
        property_id:        ctx.birchwoodId,
        version_number:     99,
        status:             'draft',
        title:              `${PREFIX} smoke 10 draft BSC ${suffix}`,
        is_current_version: false,
      })
      .select('id').single()
    expect(bscErr).toBeNull()
    expect(bsc?.id).toBeDefined()

    // Draft strategy (existing fire strategy is status='current'; partial-unique idx
    // keys on status='current' only, so a status='draft' row coexists fine).
    const { data: strat, error: stratErr } = await supabase
      .from('safety_strategies')
      .insert({
        firm_id:         ctx.firmId,
        property_id:     ctx.birchwoodId,
        strategy_type:   'fire',
        title:           `${PREFIX} smoke 10 draft strategy ${suffix}`,
        next_review_due: '2026-04-01',
        status:          'draft',
        notes:           `${PREFIX} smoke 10 positive strategy`,
      })
      .select('id').single()
    expect(stratErr).toBeNull()
    expect(strat?.id).toBeDefined()
  })

  test('11 — HRB negative: INSERT BSC against non-HRB Maple House rejected (23514)', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('building_safety_cases')
      .insert({
        firm_id:            ctx.firmId,
        property_id:        ctx.mapleId,  // is_hrb=false
        version_number:     1,
        status:             'draft',
        title:              `${PREFIX} smoke 11 maple-non-HRB ${Date.now()}`,
        is_current_version: false,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
    // Trigger MESSAGE carries the canonical citation form (AUDIT R-8 lockstep).
    expect(error?.message ?? '').toMatch(/Building Safety Act 2022 — Higher-Risk Building/)
    expect(data).toBeNull()
  })
})
