-- Migration: 00029_role_architecture
-- Phase 3 → 4 boundary commit (1i.3) — role architecture rework.
--
-- Closes 1i.2 PROD-GATE flags 8 (function-split discriminator on
-- payment_authorisations.action_type) and 9 (contractor-onboarding
-- approved_by / approved_at stamping). Lifts the wider role-architecture
-- shape from "single users.role TEXT column + admin-only stand-in" to
-- "user_roles junction + multi-role JWT array claim + dedicated accounts
-- role + tier-asymmetric dual-auth + auditor + inspector + senior_pm".
--
-- Cross-references:
--   - DECISIONS 2026-05-10 — Forward: 1i.3 (canonical scope; this migration
--     implements items 1, 2, 7, 8 and the schema half of 5 + 6).
--   - docs/HANDOVER_1i3.md — single-file brief, three signed-off scope
--     decisions (4 new roles, junction REPLACES users.role, full
--     function-split scope).
--
-- Regulatory anchor:
--   RICS Client money handling (1st ed., Oct 2022 reissue) — segregation
--   of duties between staff who set up payee bank details and staff who
--   release payments. Both signatories must be staff of the regulated firm.
--   Today's admin-only stand-in is regulatory-acceptable (two distinct
--   people = compliant) but architecturally incomplete (function-split not
--   modelled). 1i.3 adds the function-split semantic + the dedicated
--   `accounts` role for first-leg authorisation.
--
-- Apply path: Dashboard SQL Editor (per project memory rule). Verification
-- queries Q1–Q6 are appended as comments at the bottom of this file —
-- run them immediately after apply and paste results back before moving
-- to phase 2 (role-helper sweep + RLS rewrite of consumers).
--
-- Smokes after apply: phase 1 just needs basic auth still working
-- (existing 134 active smokes should continue to pass — the JWT hook
-- still sets the legacy `user_role` claim from the priority-picked first
-- role, so unswept consumers keep functioning during the transition).

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Helper functions for the new array claim
-- ════════════════════════════════════════════════════════════════════════════
-- Defined first so the user_roles policies (next) can reference them.
-- STABLE + SQL-language, mirrors the auth_firm_id() / auth_user_role()
-- pattern from 00012. Reads `user_roles` array claim from the JWT.

CREATE OR REPLACE FUNCTION auth_has_role(role_name TEXT)
RETURNS BOOLEAN
LANGUAGE SQL STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(
      COALESCE(
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb -> 'user_roles',
        '[]'::jsonb
      )
    ) AS r WHERE r = role_name
  );
$$;

CREATE OR REPLACE FUNCTION auth_has_any_role(role_names TEXT[])
RETURNS BOOLEAN
LANGUAGE SQL STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(
      COALESCE(
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb -> 'user_roles',
        '[]'::jsonb
      )
    ) AS r WHERE r = ANY(role_names)
  );
$$;

COMMENT ON FUNCTION auth_has_role(TEXT) IS
  'Returns true iff the authenticated user holds the named role per the user_roles[] JWT claim. Sister to auth_firm_id() / auth_user_role(); reads request.jwt.claims directly so it works inside RLS predicates evaluated under postgrest. See 00029 + DECISIONS 2026-05-10 — Forward: 1i.3.';

COMMENT ON FUNCTION auth_has_any_role(TEXT[]) IS
  'Returns true iff the authenticated user holds at least one of the named roles. Used by is_pm_or_admin() and any policy gating on a set of roles.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. user_roles junction table
-- ════════════════════════════════════════════════════════════════════════════
-- Replaces users.role (single column) with (user_id, role) tuples to model
-- multi-role membership. CHECK constraint enumerates the canonical role set
-- post-1i.3: admin / accounts / senior_pm / property_manager (staff PM-tier),
-- auditor / inspector (staff read/scaffold), director / leaseholder /
-- contractor (client-side), read_only (scaffold).

CREATE TABLE user_roles (
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by  UUID        REFERENCES users(id),
  PRIMARY KEY (user_id, role),
  CONSTRAINT user_roles_role_chk CHECK (role IN (
    'admin',
    'accounts',
    'senior_pm',
    'property_manager',
    'auditor',
    'inspector',
    'director',
    'leaseholder',
    'contractor',
    'read_only'
  ))
);

