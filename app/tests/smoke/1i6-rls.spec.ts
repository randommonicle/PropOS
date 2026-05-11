/**
 * @file 1i6-rls.spec.ts
 * @description 1i.6 data-backfill RLS + structural-constraint smokes.
 *
 * Tables / columns covered (migration 00032):
 *   - documents.{include_in_sales_pack,lpe_category,fme_category}  (G5)
 *   - documents.document_type CHECK constraint                      (G5)
 *   - compliance_items.{lpe_relevant,certificate_document_id}       (G6)
 *   - compliance_items.item_type CHECK constraint                   (G6)
 *   - emergency_contacts                                            (G16)
 *   - interested_parties                                            (G17)
 *   - demands.section_153_compliant + enforce_section_153_on_issue  (G19)
 *
 * Smokes (6 active + 2 .fixme'd FORWARD):
 *   1. documents — document_type CHECK rejects invalid enum value (23514).
 *   2. compliance_items — item_type CHECK rejects invalid enum value (23514).
 *   3. emergency_contacts — PM cannot INSERT with foreign firm_id (42501).
 *   4. interested_parties — PM cannot INSERT with foreign firm_id (42501).
 *   5. demands — issuing a demand without section_153_compliant=true rejected
 *      by the enforce_section_153_on_issue trigger (CLRA 2002 s.153 gate; 23514).
 *   6. demands — issuing a demand with section_153_compliant=true succeeds.
 *
 * .fixme'd FORWARD:
 *   7. emergency_contacts — leaseholder own-unit SELECT permitted.
 *      Blocked until a leaseholder fixture user exists (no leaseholder@propos.local
 *      in the 6 current demo users; user_id linkage on leaseholders pre-needed).
 *   8. demands — landlord-exempt path (section_153_required=false) skips the trigger.
 *      Blocked until demo seed populates properties.landlord_id (currently NULL).
 *
 * Patterns mirrored from 1i5-rls.spec.ts:
 *   - PREFIX-scoped row names for safe afterAll sweep.
 *   - FOREIGN_FIRM_ID stable UUID for cross-firm WITH CHECK rejection.
 *   - signInAsPm helper resolves firm_id + property/unit/leaseholder anchors.
 *   - PostgREST surfaces CHECK as '23514', RLS as '42501'.
 */
import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './_env'

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

const PREFIX = 'Smoke 1i6'
const FOREIGN_FIRM_ID = '00000000-0000-4000-8000-000000005EC0'

