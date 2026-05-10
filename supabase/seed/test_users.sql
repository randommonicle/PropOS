-- ─────────────────────────────────────────────────────────────────────────────
-- Test users seed — Phase 3 commit 1f.5 (Size S of the demo data work).
--
-- Links auth.users entries (pre-created via Supabase Dashboard) into
-- public.users with the right firm_id and roles. Idempotent: re-running is
-- safe, the ON CONFLICT clause refreshes role + full_name without creating
-- duplicate rows.
--
-- See DECISIONS 2026-05-10 — Test-user seed pattern + plus-addressing
-- email convention.
--
-- PRE-REQUISITES (do these in Dashboard → Authentication → Users first):
--   1. Add user "pm@propos.local"       password PropOS2026!  (auto-confirm)
--   2. Add user "director@propos.local" password PropOS2026!  (auto-confirm)
--
-- Then run this script via Dashboard → SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- Sanity check: exactly one firm should exist in this dev project. If your
-- project has multiple firms (because a prior seed ran in a multi-tenant
-- mode), edit the WHERE clause below to pin the demo firm explicitly.
DO $$
DECLARE
  firm_count INT;
BEGIN
  SELECT COUNT(*) INTO firm_count FROM firms;
  IF firm_count = 0 THEN
    RAISE EXCEPTION 'No firm found. Run the demo seed first (supabase/seed/demo_seed.mjs).';
  END IF;
  IF firm_count > 1 THEN
    RAISE WARNING 'Multiple firms present (%) — this script will use the first by id. Edit the script if you need a specific firm.', firm_count;
  END IF;
END $$;

-- Insert / refresh the test users.
WITH demo_firm AS (
  SELECT id FROM firms ORDER BY created_at LIMIT 1
)
INSERT INTO public.users (
  id, firm_id, full_name, email, role, active, portal_access, created_at, updated_at
)
SELECT
  au.id,
  demo_firm.id,
  CASE au.email
    WHEN 'pm@propos.local'       THEN 'Demo Property Manager'
    WHEN 'director@propos.local' THEN 'Demo Director'
  END,
  au.email,
  CASE au.email
    WHEN 'pm@propos.local'       THEN 'property_manager'
    WHEN 'director@propos.local' THEN 'director'
  END,
  true,
  false,
  now(),
  now()
FROM auth.users au, demo_firm
WHERE au.email IN ('pm@propos.local', 'director@propos.local')
ON CONFLICT (id) DO UPDATE SET
  role      = EXCLUDED.role,
  full_name = EXCLUDED.full_name,
  active    = true,
  updated_at = now();

-- Verify — should show three rows: admin, director, property_manager.
SELECT u.email, u.full_name, u.role, f.name AS firm_name
FROM public.users u
JOIN firms f ON u.firm_id = f.id
WHERE u.email IN ('admin@propos.local', 'pm@propos.local', 'director@propos.local')
ORDER BY
  CASE u.role
    WHEN 'admin' THEN 1
    WHEN 'director' THEN 2
    WHEN 'property_manager' THEN 3
    ELSE 4
  END;
