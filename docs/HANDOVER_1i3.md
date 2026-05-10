# Handover — 1i.3 role architecture rework

**Status at handover:** 2026-05-10 end-of-session. Plan-first gate signed off; implementation deferred to a fresh chat per the §12 yellow-band rule. This document is the single-file brief — read it cold and pick up.

---

## Where things stand on origin/main

Most recent commit: `1495ace` (Phase 3 §7 invoices CRUD + AI extraction landed; live extraction smoke active).

```
1495ace test(invoices): activate live AI extraction smoke + sample fixture (1i.2)
1dff1b1 feat(financial): invoices CRUD + AI extraction (1i.2) -- closes Phase 3
c147227 docs: handover note covering 1i.1 Tier-1 security hardening
c60c600 feat(security): Tier-1 hardening -- close C-1/C-2/C-3 + 9 more findings (1i.1)
```

**Phase 3 is complete.** All spec §7 deliverables shipped. Smoke count: 134 active passing (1 .skip-by-default — the AI-failure-stage smoke that'd burn Anthropic credits per run for limited incremental coverage).

**Edge Functions deployed:** `dispatch-engine`, `contractor-response`, `document_processing`. Secrets set: `APP_URL`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`.

**Migration head:** `00028_invoices_status_chk.sql`. Next: `00029_role_architecture.sql`.

---

## What 1i.3 closes

The 1i.2 commit shipped Phase 3 §7 on a PoC stand-in for the role architecture: `FINANCE_ROLES = ['admin']` only (regulatory-acceptable but architecturally incomplete). 11 PROD-GATE flags planted in [`00028_invoices_status_chk.sql`](../supabase/migrations/00028_invoices_status_chk.sql) need to lift; 1i.3 closes flags **8 (function-split discriminator)** and **9 (contractor-onboarding payee-stamping)** plus the wider role architecture lift.

**The three signed-off decisions** (from the plan-first negotiation):

1. **Roles to add:** `accounts`, `senior_pm`, `auditor`, `inspector` — first-foot-forward, all four land in this commit while we're touching the role enum + RLS sweep.
2. **Migration shape:** Option A — `user_roles (user_id, role)` junction table replaces `users.role`. No backwards-compat preservation of the column.
3. **Function-split scope:** Full — extends `payment_authorisations.action_type` (`payment` → `payment_release`; new `payment_payee_setup`) AND rewrites `ContractorsPage.tsx` to insert a `payment_payee_setup` PA on contractor add / bank-detail edit.

**Regulatory anchor:** RICS *Client money handling* (1st ed., Oct 2022 reissue) — segregation between staff who set up payee bank details and staff who release payments. Both signatories must be staff of the regulated firm. Today's `admin`-only stand-in doesn't enforce the function-split semantic.

---

## Role inventory after 1i.3

| Role | Tier | Staff/Client | Phase 3 functions | Phase 4+ functions |
|---|---|---|---|---|
| `admin` | staff senior | staff | Authorise payment_release; authorise payment_payee_setup; bank account closure auth; RICS designation toggle | BSA Accountable Person sign-off (Phase 4) |
| `accounts` | staff finance | staff | Upload invoices; queue payment_release (first auth); request payment_payee_setup; read all financial entities | — |
| `senior_pm` | staff PM-tier | staff | All PM functions + override PM decisions (re-open closed reconciliation periods); cannot do finance-tier actions | BSA delegate when admin unavailable (Phase 4) |
| `property_manager` | staff PM-tier | staff | Demand CRUD, transaction entry, reconciliation, invoice Confirm action; cannot drive financial dual-auth | — |
| `auditor` | staff read-only | staff | Read-only across the firm including audit-log tables; can read `is_confidential=true` (logged) | — |
| `inspector` | scaffold-only | staff | Scaffolded only — no UI surface in Phase 3; gates activate Phase 7 | Phase 7 inspection app integration |
| `director` | client | client | Portal-side oversight (budget approval, audit visibility); explicitly NO finance authority | Phase 5 portal |
| `leaseholder` | client | client | Phase 5 portal | Phase 5 portal |
| `contractor` | client | client | Dispatch response (token-based) | — |
| `read_only` | scaffold | scaffold | Existing — no policy changes | — |

---

## Decomposition shape

**Single commit (1i.3)** built in three internal phases for review-ability and recovery — DO NOT split across multiple commits unless the phase 1 verification surfaces something unexpected:

1. **Schema + auth model** — migration 00029 + JWT hook + `useAuth` rewrite. The hard-to-reverse bit. Apply via Dashboard SQL Editor, run verification queries, smoke basic auth still works *before* moving to phase 2.
2. **Role-helper sweep + RLS rewrite** — typed helpers, every consumer of `firmContext.role`, mechanical drop-and-recreate of RLS policies that filter on role. Aligns code with the new claim shape.
3. **Function-split + contractor onboarding** — `payment_authorisations.action_type` extension, `ProposedPayeeSetup` JSONB, contractor-onboarding UI rewrite, tier-asymmetric dual-auth flip-on.

**If smokes go red after phase 1 or 2, abort to a fixup commit (00030).** The 1i.1 LESSONS pattern (00027 fixup migration when 00026 broke trigger recursion) is the prior art.

---

## File list (~25 files)

### Migrations (1)

- `supabase/migrations/00029_role_architecture.sql` — junction + backfill + drop `users.role` + add 4 roles + extend PA action_type + contractors stamps + JWT hook update + RLS sweep. **Single migration**, transactional. ~300 lines. SQL skeleton below.

### Auth layer (3)

- 00029 carries the JWT hook function rewrite (`custom_access_token_hook` builds `user_roles[]` array; `auth_user_role()` deprecated; new `auth_has_role(text)` + `auth_has_any_role(text[])` helpers).
- `app/src/hooks/useAuth.ts` — read array claim from JWT (sister to the 1i.1 H-7 fix); `firmContext.role: string` becomes `firmContext.roles: string[]`.
- `app/src/stores/authStore.ts` — `FirmContext` shape change.

### Role helpers (1, but every consumer touched)

- `app/src/lib/constants.ts` — `USER_ROLES` extended with `accounts`, `senior_pm`, `auditor`, `inspector`. New helpers: `hasAdminRole(roles)`, `hasAccountsRole(roles)`, `hasSeniorPmRole(roles)`, `hasPmRole(roles)`, `hasAuditorRole(roles)`, `hasInspectorRole(roles)`, `hasAnyFinanceRole(roles)` (admin OR accounts), `isStaffRole(roles)`. `isFinanceRole` deprecated; legacy alias kept for one transitional commit then removed in cleanup.

### RLS sweep (within 00029)

Mechanical drop-and-recreate of policies that gate on role:
- `is_pm_or_admin()` rewritten to `auth_has_any_role(ARRAY['admin','accounts','senior_pm','property_manager'])` for write paths; per-policy refinement where needed.
- New `auditor` read-everywhere policies on financial tables (firm-scoped).
- `inspector` scaffolding policies — read property + units + leaseholders + units' lease data; no writes in Phase 3.
- Audit-log tables (`reconciliation_audit_log`, `golden_thread_audit_log`) gain `auditor` SELECT.
- Self-auth guard (`users_update_self`) unaffected.

### Frontend role-gate consumers (~12 files; mechanical)

- `app/src/components/modules/financial/BankAccountsTab.tsx` — `isFinanceRole(role)` → `hasAdminRole(roles)`.
- `app/src/components/modules/financial/PaymentAuthorisationsTab.tsx` — **tier-asymmetric flip-on**. Authorise gate: `hasAdminRole(roles)` for all action_types. Request gate: `hasAccountsRole(roles)` for `payment_release` and `payment_payee_setup`; admin always allowed (single-person firms can still operate as both, subject to self-auth guard).
- `app/src/components/modules/financial/InvoicesTab.tsx` — Queue button: `hasAccountsRole(roles) || hasAdminRole(roles)`. PM Confirm: `hasPmRole(roles) || hasSeniorPmRole(roles)`.
- `app/src/components/modules/financial/DemandsTab.tsx` — write gated `hasPmRole || hasSeniorPmRole || hasAccountsRole || hasAdminRole`.
- `app/src/components/modules/financial/TransactionsTab.tsx` — same.
- `app/src/components/modules/financial/ReconciliationTab.tsx` — re-open closed period: `hasSeniorPmRole(roles) || hasAdminRole(roles)`.
- `app/src/components/modules/financial/ReconciliationCompleteModal.tsx` — same.
- `app/src/components/modules/contractors/ContractorsPage.tsx` — **major rewrite for function-split**. Add contractor / edit bank details inserts a `payment_payee_setup` PA. Approved contractors get `approved_by` stamp.
- `app/src/components/modules/properties/PropertyDetailPage.tsx` — `firmContext.role` → `firmContext.roles[0]` reads narrowed where they exist.
- `app/src/lib/invoices/statusTransitions.ts` — `role: UserRole | null` parameter becomes `roles: UserRole[]`; `canPMTransition` / `canAccountsTransition` consume roles array.
- `app/src/components/modules/dashboard/Dashboard.tsx` — role-gated nav items.
- `app/src/components/AuthGuard.tsx` — multi-role check.

### Type extensions (2)

- `app/src/types/database.ts` — new `ProposedPayeeSetup` interface; `ProposedAction` union extended; `payment_authorisations.action_type` value union widened.
- `app/src/lib/contractors/payeeSetup.ts` (new) — `buildPayeeSetupPA(contractor, proposedBankDetails, requesterId)`; pure function.

### Tests (~17 new + ~10 modified)

#### `app/tests/smoke/security-roles.spec.ts` (new — 11 smokes)

1. JWT array claim — `user_roles[]` is present + has at least one entry for every authenticated user.
2. Multi-role person — admin assigned `accounts` via junction sees both gates active.
3. Tier-asymmetric — `accounts`-only user can queue invoice; cannot authorise.
4. Tier-asymmetric — `admin`-only user can authorise; cannot queue (queue requires accounts; admin must be assigned both for combined operation).
5. Multi-role self-auth guard — admin+accounts user cannot authorise their own queue request (self-auth blocks regardless of role intersection).
6. RLS read scope — every authenticated user sees only their firm's rows (no regression from 1i.1 smoke 9).
7. Auditor read-everywhere — auditor sees all financial tables in their firm; including `reconciliation_audit_log` + `golden_thread_audit_log`.
8. Auditor cannot write — UPDATE / INSERT / DELETE on financial tables rejected (RLS no policy match).
9. Senior PM can re-open closed reconciliation period; PM cannot.
10. Director (client-side) cannot read financial-staff tables — explicit confirmation of the 1i.2 narrowing now persists at RLS layer.
11. Inspector scaffolding — inspector reads properties + units + leaseholders within their firm; no write paths.

#### `app/tests/smoke/financial-payee-setup.spec.ts` (new — 6 smokes)

12. Accounts adds new contractor with bank details → PA `payment_payee_setup` row created in pending status; contractor exists but `approved=false`.
13. Admin authorises payment_payee_setup PA → contractor.approved=true + approved_by stamped + approved_at populated.
14. **Payee-setter ≠ release-authoriser gate** — admin A authorises payment_payee_setup for contractor X; admin B can authorise a future payment_release that pays X; admin A is BLOCKED from authorising that payment_release (regulatory function-split).
15. CHECK constraint — `payment_authorisations.action_type` accepts `payment_payee_setup` and `payment_release`; rejects unknown values.
16. ProposedPayeeSetup JSONB shape — required fields enforced application-side; missing field surfaces clear error.
17. Editing bank details on existing contractor → triggers fresh payment_payee_setup PA; contractor's `approved` flag flips back to false until re-authorised.

#### Existing specs modified (~10 smokes)

- `financial-payment-authorisations`: existing PA tests — replace `'payment'` action_type → `'payment_release'`. Existing self-auth + cross-user auth + reject + cancel-by-requester smokes remain valid; just the action_type literal changes.
- `financial-invoices`: queue-for-payment smoke — assert `action_type='payment_release'` not `'payment'`.
- `financial-bank-accounts`: closure dual-auth — admin-only assertion firms up.
- `security-rls`: 12 existing 1i.1 smokes — rewrite role-gate assertions from `auth_user_role()` to `auth_has_role()` style. RLS smokes 1-12 should all still pass post-sweep.

**Net active count: 134 → ~150**.

### Test seed

- `supabase/seed/test_users_phase4.sql` (new) — idempotent INSERT of 3 new test users (`accounts@propos.local`, `senior_pm@propos.local`, `auditor@propos.local`) following the 1f.5 pattern. **Note**: Dashboard step required — create `auth.users` rows manually first via Authentication → Users → Invite. Then run the link SQL.
- New auth setup files: `tests/smoke/auth-accounts.setup.ts`, `auth-senior-pm.setup.ts`, `auth-auditor.setup.ts`. Copy the `auth-pm.setup.ts` shape.
- `playwright.config.ts` — add the new setup projects to the dependency chain.

### Docs (3)

- `docs/DECISIONS.md` — 1i.3 entry covering migration shape, role mapping, function-split design, RLS sweep, all FORWARD anchors landed.
- `docs/LESSONS_LEARNED.md` — Phase 3 session 5 stub at end of build.
- `docs/SECURITY_AUDIT_2026-05-10.md` — status table updated to reflect 1i.3 closures (none of the audit's 38 findings closes here, but the function-split is a regulatory firming-up worth noting).

---

## Migration plan (00029 — full skeleton)

```sql
-- Migration: 00029_role_architecture
-- Closes 1i.2 PROD-GATE flags 8 (function-split discriminator) and 9
-- (contractor-onboarding payee-stamping), plus the wider role-architecture
-- lift. Decisions: docs/DECISIONS.md 2026-05-10 — Forward 1i.3 + 1i.2 §F5.
--
-- Regulatory: RICS Client money handling (1st ed., Oct 2022 reissue) —
-- segregation of duties between payee-setup and payment-release; both
-- signatories must be staff of firm.

BEGIN;

-- ── 1. user_roles junction table ─────────────────────────────────────────────
CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by UUID REFERENCES users(id),
  PRIMARY KEY (user_id, role),
  CONSTRAINT user_roles_role_chk CHECK (role IN (
    'admin','accounts','senior_pm','property_manager',
    'auditor','inspector','director','leaseholder','contractor','read_only'
  ))
);