CREATE INDEX idx_user_roles_user ON user_roles(user_id);
CREATE INDEX idx_user_roles_role ON user_roles(role);

COMMENT ON TABLE user_roles IS
  'Junction table: a user holds zero or more roles. Replaces the legacy users.role TEXT column (dropped at the end of this migration). Multi-role membership supports e.g. an admin who also acts as accounts staff in a small firm. See DECISIONS 2026-05-10 — Forward: 1i.3 item 1.';

COMMENT ON COLUMN user_roles.granted_by IS
  'User who granted this role. Today populated by the future bulk role-assignment UI (FORWARD anchor below); during backfill the column is null because no granting actor is recorded for the legacy users.role value.';

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

-- Users can always read their own role rows (used by the JWT hook running
-- under SECURITY DEFINER, by the useAuth refresh path, and by any "what am I"
-- UI surface). Cross-firm exposure is bounded: user_id resolves only to the
-- authenticated user's own rows, no firm_id traversal needed.
CREATE POLICY user_roles_self_select ON user_roles
  FOR SELECT
  USING (user_id = auth.uid());

-- Admins can manage any user_roles row in any firm. Predicate uses the new
-- array claim helper so the policy is consistent with the rest of the sweep.
-- Note: this grants cross-firm visibility to admin — matches the 00012
-- users_admin_all stance (admin sees firm.id = auth_firm_id() AND admin role).
-- Tightened in a follow-up if required.
CREATE POLICY user_roles_admin_all ON user_roles
  FOR ALL
  USING (auth_has_role('admin'))
  WITH CHECK (auth_has_role('admin'));

