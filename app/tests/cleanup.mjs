/**
 * One-off cleanup script — deletes smoke test artifacts from all tables.
 * Run once: node tests/cleanup.mjs
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

const jobs = [
  { table: 'contractors',              col: 'company_name',      prefix: 'Smoke Co %'  },
  { table: 'works_orders',             col: 'description',       prefix: 'Smoke WO %'  },
  { table: 'section20_consultations',  col: 'works_description', prefix: 'Smoke S20 %' },
  { table: 'compliance_items',         col: 'description',       prefix: 'Py2 CI %'    },
  { table: 'properties',               col: 'name',              prefix: 'Smoke Prop %' },
]

for (const { table, col, prefix } of jobs) {
  const { error } = await supabase.from(table).delete().like(col, prefix)
  if (error) console.error(`${table}: ${error.message}`)
  else console.log(`${table}: cleaned ✓`)
}

console.log('Done.')
process.exit(0)
