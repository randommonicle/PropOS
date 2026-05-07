/**
 * Migration runner for PropOS.
 * Connects directly to the Supabase Postgres instance and runs all migration files
 * in numbered order. Idempotent — tracks applied migrations in a _migrations table.
 *
 * Usage: node supabase/run_migrations.mjs
 */
import { readdir, readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const { Client } = pg
const __dirname = dirname(fileURLToPath(import.meta.url))

// Supabase direct connection — uses the postgres superuser role which has extension rights
// Set DB_URL in your environment: postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
const DB_URL = process.env.DB_URL
if (!DB_URL) {
  console.error('ERROR: Set DB_URL environment variable.')
  console.error('Example: DB_URL="postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres" node supabase/run_migrations.mjs')
  process.exit(1)
}

async function run() {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  console.log('Connected to Supabase Postgres')

  // Create migrations tracking table if it doesn't exist
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)

  const migrationsDir = join(__dirname, 'migrations')
  const files = (await readdir(migrationsDir))
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const { rows } = await client.query('SELECT 1 FROM _migrations WHERE filename = $1', [file])
    if (rows.length > 0) {
      console.log(`  SKIP  ${file} (already applied)`)
      continue
    }

    console.log(`  RUN   ${file}`)
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file])
      await client.query('COMMIT')
      console.log(`  OK    ${file}`)
    } catch (err) {
      await client.query('ROLLBACK')
      console.error(`  FAIL  ${file}: ${err.message}`)
      await client.end()
      process.exit(1)
    }
  }

  await client.end()
  console.log('All migrations complete.')
}

run().catch(err => {
  console.error('Migration runner error:', err)
  process.exit(1)
})