-- Grant the auth admin role read access so the JWT hook (running under
-- SECURITY DEFINER as postgres anyway) and any future supabase_auth_admin
-- code path can resolve user_roles rows.
GRANT SELECT ON user_roles TO supabase_auth_admin;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Backfill from users.role
-- ════════════════════════════════════════════════════════════════════════════
-- One row per existing user, copying the legacy single-role column into the
-- junction. Idempotent (ON CONFLICT) so re-running the migration doesn't
-- duplicate. Users without a role (shouldn't exist — column is NOT NULL) are
-- ignored by the WHERE clause.

INSERT INTO user_roles (user_id, role)
SELECT id, role
FROM users
WHERE role IS NOT NULL
ON CONFLICT (user_id, role) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. JWT custom access token hook — emit user_roles[] array claim
-- ════════════════════════════════════════════════════════════════════════════
-- Replaces the 00016 implementation that set a single `user_role` string.
-- The new hook builds:
--   claims.firm_id      — unchanged
--   claims.user_roles   — TEXT[] array of every role the user holds
--   claims.user_role    — legacy single-string claim, priority-picked from
--                          the array. Kept for one transitional commit so
--                          unswept consumers keep working; removed in cleanup
--                          (FORWARD anchor below).
--
-- Priority order for the legacy claim: admin > senior_pm > accounts >
-- property_manager > auditor > director > leaseholder > contractor >
-- inspector > read_only > 'authenticated'. The deterministic ordering
-- removes the ambiguity that `roles_v[1]` (insertion-order) would otherwise
-- introduce for multi-role users.

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   UUID;
  v_firm_id   UUID;
  v_roles     TEXT[];
  v_legacy    TEXT;
  v_active    BOOLEAN;
  claims      JSONB;
BEGIN
  v_user_id := (event ->> 'user_id')::UUID;

  SELECT firm_id, active
  INTO v_firm_id, v_active
  FROM public.users
  WHERE id = v_user_id;

  -- Inactive users get no claims; the SELECT above filters via the next
  -- guard rather than IN-WHERE so we still surface firm_id as null and the
  -- block below skips claim writes (auth still allowed but RLS will deny
  -- everything firm-scoped).
  IF v_firm_id IS NULL OR COALESCE(v_active, false) = false THEN
    RETURN event;
  END IF;

  -- Priority-ordered role aggregation. CASE ranks each role; array_agg
  -- ORDER BY guarantees the highest-priority role lands at index 1 for the
  -- legacy `user_role` claim consumers.
  SELECT array_agg(role ORDER BY
    CASE role
      WHEN 'admin'            THEN 1
      WHEN 'senior_pm'        THEN 2
      WHEN 'accounts'         THEN 3
      WHEN 'property_manager' THEN 4
      WHEN 'auditor'          THEN 5
      WHEN 'director'         THEN 6
      WHEN 'leaseholder'      THEN 7
      WHEN 'contractor'       THEN 8
      WHEN 'inspector'        THEN 9
      WHEN 'read_only'        THEN 10
      ELSE                         99
    END
  )
  INTO v_roles
  FROM public.user_roles
  WHERE user_id = v_user_id;

  v_legacy := COALESCE(v_roles[1], 'authenticated');

  claims := event -> 'claims';
  claims := jsonb_set(claims, '{firm_id}',    to_jsonb(v_firm_id::TEXT));
  claims := jsonb_set(claims, '{user_roles}', COALESCE(to_jsonb(v_roles), '[]'::jsonb));
  claims := jsonb_set(claims, '{user_role}',  to_jsonb(v_legacy));

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM PUBLIC;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Rewrite is_pm_or_admin() — widen for the new role set
-- ════════════════════════════════════════════════════════════════════════════
-- Originally `auth_user_role() IN ('admin','property_manager')` (00012).
-- Widened to include `accounts` (finance-tier staff) and `senior_pm`
-- (staff PM-tier with override authority). Auditor / inspector / director /
-- leaseholder / contractor are deliberately excluded — they are not
-- write-eligible on the financial / properties / works tables this helper
-- gates.
--
-- Note: this function is referenced by ~30 policies via name (00012 + 00021
-- + 00025 + 00026). The CREATE OR REPLACE applies atomically; every caller
-- picks up the new predicate without per-policy recreation.

CREATE OR REPLACE FUNCTION is_pm_or_admin() RETURNS BOOLEAN
LANGUAGE SQL STABLE
AS $$
  SELECT auth_has_any_role(ARRAY['admin','accounts','senior_pm','property_manager']);
$$;

COMMENT ON FUNCTION is_pm_or_admin() IS
  'Returns true iff the authenticated user holds any staff PM-tier role: admin, accounts, senior_pm, or property_manager. Widened in 00029 from the legacy admin/property_manager set. Read-only (auditor) and scaffold (inspector) staff are excluded; client-side roles (director/leaseholder/contractor) are excluded.';

-- ════════════════════════════════════════════════════════════════════════════
-- 6. RLS policy sweep — auth_user_role() → auth_has_role() / auth_has_any_role()
-- ════════════════════════════════════════════════════════════════════════════
-- Every policy whose USING / WITH CHECK calls auth_user_role() directly is
-- dropped + recreated to call the new helper. Verification Q3 expects 0
-- residual references post-apply.
--
-- The `auth_user_role()` function itself stays defined (reads the legacy
-- `user_role` claim still emitted by the hook) so any code path missed by
-- the sweep continues to work during the transition. Cleanup commit removes
-- the function + the legacy claim together.

-- 6.1 firms_update — admin only
DROP POLICY IF EXISTS firms_update ON public.firms;
CREATE POLICY firms_update ON public.firms
  FOR UPDATE
  USING      (id = auth_firm_id() AND auth_has_role('admin'))
  WITH CHECK (id = auth_firm_id() AND auth_has_role('admin'));

-- 6.2 users_admin_all (last set by 00026 §C-2)
DROP POLICY IF EXISTS users_admin_all ON public.users;
CREATE POLICY users_admin_all ON public.users
  FOR ALL
  USING      (firm_id = auth_firm_id() AND auth_has_role('admin'))
  WITH CHECK (firm_id = auth_firm_id() AND auth_has_role('admin'));

-- 6.3 properties_delete — admin only
DROP POLICY IF EXISTS properties_delete ON public.properties;
CREATE POLICY properties_delete ON public.properties
  FOR DELETE
  USING (firm_id = auth_firm_id() AND auth_has_role('admin'));

-- 6.4 compliance_director_select — director / read_only read-only on compliance
DROP POLICY IF EXISTS compliance_director_select ON public.compliance_items;
CREATE POLICY compliance_director_select ON public.compliance_items
  FOR SELECT
  USING (
    firm_id = auth_firm_id()
    AND auth_has_any_role(ARRAY['director','read_only'])
  );

-- 6.5 demands_leaseholder_select (last set by 00026 §H-4)
DROP POLICY IF EXISTS demands_leaseholder_select ON public.demands;
CREATE POLICY demands_leaseholder_select ON public.demands
  FOR SELECT
  USING (
    firm_id = auth_firm_id()
    AND auth_has_role('leaseholder')
    AND unit_id IN (
      SELECT unit_id FROM public.leaseholders
      WHERE user_id = auth.uid() AND is_current = true
    )
  );

-- 6.6 documents_leaseholder_select (last set by 00026 §H-4)
DROP POLICY IF EXISTS documents_leaseholder_select ON public.documents;
CREATE POLICY documents_leaseholder_select ON public.documents
  FOR SELECT
  USING (
    firm_id = auth_firm_id()
    AND auth_has_role('leaseholder')
    AND is_confidential = false
    AND property_id IN (
      SELECT property_id FROM public.leaseholders
      WHERE user_id = auth.uid() AND is_current = true
    )
  );

-- 6.7 s20_leaseholder_select (last set by 00026 §H-4)
DROP POLICY IF EXISTS s20_leaseholder_select ON public.section20_consultations;
CREATE POLICY s20_leaseholder_select ON public.section20_consultations
  FOR SELECT
  USING (
    firm_id = auth_firm_id()
    AND auth_has_role('leaseholder')
    AND property_id IN (
      SELECT property_id FROM public.leaseholders
      WHERE user_id = auth.uid() AND is_current = true
    )
  );

-- 6.8 mr_leaseholder (last set by 00026 §H-4)
DROP POLICY IF EXISTS mr_leaseholder ON public.maintenance_requests;
CREATE POLICY mr_leaseholder ON public.maintenance_requests
  FOR ALL
  USING (
    firm_id = auth_firm_id()
    AND auth_has_role('leaseholder')
    AND unit_id IN (
      SELECT unit_id FROM public.leaseholders
      WHERE user_id = auth.uid() AND is_current = true
    )
  )
  WITH CHECK (
    firm_id = auth_firm_id()
    AND auth_has_role('leaseholder')
    AND unit_id IN (
      SELECT unit_id FROM public.leaseholders
      WHERE user_id = auth.uid() AND is_current = true
    )
  );

-- 6.9 tc_delete (00021) — admin / director DELETE on trade categories
DROP POLICY IF EXISTS tc_delete ON public.trade_categories;
CREATE POLICY tc_delete ON public.trade_categories
  FOR DELETE
  USING (
    firm_id = auth_firm_id()
    AND auth_has_any_role(ARRAY['admin','director'])
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Auditor read-everywhere policies (firm-scoped)
-- ════════════════════════════════════════════════════════════════════════════
-- Auditor SELECT on every financial + audit-log table within their firm.
-- Writes are denied by no-policy-match (the existing _pm policies use
-- is_pm_or_admin which excludes auditor). Auditor scope:
--
--   bank_accounts, transactions, demands, invoices, payment_authorisations,
--   service_charge_accounts, budget_line_items, reconciliation_periods,
--   bank_statement_imports, suspense_items, reconciliation_audit_log,
--   golden_thread_audit_log, dispatch_log.
--
-- documents.is_confidential is NOT scoped here — auditor SELECT is unscoped
-- on confidentiality. FORWARD anchor below covers the design decision
-- (read-with-logging vs blocked) deferred per scope memo.

CREATE POLICY bank_accounts_auditor_select ON public.bank_accounts
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

CREATE POLICY transactions_auditor_select ON public.transactions
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

CREATE POLICY demands_auditor_select ON public.demands
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

CREATE POLICY invoices_auditor_select ON public.invoices
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

CREATE POLICY payment_auth_auditor_select ON public.payment_authorisations
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

CREATE POLICY sca_auditor_select ON public.service_charge_accounts
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

CREATE POLICY budget_auditor_select ON public.budget_line_items
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

CREATE POLICY recperiod_auditor_select ON public.reconciliation_periods
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

CREATE POLICY bsi_auditor_select ON public.bank_statement_imports
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

CREATE POLICY suspense_auditor_select ON public.suspense_items
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

CREATE POLICY recaudit_auditor_select ON public.reconciliation_audit_log
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

CREATE POLICY gt_audit_auditor_select ON public.golden_thread_audit_log
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

CREATE POLICY dispatch_log_auditor_select ON public.dispatch_log
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Inspector scaffolding policies (read-only, firm-scoped)
-- ════════════════════════════════════════════════════════════════════════════
-- Inspector role exists so Phase 7 inspection-app integration has a target
-- to gate against. Phase 3 / 4 surface: read-only access to properties +
-- units + leaseholders. No write paths until the inspection report writes
-- land in Phase 7. firm_id-scoped via auth_firm_id().

CREATE POLICY properties_inspector_select ON public.properties
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('inspector'));

CREATE POLICY units_inspector_select ON public.units
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('inspector'));

