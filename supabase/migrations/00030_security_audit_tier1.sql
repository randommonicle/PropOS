-- Migration: 00030_security_audit_tier1
-- Cross-phase audit Tier-1 sweep — closes 3 CRITICAL findings (A-1 / A-2 / A-3)
-- surfaced by docs/AUDIT_2026-05-10.md after 1i.3 widened is_pm_or_admin().
--
-- The findings form one attack chain: with is_pm_or_admin() now including
-- accounts + senior_pm, the RLS write policies on payment_authorisations,
-- contractors, and bank_accounts inherited the widening — but the self-auth
-- guard (payment_authorisations) and the closure / RICS-designation /
-- payee-setter ≠ release-authoriser segregation gates (contractors,
-- bank_accounts) are enforced application-side only. An `accounts` user with
-- direct supabase-js can chain four writes to move money with single-staff
-- involvement, defeating RICS Client money handling — segregation of duties.
--
-- This migration lifts the three load-bearing predicates to the RLS / GRANT
-- layer. The financial-rules Edge Function (FORWARD anchor below) eventually
-- replaces app-side gating with a server-side check, but the column-grant +
-- self-auth predicate are the cleanest defence in the interim and stand
-- independently of the Edge Function lift.
--
-- Cross-references:
--   - docs/AUDIT_2026-05-10.md §1 (CRITICAL findings A-1 / A-2 / A-3) and
--     §2 (Tier-1 sweep; lexical canonicalisation lands in the sister UI
--     commit, not here).
--   - docs/HANDOVER_audit_tier1.md — single-file brief for this sweep.
--   - 00026_security_hardening.sql §C-1 — sister column-grant pattern on
--     public.users (FOR UPDATE column-allowlist + revoke). This migration
--     applies the same pattern to contractors + bank_accounts.
--   - 00029_role_architecture.sql — is_pm_or_admin() widening that surfaced
--     the gap; 00028 PROD-GATE flags 8 + 9 closed there. Flag list in 00028
--     comment block is stale (R-6) — supersession noted in DECISIONS rather
--     than editing 00028 (append-only rule).
--
-- Regulatory anchor:
--   RICS Client money handling (1st ed., Oct 2022 reissue) — segregation of
--   duties; both signatories must be staff of the regulated firm. The
--   application-side gate in PaymentAuthorisationsTab.handleAuthorise stays;
--   the RLS predicate added here is defence-in-depth against any future
--   bypass (and against direct supabase-js usage today).
--
-- Apply path: Dashboard SQL Editor. Verification queries Q1–Q5 inlined at
-- the bottom — run them immediately after apply and paste results back
-- before moving to the smoke commit + UI sweep (commit 2).
--
-- Smokes after apply: 3 new RLS smokes land in app/tests/smoke/security-rls.spec.ts
-- (C-1-new / C-2-new / C-3-new) — each verifies direct supabase-js rejection
-- with code 42501. Existing PA flows (authorise + cancel-by-requester) must
-- continue to pass; Q5 covers this via the full smoke run.
--
-- Known consequential breakage (PoC-acceptable, FORWARD-flagged):
--   * ContractorsPage bank-detail edit currently flips approved=false to
--     force re-approval. Post-apply that direct write returns 42501 because
--     `approved` is not in the column grant. Until the Edge Function lift
--     re-implements the segregation gate server-side, this surface is
--     deliberately degraded — see FORWARD: PROD-GATE 1 below.
--   * BankAccountsTab closure flow that writes is_active=false at the end
--     of the dual-auth chain similarly degrades — see FORWARD: PROD-GATE 1.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- A-1 — payment_authorisations self-auth at RLS layer
-- ════════════════════════════════════════════════════════════════════════════
-- Audit §A-1. The 00026 §C-3 split of payment_auth_pm into per-action
-- policies left the UPDATE policy with `is_pm_or_admin()` as the only
-- predicate. Post-1i.3 widening, an `accounts` user can authorise a PA they
-- raised. Add a self-auth-denial predicate to WITH CHECK so the segregation-
-- of-duties rule lands at the RLS layer (independent of the application-side
-- gate in PaymentAuthorisationsTab.handleAuthorise:147).
--
-- Predicate shape: the audit (§1, A-1 fix block) proposed
--   `requested_by IS DISTINCT FROM auth.uid()` as a flat WITH CHECK clause.
-- That over-blocks legitimate state transitions by the requester (cancel /
-- reject one's own pending PA) — caught by the existing security-rls C-3
-- smoke during 1i.3 audit Tier-1 development. The handover Q5 explicitly
-- anticipated this: "Existing PA flows (authorise + cancel-by-requester)
-- still work". The corrected predicate gates only the AUTHORISATION moment
-- (status transitioning to / staying at 'authorised'); all other state
-- transitions by the requester remain permitted.
--
-- USING stays open (admin reviewing a PA they raised still needs to read it
-- — denial-on-read would be UX-hostile). The block lands on the UPDATE
-- itself via WITH CHECK; that is the regulatorily-load-bearing moment.

DROP POLICY IF EXISTS payment_auth_update ON public.payment_authorisations;
CREATE POLICY payment_auth_update ON public.payment_authorisations
  FOR UPDATE
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id()
              AND is_pm_or_admin()
              AND (status != 'authorised'
                   OR auth.uid() IS DISTINCT FROM requested_by));

