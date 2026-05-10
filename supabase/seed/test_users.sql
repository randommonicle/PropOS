-- ─────────────────────────────────────────────────────────────────────────────
-- Test users seed — rewritten for the user_roles junction (1i.3 / 00029).
--
-- Originally added in commit 1f.5 (Size S of the demo data work). 1i.3 dropped
-- the legacy users.role TEXT column in favour of a (user_id, role) junction
-- table; this seed now links auth.users into public.users WITHOUT setting
-- role, then INSERTs role rows into public.user_roles.
--
-- Idempotent: re-running is safe. The users INSERT uses ON CONFLICT (id) to
-- refresh full_name + active. The user_roles INSERT uses ON CONFLICT
-- (user_id, role) DO NOTHING to skip existing role grants.
--
-- See DECISIONS 2026-05-10 — Test-user seed pattern + plus-addressing email
-- convention; DECISIONS 2026-05-10 — Forward: 1i.3 (junction table replaces
-- users.role).
--
-- PRE-REQUISITES (do these in Dashboard → Authentication → Users first):
--   1. Add user "pm@propos.local"        password PropOS2026!  (auto-confirm)
--   2. Add user "director@propos.local"  password PropOS2026!  (auto-confirm)
--   3. Add user "accounts@propos.local"  password PropOS2026!  (1i.3, auto-confirm)
--   4. Add user "senior_pm@propos.local" password PropOS2026!  (1i.3, auto-confirm)
--   5. Add user "auditor@propos.local"   password PropOS2026!  (1i.3, auto-confirm)
--
-- Then run this script via Dashboard → SQL Editor. The dashboard "no RLS"
-- false-positive on INSERT scripts (memory) — safe to click "Run without RLS".
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

-- ── Step 1: link auth.users into public.users (without role) ────────────────
WITH demo_firm AS (
  SELECT id FROM firms ORDER BY created_at LIMIT 1
)
INSERT INTO public.users (
  id, firm_id, full_name, email, active, portal_access, created_at, updated_at
)
SELECT
  au.id,
  demo_firm.id,
  CASE au.email
    WHEN 'pm@propos.local'        THEN 'Demo Property Manager'
    WHEN 'director@propos.local'  THEN 'Demo Director'
    WHEN 'accounts@propos.local'  THEN 'Demo Accounts'
    WHEN 'senior_pm@propos.local' THEN 'Demo Senior PM'
    WHEN 'auditor@propos.local'   THEN 'Demo Auditor'
  END,
  au.email,
  true,
  false,
  now(),
  now()
FROM auth.users au, demo_firm
WHERE au.email IN (
  'pm@propos.local', 'director@propos.local',
  'accounts@propos.local', 'senior_pm@propos.local', 'auditor@propos.local'
)
ON CONFLICT (id) DO UPDATE SET
  full_name  = EXCLUDED.full_name,
  active     = true,
  updated_at = now();

-- ── Step 2: assign roles via the junction ───────────────────────────────────
INSERT INTO public.user_roles (user_id, role)
SELECT
  u.id,
  CASE u.email
    WHEN 'pm@propos.local'        THEN 'property_manager'
    WHEN 'director@propos.local'  THEN 'director'
    WHEN 'accounts@propos.local'  THEN 'accounts'
    WHEN 'senior_pm@propos.local' THEN 'senior_pm'
    WHEN 'auditor@propos.local'   THEN 'auditor'
  END
FROM public.users u
WHERE u.email IN (
  'pm@propos.local', 'director@propos.local',
  'accounts@propos.local', 'senior_pm@propos.local', 'auditor@propos.local'
)
ON CONFLICT (user_id, role) DO NOTHING;

-- ── Verify — admin + 5 demo staff/client roles populated ────────────────────
SELECT u.email, u.full_name,
       array_agg(ur.role ORDER BY ur.role) AS roles,
       f.name AS firm_name
FROM public.users u
JOIN firms f ON u.firm_id = f.id
LEFT JOIN public.user_roles ur ON ur.user_id = u.id
WHERE u.email IN (
  'admin@propos.local', 'pm@propos.local', 'director@propos.local',
  'accounts@propos.local', 'senior_pm@propos.local', 'auditor@propos.local'
)
GROUP BY u.email, u.full_name, f.name
ORDER BY u.email;