CREATE INDEX idx_user_roles_user ON user_roles(user_id);
CREATE INDEX idx_user_roles_role ON user_roles(role);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_roles_self_select ON user_roles
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY user_roles_admin_all ON user_roles
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_roles ur
            WHERE ur.user_id = auth.uid() AND ur.role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_roles ur
            WHERE ur.user_id = auth.uid() AND ur.role = 'admin')
  );

-- ── 2. Backfill from users.role ──────────────────────────────────────────────
INSERT INTO user_roles (user_id, role)
SELECT id, role FROM users WHERE role IS NOT NULL
ON CONFLICT (user_id, role) DO NOTHING;

-- ── 3. JWT hook update — build user_roles[] array claim ──────────────────────
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claims jsonb;
  user_id_v UUID;
  firm_id_v UUID;
  roles_v TEXT[];
BEGIN
  user_id_v := (event->>'user_id')::UUID;
  claims := event->'claims';

  SELECT firm_id INTO firm_id_v FROM users WHERE id = user_id_v;
  SELECT array_agg(role) INTO roles_v FROM user_roles WHERE user_id = user_id_v;

  claims := jsonb_set(claims, '{firm_id}',  to_jsonb(firm_id_v::text));
  claims := jsonb_set(claims, '{user_roles}', COALESCE(to_jsonb(roles_v), '[]'::jsonb));

  -- Backwards-compat: keep user_role as the first role for legacy consumers
  -- during the transition. Removed in a follow-up commit.
  claims := jsonb_set(claims, '{user_role}', to_jsonb(COALESCE(roles_v[1], 'authenticated')));

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT SELECT ON public.users TO supabase_auth_admin;
GRANT SELECT ON public.user_roles TO supabase_auth_admin;

