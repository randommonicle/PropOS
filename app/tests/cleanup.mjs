/**
 * One-off cleanup script — deletes ALL smoke test artifacts from the database.
 * Run once: node tests/cleanup.mjs
 *
 * Deletion order matters: child rows first (FK constraints).
 *   leaseholders → units → properties (and contractors, works, s20, compliance)
 */
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://tmngfuonanizxyffrsjy.supabase.co',
  'sb_publishable_M_cBRZKdJtIunGAUFBhD1g_SYMADNyT',
)

await supabase.auth.signInWithPassword({
  email: 'admin@propos.local',
  password: 'PropOS2026!',
})

async function del(table, col, prefix) {
  const { error } = await supabase.from(table).delete().like(col, prefix)
  if (error) console.error(`  ✗ ${table} (${prefix}): ${error.message}`)
  else console.log(`  ✓ ${table} (${prefix})`)
}

console.log('── Step 1: leaseholders by name ──')
await del('leaseholders', 'full_name', 'Smoke LH %')
await del('leaseholders', 'full_name', 'LH Edit%')
await del('leaseholders', 'full_name', 'LHPerson%')

// Some old test runs may have left leaseholders with non-smoke names attached
// to smoke units — find those unit IDs and delete their leaseholders explicitly.
console.log('── Step 2: leaseholders attached to smoke units (stragglers) ──')
const { data: smokeUnits } = await supabase
  .from('units')
  .select('id')
  .like('unit_ref', 'Smoke LH%')

if (smokeUnits?.length) {
  const ids = smokeUnits.map(u => u.id)
  const { error } = await supabase.from('leaseholders').delete().in('unit_id', ids)
  if (error) console.error(`  ✗ straggler leaseholders: ${error.message}`)
  else console.log(`  ✓ straggler leaseholders on ${ids.length} unit(s)`)
} else {
  console.log('  ✓ no straggler leaseholders')
}

console.log('── Step 3: units ──')
await del('units', 'unit_ref', 'Smoke U%')
await del('units', 'unit_ref', 'Smoke LH%')
await del('units', 'unit_ref', 'SmokeUnit%')

console.log('── Step 4: properties ──')
await del('properties', 'name', 'Smoke Test Block %')
await del('properties', 'name', 'Smoke Prop %')

console.log('── Step 5: contractors / works / compliance ──')
await del('contractors',             'company_name',      'Smoke Co %')
await del('works_orders',            'description',       'Smoke WO %')
await del('section20_consultations', 'works_description', 'Smoke S20 %')
await del('compliance_items',        'description',       'Py2 CI %')

console.log('\nDone.')
process.exit(0)
