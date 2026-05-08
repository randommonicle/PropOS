-- ============================================================
-- Migration 00017: Storage object-level RLS policies
--
-- CRITICAL security fix: without these, any authenticated user
-- could access any firm's stored files by guessing the path.
--
-- Bucket path convention: {firm_id}/{timestamp}_{filename}
-- Policy logic: (storage.foldername(name))[1] extracts the first
-- path segment (the firm_id) and compares it to the caller's JWT
-- 'firm_id' claim (injected by the custom access token hook).
--
-- Covers three buckets: documents, logos, inspection-reports.
-- ============================================================

-- ── documents bucket ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "documents: firm members select own"   ON storage.objects;
DROP POLICY IF EXISTS "documents: firm members insert own"   ON storage.objects;
DROP POLICY IF EXISTS "documents: firm members delete own"   ON storage.objects;

CREATE POLICY "documents: firm members select own"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'firm_id')
  );

CREATE POLICY "documents: firm members insert own"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'firm_id')
  );

CREATE POLICY "documents: firm members delete own"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'firm_id')
  );

-- ── logos bucket ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "logos: firm members select own"  ON storage.objects;
DROP POLICY IF EXISTS "logos: firm members insert own"  ON storage.objects;
DROP POLICY IF EXISTS "logos: firm members delete own"  ON storage.objects;

CREATE POLICY "logos: firm members select own"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'logos'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'firm_id')
  );

CREATE POLICY "logos: firm members insert own"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'logos'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'firm_id')
  );

CREATE POLICY "logos: firm members delete own"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'logos'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'firm_id')
  );

-- ── inspection-reports bucket ─────────────────────────────────────────────────

DROP POLICY IF EXISTS "inspection-reports: firm members select own"  ON storage.objects;
DROP POLICY IF EXISTS "inspection-reports: firm members insert own"  ON storage.objects;
DROP POLICY IF EXISTS "inspection-reports: firm members delete own"  ON storage.objects;

CREATE POLICY "inspection-reports: firm members select own"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'inspection-reports'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'firm_id')
  );

CREATE POLICY "inspection-reports: firm members insert own"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'inspection-reports'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'firm_id')
  );

CREATE POLICY "inspection-reports: firm members delete own"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'inspection-reports'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'firm_id')
  );