-- ── 4. Helper functions for RLS predicates ───────────────────────────────────
CREATE OR REPLACE FUNCTION auth_has_role(role_name TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(
      COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb -> 'user_roles', '[]'::jsonb)
    ) AS r WHERE r = role_name
  );
$$;

CREATE OR REPLACE FUNCTION auth_has_any_role(role_names TEXT[])
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(
      COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb -> 'user_roles', '[]'::jsonb)
    ) AS r WHERE r = ANY(role_names)
  );
$$;

-- ── 5. Replace is_pm_or_admin() ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION is_pm_or_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT auth_has_any_role(ARRAY['admin','accounts','senior_pm','property_manager'])
$$;

-- ── 6. RLS policy sweep — ~30 policies on financial tables, audit logs,
--     leaseholder tables, documents — each drop+recreate to use auth_has_role
--     instead of auth_user_role = ... ────────────────────────────────────────
--
-- Pattern per policy (sister to 1i.1 §C-2 sweep):
--   DROP POLICY <name> ON <table>;
--   CREATE POLICY <name> ON <table>
--     FOR <action> USING (<auth_has_role-based predicate>)
--     WITH CHECK (<same predicate, on insert/update>);
--
-- Audit chain: inspect 00012_rls_policies.sql + 00025_reconciliation_schema.sql
-- + 00026_security_hardening.sql for every policy whose USING clause references
-- auth_user_role(). The 1i.1 LESSONS Phase 3 session 4 entry has the SQL pattern
-- for verifying coverage post-sweep:
--
--   SELECT polname, pg_get_expr(polqual, polrelid) FROM pg_policy
--   WHERE pg_get_expr(polqual, polrelid) LIKE '%auth_user_role%';
--   -- Expect 0 rows post-sweep.