interface PmContext {
  userId:         string
  firmId:         string
  propertyId:     string
  unitId:         string
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

/**
 * Seed a current leaseholder against the PM's first unit (dev seed has none).
 * Pattern mirrored from financial-demands.spec.ts resolveSeedTriplet. Tagged in
 * `notes` so afterAll can sweep it after demands are removed.
 */
async function seedLeaseholder(ctx: PmContext): Promise<string> {
  const { data: existing } = await supabase
    .from('leaseholders').select('id')
    .eq('unit_id', ctx.unitId).eq('is_current', true)
    .like('notes', `${PREFIX}%`)
    .limit(1).maybeSingle()
  if (existing?.id) return existing.id

  const { data: created, error } = await supabase
    .from('leaseholders')
    .insert({
      firm_id:        ctx.firmId,
      property_id:    ctx.propertyId,
      unit_id:        ctx.unitId,
      full_name:      `${PREFIX} seed leaseholder`,
      is_current:     true,
      is_resident:    false,
      is_company:     false,
      portal_access:  false,
      notes:          `${PREFIX} seed leaseholder for s.153 smokes`,
    })
    .select('id').single()
  if (error || !created) throw new Error(`Failed to seed leaseholder: ${error?.message}`)
  return created.id
}

test.describe('1i.6 — documents/compliance/emergency/interested/s.153 RLS + constraints', () => {
  test.afterAll(async () => {
    await supabase.auth.signInWithPassword({ email: 'admin@propos.local', password: 'PropOS2026!' })

    // FK-safe sweep order: child rows first. Test rows identified by name/notes LIKE.
    await supabase.from('emergency_contacts').delete().like('name', `${PREFIX}%`)
    await supabase.from('interested_parties').delete().like('name', `${PREFIX}%`)
    // demands → leaseholders order matters: demands have leaseholder_id FK.
    await supabase.from('demands').delete().like('notes', `${PREFIX}%`)
    await supabase.from('leaseholders').delete().like('notes', `${PREFIX}%`)
  })

  // ── Smoke 1 — documents.document_type CHECK rejects invalid enum ─────────
  test('documents — document_type CHECK rejects invalid enum value', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('documents')
      .insert({
        firm_id:       ctx.firmId,
        property_id:   ctx.propertyId,
        document_type: 'not_a_real_doc_type',
        filename:      `${PREFIX}_invalid_type.pdf`,
        storage_path:  `${PREFIX}/invalid_type.pdf`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
    expect(data).toBeNull()
  })

  // ── Smoke 2 — compliance_items.item_type CHECK rejects invalid enum ──────
  test('compliance_items — item_type CHECK rejects invalid enum value', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('compliance_items')
      .insert({
        firm_id:     ctx.firmId,
        property_id: ctx.propertyId,
        item_type:   'not_a_real_compliance_type',
        description: `${PREFIX} invalid item_type`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
    expect(data).toBeNull()
  })

  // ── Smoke 3 — emergency_contacts cross-firm INSERT rejected ──────────────
  test('emergency_contacts — PM cannot INSERT with foreign firm_id', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('emergency_contacts')
      .insert({
        firm_id:      FOREIGN_FIRM_ID,
        unit_id:      ctx.unitId,
        property_id:  ctx.propertyId,
        name:         `${PREFIX} foreign-firm contact ${Date.now()}`,
        contact_type: 'key_holder',
        phone:        '+44 0000 000000',
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
    expect(data).toBeNull()
  })

  // ── Smoke 4 — interested_parties cross-firm INSERT rejected ──────────────
  test('interested_parties — PM cannot INSERT with foreign firm_id', async () => {
    const ctx = await signInAsPm()
    const { data, error } = await supabase
      .from('interested_parties')
      .insert({
        firm_id:     FOREIGN_FIRM_ID,
        property_id: ctx.propertyId,
        party_type:  'mortgagee',
        name:        `${PREFIX} foreign-firm mortgagee ${Date.now()}`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')
    expect(data).toBeNull()
  })

  // ── Smoke 5 — demands s.153 trigger rejects 'issued' without compliance ──
  test('demands — issuing without section_153_compliant blocked by trigger (CLRA 2002 s.153)', async () => {
    const ctx = await signInAsPm()
    const leaseholderId = await seedLeaseholder(ctx)
    const { data, error } = await supabase
      .from('demands')
      .insert({
        firm_id:        ctx.firmId,
        property_id:    ctx.propertyId,
        unit_id:        ctx.unitId,
        leaseholder_id: leaseholderId,
        demand_type:    'service_charge',
        amount:         100.00,
        status:         'issued',
        section_153_compliant: false,
        notes:          `${PREFIX} s.153 rejection test`,
      })
      .select('id').single()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
    // Statutory citation pinned in trigger message — UI message + smoke regex move in lockstep.
    expect(error?.message ?? '').toMatch(/CLRA 2002 s\.153/)
    expect(data).toBeNull()
  })

  // ── Smoke 6 — demands with section_153_compliant=true passes trigger ─────
  test('demands — issuing with section_153_compliant=true succeeds', async () => {
    const ctx = await signInAsPm()
    const leaseholderId = await seedLeaseholder(ctx)
    const { data, error } = await supabase
      .from('demands')
      .insert({
        firm_id:        ctx.firmId,
        property_id:    ctx.propertyId,
        unit_id:        ctx.unitId,
        leaseholder_id: leaseholderId,
        demand_type:    'service_charge',
        amount:         100.00,
        status:         'issued',
        section_153_compliant: true,
        notes:          `${PREFIX} s.153 pass test`,
      })
      .select('id, section_153_compliant').single()
    expect(error).toBeNull()
    expect(data?.section_153_compliant).toBe(true)
  })

  // ── Smoke 7 — leaseholder reads own-unit emergency_contacts ──────────────
  // Un-fixme'd in 00033 (demo seed + leaseholder fixture via test_users.sql).
  // The leaseholder@propos.local auth user is linked to the 'Demo Leaseholder
  // Maple House Flat 1' row (is_current=true). The 00033 seed inserts a
  // 'Demo Key Holder for Maple House Flat 1' emergency_contacts row on that
  // same unit, so the RLS policy emergency_contacts_leaseholder_select should
  // permit the SELECT.
  // Anchor: 00032 RLS policy emergency_contacts_leaseholder_select.
  test('emergency_contacts — leaseholder reads own-unit contacts', async () => {
    const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
      email: 'leaseholder@propos.local', password: 'PropOS2026!',
    })
    expect(authErr).toBeNull()
    expect(auth.user).not.toBeNull()

    // Own-unit read: leaseholder is linked to Maple House Flat 1 (per test_users.sql
    // Step 3). The seeded emergency contact for that unit MUST be visible.
    const { data: rows, error: readErr } = await supabase
      .from('emergency_contacts')
      .select('id, name, unit_id, contact_type')
      .like('name', 'Demo Key Holder for Maple House Flat 1')
    expect(readErr).toBeNull()
    expect(rows).not.toBeNull()
    expect((rows ?? []).length).toBeGreaterThanOrEqual(1)
    expect(rows?.[0].contact_type).toBe('key_holder')
  })

  // ── Smoke 8 — landlord-exempt s.153 path ─────────────────────────────────
  // Un-fixme'd in 00033. Cedar Estate's landlord has section_153_required=false
  // (per migration 00033 Section B). A demand against a Cedar Estate unit
  // issued with section_153_compliant=false should succeed (the trigger's
  // v_required branch evaluates false).
  // Anchor: 00032 enforce_section_153_on_issue v_required:=false branch.
  test('demands — landlord-exempt s.153 path (Cedar Estate, section_153_required=false)', async () => {
    const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
      email: 'pm@propos.local', password: 'PropOS2026!',
    })
    if (authErr || !auth.user) throw new Error(`pm sign-in failed: ${authErr?.message}`)

    // Resolve Cedar Estate's property + first unit explicitly (signInAsPm picks
    // the first property in the firm — could be any of Maple/Birchwood/Cedar).
    const { data: cedar } = await supabase
      .from('properties').select('id, firm_id').eq('name', 'Cedar Estate').single()
    if (!cedar) throw new Error('Cedar Estate property not found (00033 seed required)')

    const { data: unit } = await supabase
      .from('units').select('id').eq('property_id', cedar.id).limit(1).single()
    if (!unit) throw new Error('No unit on Cedar Estate')

    const { data: lh } = await supabase
      .from('leaseholders').select('id')
      .eq('unit_id', unit.id).eq('is_current', true)
      .like('full_name', 'Demo Leaseholder Cedar Estate%')
      .limit(1).single()
    if (!lh) throw new Error('No demo leaseholder on Cedar Estate (00033 seed required)')

    // Insert demand status='issued' WITHOUT s.153 compliance — should succeed
    // because Cedar's landlord opts out of the s.153 service requirement.
    const { data, error } = await supabase
      .from('demands')
      .insert({
        firm_id:        cedar.firm_id,
        property_id:    cedar.id,
        unit_id:        unit.id,
        leaseholder_id: lh.id,
        demand_type:    'service_charge',
        amount:         50.00,
        status:         'issued',
        section_153_compliant: false,
        notes:          `${PREFIX} landlord-exempt s.153 pass test`,
      })
      .select('id, section_153_compliant').single()
    expect(error).toBeNull()
    expect(data?.section_153_compliant).toBe(false)
  })
})
