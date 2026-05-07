/**
 * create_buckets.mjs
 * Creates Supabase Storage buckets required for PropOS.
 * Idempotent — safe to run multiple times.
 *
 * Usage: node supabase/seed/create_buckets.mjs
 */
import { createClient } from '@supabase/supabase-js'

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!serviceRoleKey) {
  console.error('ERROR: Set SUPABASE_SERVICE_ROLE_KEY environment variable to your service role key.')
  process.exit(1)
}

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://tmngfuonanizxyffrsjy.supabase.co',
  serviceRoleKey
)

const buckets = [
  { id: 'documents', public: false, fileSizeLimit: 52428800 }, // 50MB max
  { id: 'logos', public: true, fileSizeLimit: 5242880 },       // 5MB max, public for display
  { id: 'inspection-reports', public: false, fileSizeLimit: 52428800 },
]

for (const bucket of buckets) {
  const { error } = await supabase.storage.createBucket(bucket.id, {
    public: bucket.public,
    fileSizeLimit: bucket.fileSizeLimit,
  })
  if (error && error.message.includes('already exists')) {
    console.log(`  EXISTS  ${bucket.id}`)
  } else if (error) {
    console.error(`  FAIL    ${bucket.id}: ${error.message}`)
  } else {
    console.log(`  CREATED ${bucket.id}`)
  }
}

console.log('Bucket setup complete.')