-- ── 7. Auditor read-everywhere policies (firm-scoped) ────────────────────────
-- For each financial table:
--   CREATE POLICY <table>_auditor_select ON <table>
--     FOR SELECT USING (firm_id = auth_firm_id() AND auth_has_role('auditor'));
--
-- Tables: bank_accounts, transactions, demands, invoices, payment_authorisations,
-- service_charge_accounts, budget_line_items, reconciliation_periods,
-- bank_statement_imports, suspense_items, reconciliation_audit_log,
-- golden_thread_audit_log, dispatch_log.

-- ── 8. payment_authorisations.action_type extension ──────────────────────────
ALTER TABLE payment_authorisations DROP CONSTRAINT payment_auth_action_type;
ALTER TABLE payment_authorisations ADD CONSTRAINT payment_auth_action_type
  CHECK (action_type IN (
    'payment_release',           -- renamed from 'payment'
    'payment_payee_setup',        -- new — 1i.3
    'close_bank_account',
    'toggle_rics_designation'
  ));

-- Backfill existing 'payment' rows to 'payment_release'.
UPDATE payment_authorisations SET action_type = 'payment_release'
WHERE action_type = 'payment';

-- ── 9. contractors.approved_by + approved_at ─────────────────────────────────
ALTER TABLE contractors
  ADD COLUMN approved_by UUID REFERENCES users(id),
  ADD COLUMN approved_at TIMESTAMPTZ;