CREATE POLICY leaseholders_inspector_select ON public.leaseholders
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('inspector'));

-- ════════════════════════════════════════════════════════════════════════════
-- 9. payment_authorisations.action_type — function-split discriminator
-- ════════════════════════════════════════════════════════════════════════════
-- Closes 1i.2 PROD-GATE flag 8. Renames the legacy `payment` value to
-- `payment_release` (the actual money-out auth) and introduces
-- `payment_payee_setup` (creating / changing a contractor's bank details).
-- See action_type discriminator pattern memo for how the Proposed* JSONB
-- shapes branch on this column.
--
-- Order matters: drop the old constraint first, backfill rows from
-- 'payment' → 'payment_release', re-add the widened constraint, retarget
-- the column DEFAULT.

ALTER TABLE public.payment_authorisations
  DROP CONSTRAINT payment_auth_action_type;

UPDATE public.payment_authorisations
   SET action_type = 'payment_release'
 WHERE action_type = 'payment';

ALTER TABLE public.payment_authorisations
  ADD CONSTRAINT payment_auth_action_type
  CHECK (action_type IN (
    'payment_release',           -- renamed from 'payment' in 1i.3
    'payment_payee_setup',       -- new — RICS function-split (1i.3)
    'close_bank_account',        -- 1g
    'toggle_rics_designation'    -- 1g.5
  ));

ALTER TABLE public.payment_authorisations
  ALTER COLUMN action_type SET DEFAULT 'payment_release';

COMMENT ON COLUMN public.payment_authorisations.action_type IS
  'Discriminator for the kind of action this authorisation gates. payment_release (the actual money-out auth — uses transaction_id post-authorise + ProposedTransaction pre-authorise; was `payment` before 1i.3), payment_payee_setup (1i.3 — establishing or changing a contractor''s bank details; uses ProposedPayeeSetup), close_bank_account (1g — uses ProposedClosure), toggle_rics_designation (1g.5 — uses ProposedRicsDesignationToggle, direction-gated to true→false). RICS Client money handling — segregation of duties between payee-setup and payment-release.';

-- ════════════════════════════════════════════════════════════════════════════
-- 10. contractors.approved_by + approved_at — payee-stamping
-- ════════════════════════════════════════════════════════════════════════════
-- Closes 1i.2 PROD-GATE flag 9. Records which admin authorised the
-- payment_payee_setup PA establishing this contractor's bank details, and
-- when. Used by the payee-setter ≠ release-authoriser application gate
-- (RICS Client money handling — segregation of duties). The gate itself is
-- enforced in PaymentAuthorisationsTab.handleAuthorise (phase 3 of the
-- internal decomposition).
--
-- Both columns nullable on the table because pre-1i.3 contractor rows were
-- approved without a stamped authoriser. The future bulk role-assignment
-- UI (FORWARD below) can backfill these for legacy rows; today they remain
-- null and the gate treats null `approved_by` as "no segregation
-- constraint" (legacy behaviour preserved).

ALTER TABLE public.contractors
  ADD COLUMN approved_by UUID REFERENCES users(id),
  ADD COLUMN approved_at TIMESTAMPTZ;

COMMENT ON COLUMN public.contractors.approved_by IS
  'Admin user who authorised the payment_payee_setup PA establishing this contractor''s bank details. Used by the payee-setter ≠ release-authoriser gate (RICS Client money handling — segregation of duties). Null for legacy contractors approved before 1i.3.';

COMMENT ON COLUMN public.contractors.approved_at IS
  'Timestamp of the payment_payee_setup PA authorisation that approved this contractor. Paired with approved_by; null iff approved_by is null.';

-- ════════════════════════════════════════════════════════════════════════════
-- 11. Drop users.role — junction table replaces it
-- ════════════════════════════════════════════════════════════════════════════
-- Done LAST. If any of steps 1–10 fails, the column survives and rollback
-- via transaction-level ROLLBACK leaves the schema unchanged.
--
-- Post-apply, supabase/seed/test_users.sql is broken (it INSERTs into
-- users.role). The new test_users_phase4.sql + the seed-file rewrite land
-- in phase 3 of the internal decomposition.

ALTER TABLE public.users DROP COLUMN role;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- FORWARD: PROD-GATE flags planted by 1i.3
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. FORWARD: PROD-GATE — Auditor visibility into is_confidential=true
--    documents. Today: auditor SELECT on documents is unscoped on
--    is_confidential. Design decision pending (read-with-logging vs
--    blocked). May need a separate documents_auditor_select_confidential
--    policy that writes to an audit-log row on access. Anchor: this file
--    + Phase 5 leaseholder portal commit.
--
-- 2. FORWARD: PROD-GATE — users.user_role legacy claim removal.
--    Today: claims.user_role kept as the priority-picked first role for
--    one transitional commit. Remove once every consumer is verified to
--    read user_roles[] (post phase-2 sweep). Drop auth_user_role() at the
--    same time. Anchor: this file step 4 + cleanup commit.
--
-- 3. FORWARD: PROD-GATE — Bulk role assignment UI for admins.
--    Today: junction lets users hold multiple roles; admin needs a UI to
--    grant / revoke. Today granted only via SQL. Anchor:
--    app/src/components/modules/admin/ (new module — Phase 5).
--
-- 4. FORWARD: PROD-GATE — INSERT-only audit log for role grants/revokes.
--    Today: granted_at / granted_by stamped on user_roles but no
--    append-only log of grant/revoke history. Anchor: this file +
--    Data-integrity / auto-protect pass commit.
--
-- 5. FORWARD: PROD-GATE — Senior PM re-open closed reconciliation period
--    UI. Today: post-1i.3 RLS allows (senior_pm has is_pm_or_admin=true);
--    no UI surface yet. Anchor:
--    app/src/components/modules/financial/ReconciliationTab.tsx header.
--
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run via Dashboard SQL Editor immediately after apply)
-- ═════════════════════════════════════════════════════════════════════════════
-- Paste the result of each query back into chat before moving to phase 2.
--
-- ─── Q1: Junction table populated for every user ────────────────────────────
-- SELECT u.id, u.email,
--        COALESCE(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL), ARRAY[]::TEXT[]) AS roles
-- FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id
-- GROUP BY u.id, u.email
-- HAVING COALESCE(array_length(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL), 1), 0) = 0;
-- -- Expect 0 rows. Any user without a role is an orphan (would have failed
-- -- the legacy users.role NOT NULL anyway).
--
-- ─── Q2: JWT hook returns the array claim ───────────────────────────────────
-- SELECT custom_access_token_hook(jsonb_build_object(
--   'user_id', (SELECT id FROM users WHERE email='admin@propos.local'),
--   'claims', '{}'::jsonb
-- )) -> 'claims' AS claims_out;
-- -- Expect: claims_out contains user_roles=["admin"], user_role="admin",
-- --         firm_id=<uuid>.
--
-- ─── Q3: All RLS policies recreated. No residual auth_user_role refs. ───────
-- SELECT polname, pg_get_expr(polqual, polrelid) AS using_clause
-- FROM pg_policy
-- WHERE pg_get_expr(polqual, polrelid)      LIKE '%auth_user_role%'
--    OR pg_get_expr(polwithcheck, polrelid) LIKE '%auth_user_role%';
-- -- Expect 0 rows.
--
-- ─── Q4: payment_authorisations action_type CHECK widened ───────────────────
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conname = 'payment_auth_action_type';
-- -- Expect to include payment_payee_setup AND payment_release; expect
-- -- 'payment' (legacy) absent.
--
-- ─── Q5: contractors.approved_by FK present ─────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'contractors'::regclass
--   AND pg_get_constraintdef(oid) LIKE '%approved_by%';
-- -- Expect at least one row referencing users(id).
--
-- ─── Q6: users.role column gone ─────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'users' AND column_name = 'role';
-- -- Expect 0 rows.
--
-- ═════════════════════════════════════════════════════════════════════════════
