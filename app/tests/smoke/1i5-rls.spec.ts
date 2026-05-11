/**
 * @file 1i5-rls.spec.ts
 * @description 1i.5 data-backfill RLS + structural-constraint smokes.
 *
 * Tables covered (migration 00031_landlords_mc_unit_leases.sql):
 *   - landlords                          (G1)
 *   - management_companies               (G2)
 *   - management_company_directors       (G2 director junction; Blockman parity)
 *   - unit_leases                        (G3 + G4 nested)
 *
 * Smokes (6):
 *   1. landlords — PM cannot INSERT with foreign firm_id (42501).
 *   2. management_companies — PM cannot INSERT with foreign firm_id (42501).
 *   3. management_company_directors — PM cannot INSERT with foreign firm_id
 *      (42501); also exercises the ON DELETE CASCADE FK to management_companies
 *      via cleanup.
 *   4. unit_leases — PM cannot INSERT with foreign firm_id (42501).
 *   5. unit_leases — partial-unique idx (unit_id WHERE is_current) rejects a
 *      second is_current=true row for the same unit (23505).
 *   6. properties — landlord_id FK rejects insert of a non-existent landlord
 *      UUID on UPDATE (23503).
 *
 * Patterns mirrored from security-rls.spec.ts:
 *   - PREFIX-scoped row names for safe afterAll sweep.
 *   - FOREIGN_FIRM_ID stable UUID for cross-firm WITH CHECK rejection.
 *   - signInAs helper resolves the PM's firm_id + a property/unit anchor.
 *   - RLS rejections asserted via error.code === '42501'.
 *
 * FORWARD: when the financial-rules Edge Function commit seeds a second firm
 * fixture via service-role-key, extend these smokes with a true cross-firm
 * SELECT-isolation check (currently approximated by the WITH CHECK rejection
 * on INSERT — symmetric protection).
 */
import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './_env'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const PREFIX = 'Smoke 1i5'
const FOREIGN_FIRM_ID = '00000000-0000-4000-8000-000000005EC0'

interface PmContext {
  userId:     string
  firmId:     string
  propertyId: string
  unitId:     string
}

async function signInAsPm(): Promise<PmContext> {
  const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
    email: 'pm@propos.local', password: 'PropOS2026!',
  })
  if (authErr || !auth.user) throw new Error(`pm sign-in failed: ${authErr?.message}`)

  const { data: row, error: rowErr } = await supabase
    .from('users').select('firm_id').eq('id', auth.user.id).single()
  if (rowErr || !row) throw new Error(`pm users row not readable: ${rowErr?.message}`)

  const { data: prop, error: propErr } = await supabase
    .from('properties').select('id').eq('firm_id', row.firm_id).limit(1).single()
  if (propErr || !prop) throw new Error(`No property in pm firm: ${propErr?.message}`)

  const { data: unit, error: unitErr } = await supabase
    .from('units').select('id').eq('property_id', prop.id).limit(1).single()
  if (unitErr || !unit) throw new Error(`No unit on property ${prop.id}: ${unitErr?.message}`)

  return {
    userId:     auth.user.id,
    firmId:     row.firm_id,
    propertyId: prop.id,
    unitId:     unit.id,
  }
}