COMMENT ON COLUMN contractors.approved_by IS
  'Admin user who authorised the payment_payee_setup PA establishing this '
  'contractor''s bank details. Used by the payee-setter ≠ release-authoriser '
  'gate. RICS Client money handling — segregation of duties.';

-- ── 10. Drop users.role (the column — junction table replaces it) ────────────
-- Done LAST so any failure in steps 1-9 leaves the column intact for rollback.
ALTER TABLE users DROP COLUMN role;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- FORWARD: PROD-GATE flags
--
-- 1. FORWARD: PROD-GATE — Auditor visibility into is_confidential=true documents.
--    Reason: design decision pending — read-with-logging vs blocked. Today:
--    auditor SELECT policy is unscoped on is_confidential. May need separate
--    auditor_documents_select_confidential policy with audit-log row write.
--    Anchor: this file + Phase 5 leaseholder portal commit.
--
-- 2. FORWARD: PROD-GATE — users.user_role legacy claim removal.
--    Reason: kept as `claims.user_role = roles_v[1]` for one transition commit.
--    Remove once every consumer is verified to read user_roles[].
--    Anchor: this file step 3 + cleanup commit.
--
-- 3. FORWARD: PROD-GATE — Bulk role assignment UI for admins.
--    Reason: junction lets users hold multiple roles; admin needs a UI to
--    grant/revoke. Today: SQL only.
--    Anchor: app/src/components/modules/admin/ (new module — Phase 5).
--
-- 4. FORWARD: PROD-GATE — INSERT-only audit log for role grants/revokes.
--    Reason: changes to user_roles need an audit trail. Today: granted_at /
--    granted_by stamped but no append-only log of grant/revoke history.
--    Anchor: this file + Data-integrity / auto-protect pass commit.
--
-- 5. FORWARD: PROD-GATE — Senior PM re-open closed reconciliation period UI.
--    Reason: RLS allows but no UI surface today.
--    Anchor: app/src/components/modules/financial/ReconciliationTab.tsx header.
-- ─────────────────────────────────────────────────────────────────────────────
```

### Verification queries (run via Dashboard SQL Editor immediately after migration applies)

```sql
-- Q1: Junction table populated for every user.
SELECT u.id, u.email,
       COALESCE(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL), ARRAY[]::TEXT[]) AS roles
FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id
GROUP BY u.id, u.email
HAVING COALESCE(array_length(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL), 1), 0) = 0;
-- Expect 0 rows. Any user without a role is an orphan.

-- Q2: JWT hook returns array claim.
SELECT custom_access_token_hook(jsonb_build_object(
  'user_id', (SELECT id FROM users WHERE email='admin@propos.local'),
  'claims', '{}'::jsonb
)) -> 'claims' -> 'user_roles' AS roles;
-- Expect: ["admin"]

