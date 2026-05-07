/**
 * demo_seed.mjs
 * Seeds a demo firm and admin user for PoC demonstration.
 * Creates: 1 firm, 1 admin user, 3 sample properties with units.
 *
 * Prerequisites: The Supabase Auth user must exist before running this.
 * Run: ADMIN_EMAIL=you@example.com ADMIN_USER_ID=<uuid> node supabase/seed/demo_seed.mjs
 */
import pg from 'pg'

const { Client } = pg
const DB_URL = process.env.DB_URL
if (!DB_URL) {
  console.error('ERROR: Set DB_URL environment variable.')
  process.exit(1)
}

const ADMIN_USER_ID = process.env.ADMIN_USER_ID
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@demo-firm.co.uk'
const ADMIN_NAME = process.env.ADMIN_NAME || 'Demo Admin'

if (!ADMIN_USER_ID) {
  console.error('ERROR: Set ADMIN_USER_ID to the UUID of the Supabase auth user.')
  console.error('Get it from: Supabase Dashboard > Authentication > Users')
  process.exit(1)
}

const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
await client.connect()

// Idempotent seed — check if demo firm already exists
const existing = await client.query("SELECT id FROM firms WHERE slug = 'demo-firm' LIMIT 1")
let firmId

if (existing.rows.length > 0) {
  firmId = existing.rows[0].id
  console.log(`Demo firm already exists: ${firmId}`)
} else {
  const { rows } = await client.query(`
    INSERT INTO firms (name, slug, subscription_tier, rics_regulated, deployment_mode)
    VALUES ('Demo Property Management Ltd', 'demo-firm', 'pro', true, 'saas')
    RETURNING id
  `)
  firmId = rows[0].id
  console.log(`Created firm: ${firmId}`)
}

// Create the admin user row (the auth user must already exist)
await client.query(`
  INSERT INTO users (id, firm_id, full_name, email, role, active)
  VALUES ($1, $2, $3, $4, 'admin', true)
  ON CONFLICT (id) DO UPDATE SET firm_id = $2, role = 'admin'
`, [ADMIN_USER_ID, firmId, ADMIN_NAME, ADMIN_EMAIL])
console.log('Admin user row created/updated')

// Create portal config for the firm
await client.query(`
  INSERT INTO firm_portal_config (firm_id, out_of_hours_phone, show_999_prompt)
  VALUES ($1, '07700 900000', true)
  ON CONFLICT (firm_id) DO NOTHING
`, [firmId])

// Sample properties
const properties = [
  {
    name: 'Maple House',
    address_line1: '12 Elm Street',
    town: 'London',
    postcode: 'EC1A 1BB',
    property_type: 'block',
    total_units: 8,
    is_hrb: false,
  },
  {
    name: 'Birchwood Court',
    address_line1: '45 Oak Avenue',
    town: 'Manchester',
    postcode: 'M1 2CD',
    property_type: 'block',
    total_units: 24,
    is_hrb: true,
    storey_count: 12,
    height_metres: 38.5,
  },
  {
    name: 'Cedar Estate',
    address_line1: 'Cedar Drive',
    town: 'Bristol',
    postcode: 'BS1 3EF',
    property_type: 'estate',
    total_units: 16,
    is_hrb: false,
  },
]

for (const prop of properties) {
  const existing = await client.query(
    'SELECT id FROM properties WHERE firm_id = $1 AND name = $2 LIMIT 1',
    [firmId, prop.name]
  )
  if (existing.rows.length > 0) {
    console.log(`Property already exists: ${prop.name}`)
    continue
  }

  const { rows } = await client.query(`
    INSERT INTO properties (firm_id, name, address_line1, town, postcode, property_type,
      total_units, is_hrb, storey_count, height_metres, managing_since)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '2020-01-01')
    RETURNING id
  `, [
    firmId, prop.name, prop.address_line1, prop.town, prop.postcode, prop.property_type,
    prop.total_units ?? null, prop.is_hrb ?? false,
    prop.storey_count ?? null, prop.height_metres ?? null,
  ])
  const propertyId = rows[0].id

  // Add sample units
  const unitCount = Math.min(prop.total_units ?? 3, 3)
  for (let i = 1; i <= unitCount; i++) {
    await client.query(`
      INSERT INTO units (firm_id, property_id, unit_ref, unit_type, floor, lease_term_years)
      VALUES ($1, $2, $3, 'flat', $4, 125)
    `, [firmId, propertyId, `Flat ${i}`, i - 1])
  }

  console.log(`Created property: ${prop.name} (${unitCount} units)`)
}

await client.end()
console.log('\nDemo seed complete. Log into PropOS with your admin credentials.')
console.log('Note: set the firm_id JWT claim in Supabase auth hooks for RLS to work.')