test.describe('1i.5 — landlords / management_companies / unit_leases RLS + constraints', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })

    // FK-safe sweep order: unit_leases → management_companies (directors
    // cascade) → landlords. Test rows identified by name/notes LIKE prefix.
    await supabase.from('unit_leases').delete().like('notes', `${PREFIX}%`)
    await supabase.from('management_companies').delete().like('name', `${PREFIX}%`)
    await supabase.from('landlords').delete().like('name', `${PREFIX}%`)
    // properties.landlord_id reset (smoke 6 leaves it NULL via rejection;
    // belt-and-braces in case a future test mutates it successfully).
    // No mutation expected here.
  })

  // ── Smoke 1 — landlords cross-firm INSERT rejected ────────────────────────
  test('landlords — PM cannot INSERT with foreign firm_id', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('landlords')
      .insert({
        firm_id:       FOREIGN_FIRM_ID,
        name:          `${PREFIX} foreign-firm landlord ${Date.now()}`,
        landlord_type: 'investor',
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
    expect(data).toBeNull()
  })

  // ── Smoke 2 — management_companies cross-firm INSERT rejected ─────────────
  test('management_companies — PM cannot INSERT with foreign firm_id', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('management_companies')
      .insert({
        firm_id:      FOREIGN_FIRM_ID,
        name:         `${PREFIX} foreign-firm MC ${Date.now()}`,
        company_type: 'rmc',
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
    expect(data).toBeNull()
  })

  // ── Smoke 3 — management_company_directors cross-firm INSERT rejected ─────
  test('management_company_directors — PM cannot INSERT with foreign firm_id', async () => {
    const ctx = await signInAsPm()

    // Seed an MC in PM's own firm so the director INSERT has a valid FK target.
    const { data: mc, error: mcErr } = await supabase
      .from('management_companies')
      .insert({
        firm_id:      ctx.firmId,
        name:         `${PREFIX} own-firm MC for director smoke ${Date.now()}`,
        company_type: 'rmc',
      })
      .select('id').single()
    expect(mcErr).toBeNull()
    expect(mc?.id).toBeTruthy()

    const { data, error } = await supabase
      .from('management_company_directors')
      .insert({
        firm_id:               FOREIGN_FIRM_ID,
        management_company_id: mc!.id,
        name:                  `${PREFIX} foreign-firm director`,
        appointed_date:        '2026-01-01',
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
    expect(data).toBeNull()

    // Cleanup MC handled by afterAll (name LIKE PREFIX% sweep).
  })

  // ── Smoke 4 — unit_leases cross-firm INSERT rejected ──────────────────────
  test('unit_leases — PM cannot INSERT with foreign firm_id', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('unit_leases')
      .insert({
        firm_id:    FOREIGN_FIRM_ID,
        unit_id:    ctx.unitId,
        is_current: true,
        notes:      `${PREFIX} foreign-firm lease`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
    expect(data).toBeNull()
  })

  // ── Smoke 5 — partial-unique idx blocks 2nd current lease per unit ────────
  test('unit_leases — partial-unique idx rejects second is_current=true per unit', async () => {
    const ctx = await signInAsPm()

    // First current lease — should succeed.
    const { data: first, error: firstErr } = await supabase
      .from('unit_leases')
      .insert({
        firm_id:           ctx.firmId,
        unit_id:           ctx.unitId,
        is_current:        true,
        commencement_date: '2020-01-01',
        notes:             `${PREFIX} first current lease`,
      })
      .select('id').single()
    expect(firstErr).toBeNull()
    expect(first?.id).toBeTruthy()

    // Second current lease on same unit — should fail with 23505 unique
    // constraint violation against uq_unit_leases_one_current_per_unit.
    const { data: second, error: secondErr } = await supabase
      .from('unit_leases')
      .insert({
        firm_id:           ctx.firmId,
        unit_id:           ctx.unitId,
        is_current:        true,
        commencement_date: '2025-01-01',
        notes:             `${PREFIX} second current lease (should fail)`,
      })
      .select('id').single()
    expect(secondErr).not.toBeNull()
    expect(secondErr?.code).toBe('23505')
    expect(second).toBeNull()

    // A SECOND non-current lease IS permitted (lease history; partial idx
    // excludes is_current=false rows).
    const { data: history, error: histErr } = await supabase
      .from('unit_leases')
      .insert({
        firm_id:           ctx.firmId,
        unit_id:           ctx.unitId,
        is_current:        false,
        commencement_date: '2010-01-01',
        notes:             `${PREFIX} historic lease (non-current; allowed)`,
      })
      .select('id').single()
    expect(histErr).toBeNull()
    expect(history?.id).toBeTruthy()

    // Cleanup handled by afterAll (notes LIKE PREFIX% sweep).
  })

  // ── Smoke 6 — properties.landlord_id FK rejects bogus UUID ────────────────
  test('properties.landlord_id FK rejects non-existent landlord UUID', async () => {
    const ctx = await signInAsPm()
    const bogusLandlordId = '00000000-0000-4000-8000-00000000DEAD'

    const { error } = await supabase
      .from('properties')
      .update({ landlord_id: bogusLandlordId })
      .eq('id', ctx.propertyId)
    expect(error).not.toBeNull()
    // PostgREST surfaces FK violation as 23503.
    expect(error?.code).toBe('23503')

    // landlord_id remains NULL (pre-test state).
    const { data: row } = await supabase
      .from('properties').select('landlord_id').eq('id', ctx.propertyId).single()
    expect(row?.landlord_id).toBeNull()
  })
})