COMMENT ON POLICY payment_auth_update ON public.payment_authorisations IS
  'UPDATE gated by firm-scope + PM-tier + self-auth-denial. The status != ''authorised'' OR auth.uid() IS DISTINCT FROM requested_by predicate enforces RICS Client money handling — segregation of duties at the RLS layer (closes Audit §A-1) while preserving cancel-by-requester and other non-authorising state transitions. The application-side gate in PaymentAuthorisationsTab.handleAuthorise stays as defence-in-depth + UX (clearer error messaging).';

-- ════════════════════════════════════════════════════════════════════════════
-- A-2 — contractors column-grant: lock approved* to admin / service-role
-- ════════════════════════════════════════════════════════════════════════════
-- Audit §A-2. Mirror of 00026 §C-1 pattern. Revoke UPDATE on public.contractors
-- from `authenticated`, then grant UPDATE on cosmetic / operational columns
-- only. The three segregation-gate columns — `approved`, `approved_by`,
-- `approved_at` — are deliberately absent from the grant.
--
-- Effect: the only paths that can stamp those columns are (a) service-role
-- writes (Edge Functions, future financial-rules lift), (b) the authorisePayeeSetup
-- branch when it runs under a service-role context (FORWARD anchor 1).
--
-- The `firm_id` column is excluded too (defence-in-depth on cross-firm
-- mutation; sister to 00026 §C-2 paired-WITH-CHECK sweep on FOR ALL policies).

REVOKE UPDATE ON public.contractors FROM authenticated;
GRANT  UPDATE (
  company_name,
  contact_name,
  email,
  phone,
  address,
  trade_categories,
  insurance_expiry,
  gas_safe_number,
  electrical_approval,
  preferred_order,
  active,
  portal_access,
  rating,
  notes
) ON public.contractors TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- A-3 — bank_accounts column-grant: lock segregation-load-bearing columns
-- ════════════════════════════════════════════════════════════════════════════
-- Audit §A-3. Same shape as A-2. The three closure / RICS-designation
-- columns — `is_active`, `closed_date`, `rics_designated` — are absent from
-- the grant. `firm_id` and `property_id` are likewise excluded (cross-firm
-- + cross-property mutation primitives, defence-in-depth on the WITH CHECK
-- predicate).
--
-- `current_balance` AND `updated_at` ARE granted — both are required by the
-- AFTER-INSERT trigger sync_bank_account_balance (00005:145) which issues
-- a SEPARATE `UPDATE bank_accounts SET current_balance = ..., updated_at =
-- NOW() WHERE id = ...` on every transactions write. That separate UPDATE
-- runs with the caller's privileges (SECURITY INVOKER default), so the two
-- columns must be in the column grant. Defence-in-depth on current_balance
-- is provided by the 00026+00027 M-1 block_balance_writes trigger
-- (pg_trigger_depth-aware: P0001 on user writes, pass-through for the sync
-- trigger). Defence on updated_at is unnecessary — the worst case is audit-
-- timestamp pollution with no privilege escalation; the load-bearing
-- segregation columns (is_active / closed_date / rics_designated) remain
-- locked. Excluding either broke every transaction INSERT for non-admin
-- users (caught by the C-1-new smoke during 1i.3 audit Tier-1 development).
--
-- Cosmetic / admin-correction columns granted: name, type, bank_name, last-4
-- fragments, opened_date, dual-auth config, last_reconciled_at, notes.