-- Q3: All RLS policies recreated. No residual auth_user_role references.
SELECT polname, pg_get_expr(polqual, polrelid) AS using_clause
FROM pg_policy
WHERE pg_get_expr(polqual, polrelid) LIKE '%auth_user_role%'
   OR pg_get_expr(polwithcheck, polrelid) LIKE '%auth_user_role%';
-- Expect 0 rows.

-- Q4: payment_authorisations action_type CHECK widened.
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname = 'payment_auth_action_type';
-- Expect to include payment_payee_setup + payment_release; expect 'payment' absent.

-- Q5: contractors.approved_by FK present.
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'contractors'::regclass AND conname LIKE '%approved_by%';

-- Q6: users.role column gone.
SELECT column_name FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'role';
-- Expect 0 rows.
```

---

## Out of scope (FORWARD anchors)

| # | Item | Anchor |
|---|---|---|
| 1 | Phase 5 leaseholder portal — director/leaseholder client-side surface activation | DECISIONS forward — no code anchor in 1i.3 |
| 2 | Phase 7 inspector role full surface — inspection report writes, sync API | `app/src/components/modules/inspection/` (scaffold only) |
| 3 | Auditor visibility into `is_confidential=true` documents — design decision pending (read-with-logging vs blocked) | DECISIONS only |
| 4 | `users.role` legacy alias removal in JWT hook — kept for 1 transition commit | `00029` JWT hook function; cleanup commit anchored |
| 5 | `senior_pm` re-open closed reconciliation period UI — RLS allows; UI surface deferred | `ReconciliationTab.tsx` header |
| 6 | Bulk role assignment UI for admins — Phase 5 | `app/src/components/modules/admin/` (new module) |
| 7 | INSERT-only audit log for role grants/revokes | `00029` header — Data-integrity / auto-protect pass |

---

## Standing pattern when picking this up

1. **Plan-first gate is signed off.** Don't re-litigate scope. The three answers are: 4 new roles (accounts/senior_pm/auditor/inspector), junction table replaces `users.role`, full function-split scope.
2. **Apply migration via Dashboard SQL Editor** (per memory rule). Run verification queries Q1–Q6 immediately after; paste results back to Claude before moving to phase 2.
3. **Smoke after each internal phase.** Phase 1 (schema + auth) → run smokes. Phase 2 (RLS + helpers) → run smokes. Phase 3 (function-split + contractors) → run smokes. If red after any phase, fixup migration 00030.
4. **Ask before push or merge.** Per-action authorisation (memory).
5. **Worktree dev server on 5174** with `playwright.worktree.config.ts` per LESSONS Phase 3 session 1.
6. **Statutory citation as test anchor pattern** — every regulatory rule the new gates enforce should be a literal string in both the user-facing message AND the smoke assertion. Use "RICS Client money handling — segregation of duties" verbatim where the function-split is enforced.
7. **Test users to seed before smoke run:** `accounts@propos.local`, `senior_pm@propos.local`, `auditor@propos.local`. Create auth.users via Dashboard, link via SQL idempotent INSERT. The PM and admin users already exist.

## Estimated scope

- Migration: ~300 lines SQL.
- Code edits: ~1,200 lines net new (junction + helpers + RLS predicates) + ~400 lines mechanical edits across role-gate consumers.
- Tests: ~600 lines across 2 new spec files + ~200 lines mechanical edits across 5 existing specs.
- DECISIONS: ~150 lines.
- **Total**: comparable in shape and size to 1i.1 (Tier-1 hardening, 12 audit findings + RLS sweep). Single-session fresh-chat work unit.

## Pre-flight on this plan in the next session

Before writing any code, confirm:

1. PR `1495ace` (live AI extraction smoke) is on `origin/main`. Run `git log --oneline origin/main` — expect `1495ace` at HEAD or higher.
2. The 11 PROD-GATE flags from 00028 are still grep-able: `grep -rn "FORWARD: PROD-GATE" supabase/migrations/00028*` → 11 hits.
3. Test users `pm@propos.local` and `admin@propos.local` still resolve by email in `public.users` (run `SELECT email, id FROM public.users WHERE email IN ('admin@propos.local','pm@propos.local');` — expect 2 rows). 1f.5 created them.
4. Re-read this document in full + DECISIONS forward entry "Forward: 1i.3" before drafting any code. The user has already answered the three planning questions; do not re-ask.