REVOKE UPDATE ON public.bank_accounts FROM authenticated;
GRANT  UPDATE (
  account_name,
  account_type,
  bank_name,
  sort_code_last4,
  account_number_last4,
  opened_date,
  requires_dual_auth,
  dual_auth_threshold,
  last_reconciled_at,
  current_balance,
  updated_at,
  notes
) ON public.bank_accounts TO authenticated;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- FORWARD: PROD-GATE flags planted by 00030 (audit Tier-1 sweep)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. FORWARD: PROD-GATE — Financial-rules Edge Function (server-side
--    segregation gate).
--    Today: closure (BankAccountsTab) + RICS-designation toggle + payee-setup
--    stamping + bank-detail edit re-approval all write through the
--    application layer. Post-00030 the direct writes on `approved`,
--    `approved_by`, `approved_at`, `is_active`, `closed_date`,
--    `rics_designated` all return 42501 — only the authorise* branches
--    running under service-role (future Edge Function) can perform them.
--    The Edge Function carries the segregation-of-duties predicate
--    server-side; today the application-side gate in
--    PaymentAuthorisationsTab.handleAuthorise + the RLS self-auth predicate
--    added here are the layered defence. Anchor:
--    supabase/functions/financial-rules/ (new — Phase 4 pre-lift) +
--    app/src/components/modules/financial/PaymentAuthorisationsTab.tsx
--    handleAuthorise* branches.
--
-- 2. FORWARD: PROD-GATE — Re-enable bank-detail edit "force re-approval"
--    flow under service-role.
--    Today: ContractorsPage.handleSubmit:437-440 currently flips
--    approved=false on bank-detail edit ("approved is NEVER set directly
--    — only by the PA authorise path" — the comment is now load-bearing).
--    Post-00030 that flip returns 42501; the regulatory expectation
--    (re-approval on bank-detail change) is degraded until either (a) the
--    flip routes through the financial-rules Edge Function, or (b) a
--    dedicated `contractors_force_reapproval` Edge Function lands. Anchor:
--    app/src/pages/ContractorsPage.tsx:437-440 + financial-rules.
--
-- 3. FORWARD: PROD-GATE — Encrypted contractor bank-detail columns.
--    Today: contractor sort code / account number stash in
--    `contractors.notes` JSON (PoC compromise). Once column-level grants
--    are in place (this migration), the encryption pass can drop dedicated
--    columns with REVOKE/GRANT discipline matching 00030. Anchor:
--    Data-integrity / auto-protect pass commit.
--
-- 4. FORWARD: 00028 PROD-GATE flags 8 + 9 stale annotation (R-6).
--    Today: 00028's comment block lists flags 8 + 9 as open; both were
--    closed by 00029. The migration file is append-only (no edit). The
--    canonical PROD-GATE manifest lives in DECISIONS.md — update there to
--    mark 8 + 9 as CLOSED-BY 00029 instead of editing 00028. This file
--    serves as the forward pointer for grep-discoverability per memory
--    rule `feedback_flag_deferred_items.md`.
--
-- 5. FORWARD: §X.X placeholder in 00028 line 111 (R-5).
--    Today: 00028 line 111 contains an unresolved `§X.X` placeholder in a
--    migration audit-trail comment. Append-only rule applies; canonical
--    citation form is "RICS Client money handling (1st ed., Oct 2022
--    reissue) — segregation of duties; both signatories must be staff of
--    the firm" — the 1st-edition source carries no stable section number.
--    The placeholder was a drafting artefact, not a deferred resolution.
--    Documented in DECISIONS rather than retroactively edited.
--
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run via Dashboard SQL Editor immediately after apply)
-- ═════════════════════════════════════════════════════════════════════════════
-- Paste the result of each query back into chat before moving to commit 1's
-- smoke addition + commit 2 (UI sweep).
--
-- ─── Q1: auth_user_role() residue check — should still be 0 from 00029 ──────
-- SELECT polname, pg_get_expr(polqual, polrelid) AS using_clause
-- FROM pg_policy
-- WHERE pg_get_expr(polqual, polrelid)      LIKE '%auth_user_role%'
--    OR pg_get_expr(polwithcheck, polrelid) LIKE '%auth_user_role%';
-- -- Expect 0 rows. Regression check that 00030 didn't accidentally
-- -- reintroduce a reference (sanity — none of the sites above touch
-- -- auth_user_role).
--
-- ─── Q2: payment_auth_update WITH CHECK contains the self-auth predicate ────
-- SELECT polname, pg_get_expr(polwithcheck, polrelid) AS with_check_clause
-- FROM pg_policy
-- WHERE polrelid = 'public.payment_authorisations'::regclass
--   AND polname = 'payment_auth_update';
-- -- Expect 1 row; with_check_clause includes both `status` and
-- -- `requested_by` (the predicate gates only the authorisation moment so
-- -- cancel-by-requester and other non-authorising transitions still work).
--
-- ─── Q3: contractors column grants exclude approved / approved_by / approved_at
-- SELECT column_name, privilege_type
-- FROM information_schema.column_privileges
-- WHERE table_schema = 'public'
--   AND table_name   = 'contractors'
--   AND grantee      = 'authenticated'
--   AND privilege_type = 'UPDATE'
-- ORDER BY column_name;
-- -- Expect: 14 rows, none of which is `approved`, `approved_by`, `approved_at`,
-- -- `firm_id`, `id`, `created_at`, or `updated_at`.
--
-- ─── Q4: bank_accounts column grants exclude is_active / closed_date / rics_designated
-- SELECT column_name, privilege_type
-- FROM information_schema.column_privileges
-- WHERE table_schema = 'public'
--   AND table_name   = 'bank_accounts'
--   AND grantee      = 'authenticated'
--   AND privilege_type = 'UPDATE'
-- ORDER BY column_name;
-- -- Expect: 12 rows, none of which is `is_active`, `closed_date`,
-- -- `rics_designated`, `firm_id`, `property_id`, `id`, or `created_at`.
-- -- `current_balance` AND `updated_at` ARE present — both are required by
-- -- the sync_bank_account_balance AFTER-INSERT trigger on transactions
-- -- (separate UPDATE statement issued by the trigger; SECURITY INVOKER).
-- -- Defence-in-depth on current_balance is the 00026+00027 M-1 trigger;
-- -- updated_at is audit-timestamp only with no privilege escalation surface.
--
-- ─── Q5: existing PA flows still work — direct UPDATE by a DIFFERENT staff user
-- -- (catches over-restriction). This is a smoke-level check; the migration
-- -- relies on the C-1-new / C-2-new / C-3-new smokes for negative-case
-- -- coverage, and on the existing PA full-flow smokes for positive-case.
-- -- Run as `admin@propos.local` via the app:
-- --   1. Have `accounts@propos.local` raise a payment_release PA.
-- --   2. As admin, click Authorise.
-- --   3. Expect: PA status = 'authorised'; no 42501.
-- -- Q5 has no SQL form — it is a smoke / manual test by design.
--
-- ═════════════════════════════════════════════════════════════════════════════
