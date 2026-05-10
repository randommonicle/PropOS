# PropOS Security Audit — 2026-05-10

**Phase 3 reconciliation engine complete (commit 900506e).** This document is a deep architectural review of the security posture of the PropOS codebase as it stands at end-of-Phase-3, with severity rankings, file anchors, and recommended remediations. It is the canonical scope document for the **Security-smoke pass** (forward DECISIONS entry, 1g.6) and the **Data-integrity / auto-protect pass** (forward DECISIONS entry, 1g.6) — both of which are scheduled to land alongside the financial-rules Edge Function commit.

---

## Status update — Tier-1 hardening landed (commit 1i.1, 2026-05-10)

The audit's §5 Tier-1 fix bundle landed in commit 1i.1. **3 of 4 critical findings closed; 12 findings total closed; 1 critical (C-4) remains open and explicitly Tier-2.** Single migration `00026_security_hardening.sql` plus fixup `00027_fix_m1_trigger_recursion.sql` carried the DB-layer work; app-side `app/src/hooks/useAuth.ts` carried H-7; `supabase/config.toml` carried H-1 + H-3; smoke spec sweep across 11 files plus new `app/tests/smoke/security-rls.spec.ts` (12 smokes) carried H-6 + the Security-smoke pass scope. **119/119 smokes passing post-1i.1.** See `docs/DECISIONS.md` 2026-05-10 — Tier-1 security hardening (commit 1i.1) for the full landing record.

| ID | Severity | Status post-1i.1 | Notes |
|---|---|---|---|
| **C-1** | CRITICAL | ✅ Fixed | Column-grant restriction + `WITH CHECK (id = auth.uid())` on `users_update_self`. Smokes 1–3 in `security-rls.spec.ts`. |
| **C-2** | CRITICAL | ✅ Fixed | `WITH CHECK` clauses added to all 30 `FOR ALL USING` policies in 00012 + 00025. Smokes 4–6. |
| **C-3** | CRITICAL | ✅ Fixed | `reconciliation_audit_log` + `golden_thread_audit_log` → SELECT + INSERT only. `dispatch_log` + `payment_authorisations` → SELECT + INSERT + UPDATE (no DELETE). Smokes 7–8. |
| **C-4** | CRITICAL | 🟡 Open — Tier-2 | Storage RLS for `documents.is_confidential`. FORWARD: PROD-GATE anchor planted at bottom of `00026_*.sql` and `00017_storage_rls.sql`. Lands with Phase 5 leaseholder-portal commit. Promotes to active CRITICAL the moment Phase 5 ships. |
| **H-1** | HIGH | ✅ Fixed | `enable_signup = false` + `enable_confirmations = true` in `supabase/config.toml`. **Dashboard sibling toggle MUST be flipped OFF for the live project** — `config.toml` only governs the local CLI shadow. |
| **H-2** | HIGH | ✅ Fixed | `pm_messages_self` rewritten with `firm_id` predicate. |
| **H-3** | HIGH | ✅ Fixed | `jwt_expiry = 600` (10-min post-revocation window, was 3600). |
| **H-4** | HIGH | ✅ Fixed | `is_current = true` filter added to all 4 leaseholder-scoped subselects. |
| **H-5** | HIGH | 🟡 Open — Tier-3 | pgAudit log config doc. Phase 8 self-host package. |
| **H-6** | HIGH | ✅ Fixed | Publishable-key fallback dropped from 11 spec files + `cleanup.mjs`. New `_env.ts` `requireEnv` helper fails at module load. |
| **H-7** | HIGH | ✅ Fixed | `useAuth.ts` `loadFirmContext` now reads `firm_id` + `user_role` from JWT claims, not `public.users`. |
| **M-1** | MEDIUM | ✅ Fixed | `block_balance_writes()` BEFORE-UPDATE trigger with `pg_trigger_depth() = 1` recursion guard (00027). Smoke 10. |
| **M-3** | MEDIUM | ✅ Fixed | `transactions_sign_type_chk` CHECK constraint. Smoke 11. |
| **M-4** | MEDIUM | ✅ Fixed | `pa_authorised_pair_chk` + `pa_rejected_triple_chk` CHECK constraints. Smoke 12. |
| M-2, M-5, M-6, M-12, M-13 | MEDIUM | 🟡 Open — Tier-4 | Data-integrity / auto-protect pass commit. |
| M-7, M-8, M-9, M-10, M-11 | MEDIUM | 🟡 Open | Various tiers per §5. |
| L-1 … L-9 | LOW | 🟡 Open | Per §5 phasing. |

**Findings inserted into existing forward entries by audit §6** are now formally landed in those entries via the 1i.1 DECISIONS entry rather than re-derived per finding. The Security-smoke pass scope's 3 audit-added items (C-1 mutation, C-2 firm_id transfer, C-3 audit-log DELETE) are all green smokes. The Data-integrity pass scope's 5 audit-added items: M-3 closed; M-2 / M-6 / M-12 / M-13 / L-3 / C-4-coherence remain in that pass's scope.

---

## Executive summary

**Findings:** 38 total. **Critical: 4 · High: 7 · Medium: 13 · Low: 9 · Info / confirmations: 5.**

**The four critical findings all concern the same root cause:** RLS policies in migration 00012 use `FOR ALL USING (...)` without paired `WITH CHECK (...)` clauses. This is a well-known PostgreSQL RLS pitfall: `USING` controls row visibility for SELECT/UPDATE/DELETE; `WITH CHECK` controls the row-after-mutation predicate. Without `WITH CHECK`, an authenticated user can `UPDATE`/`INSERT` rows with `firm_id` values pointing at other firms. The row "leaves their visibility" but the data persists at the other firm. This is the **single largest exploitable gap** in the codebase.

**Top 5 must-fix-before-customer items:**

| # | Finding | File | Severity |
|---|---|---|---|
| C-1 | `users_update_self` allows a user to mutate their own `role` and `firm_id` columns | `00012_rls_policies.sql:48` | CRITICAL |
| C-2 | All `FOR ALL USING` policies missing `WITH CHECK` — cross-firm `firm_id` mutation possible | `00012_rls_policies.sql` (30 policies) | CRITICAL |
| C-3 | `reconciliation_audit_log`, `golden_thread_audit_log`, `dispatch_log`, `payment_authorisations` all permit DELETE — audit-trail destruction | `00012:128`, `00012:191`, `00012:225`, `00025:188` | CRITICAL |
| C-4 | Storage RLS does not honour `documents.is_confidential` — leaseholder with signed URL can read confidential files | `00017_storage_rls.sql` | CRITICAL |
| H-1 | Self-signup is enabled (`enable_signup = true`) with `enable_confirmations = false` — abuse vector | `supabase/config.toml:35-37` | HIGH |

The remaining 33 findings are catalogued by domain in §3 onwards.

**Cross-reference with existing DECISIONS forward entries.**

- **Security-smoke pass** (DECISIONS 2026-05-10) covers items C-2 (RLS isolation), and 6 specific smokes. This audit identifies **3 specific RLS holes that fall under that scope but are not yet enumerated** — added to the manifest in §6.
- **Data-integrity / auto-protect pass** (DECISIONS 2026-05-10) covers items 1-8 of the canonical list. This audit identifies **5 specific CHECK / trigger gaps not yet enumerated** — added in §6.
- **Production-grade gate** (DECISIONS 2026-05-10) carries 12 manifest items. **This audit verifies all 12 PROD-GATE flags exist in code** (§5). Manifest is complete and grep-clean.

---

## 1. Methodology

**What was reviewed (line-by-line, not just spot-check):**

- All 25 migrations (`00001_enable_pgaudit.sql` → `00025_reconciliation_schema.sql`)
- The JWT claims hook + grants (00013-00016)
- All RLS policies (00012, 00017, 00018, 00019)
- Both Edge Functions (`contractor-response/index.ts`, `dispatch-engine/index.ts`)
- Frontend auth surface (`supabase.ts`, `authStore.ts`, `useAuth.ts`, `AuthGuard.tsx`)
- Build / config surface (`vite.config.ts`, `supabase/config.toml`, `.gitignore`)
- The PROD-GATE manifest cross-check via grep (12 expected anchors, 12 found)

**What was NOT reviewed (out of scope or deferred):**

- Phase 4 BSA module RLS hardening (Phase 4 work).
- The Anthropic API integration (`document_processing.ts` Edge Function — not yet built; Phase 5).
- Frontend XSS surface in detail (the React tree is largely text-rendering; flagged at §3.6).
- Penetration testing / dynamic exploit development — this is a static review.
- The Inspection App integration (Phase 7, not yet built).
- Compliance with specific FCA / GDPR / TPI Code clauses — flagged where relevant but not the focus.

---

## 2. Findings by severity

### CRITICAL (4)

#### C-1 — `users_update_self` permits role + firm_id self-mutation

**File:** `supabase/migrations/00012_rls_policies.sql:47-48`

```sql
CREATE POLICY users_update_self ON users
  FOR UPDATE USING (id = auth.uid());
```

**Exploit:** Any authenticated user can run:

```sql
UPDATE public.users SET role = 'admin', firm_id = '<other-firm>' WHERE id = auth.uid();
```

The `USING` predicate (`id = auth.uid()`) passes — they own the row. There is no `WITH CHECK` clause and no column-list restriction, so the row-after-mutation can carry any `role` and any `firm_id`.

**Two distinct exploit paths:**

1. **Privilege escalation within own firm.** Set `role = 'admin'`. The next time the JWT refreshes (next sign-in or token refresh — within `jwt_expiry = 3600`s by default), the JWT hook reads the new role from `public.users`, the JWT carries `user_role: 'admin'`, all role-gated UI and RLS policies treat the user as an admin. **A leaseholder, contractor, or read-only user can become admin within an hour.**
2. **Cross-firm transfer.** Set `firm_id = '<other-firm-uuid>'`. Same JWT-refresh latency. Now the user has full admin (or whatever role) access to the target firm's data. **Cross-firm data exfiltration of all financial records, documents, leaseholders.**

**Mitigation today:** None. The interim role gates in the UI (`isFinanceRole(role)`) read `firmContext.role` from the zustand store, which `useAuth.loadFirmContext` populates by reading `public.users.role` directly via the supabase client (bypassing the JWT). So the mutation is reflected immediately client-side too — even before JWT refresh.

**Fix:**

```sql
DROP POLICY users_update_self ON users;
CREATE POLICY users_update_self ON users
  FOR UPDATE USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND role = (SELECT role FROM users WHERE id = auth.uid())
    AND firm_id = (SELECT firm_id FROM users WHERE id = auth.uid())
  );
```

The `WITH CHECK` predicate prevents the row from leaving the user's "self" classification with any role/firm_id changes. Or — cleaner — use a column-level `GRANT`:

```sql
DROP POLICY users_update_self ON users;
REVOKE UPDATE ON public.users FROM authenticated;
GRANT UPDATE (full_name, phone) ON public.users TO authenticated;
CREATE POLICY users_update_self ON users
  FOR UPDATE USING (id = auth.uid())
  WITH CHECK (id = auth.uid());
```

This restricts `UPDATE` to the explicit non-privileged column set. The column-grant approach is the most defensive — anything new added later is denied by default.

**Recommended severity action:** Fix before any beta customer. Do not depend on RLS row-visibility being a sufficient barrier when the policy lacks `WITH CHECK`.

---

#### C-2 — All `FOR ALL USING` policies missing `WITH CHECK` — cross-firm INSERT/UPDATE possible

**Files:** `supabase/migrations/00012_rls_policies.sql` (~30 policies) + `00025_reconciliation_schema.sql` (3 policies for new tables)

**Exploit:** Same `firm_id` mutation hole as C-1, applied to every `FOR ALL` policy. Example:

```sql
-- bank_accounts_pm policy:
-- CREATE POLICY bank_accounts_pm ON bank_accounts
--   FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

-- A PM at firm A runs:
UPDATE bank_accounts SET firm_id = '<firm-B-uuid>' WHERE id = '<own-account-id>';
```

The `USING` predicate matches (the row currently belongs to firm A). No `WITH CHECK`, so the row-after-update with `firm_id = firm-B` is permitted. The row now appears in firm B's view; firm A loses it.

**Concrete impact (bank_accounts):**

- A malicious PM can transfer their own firm's bank accounts to another firm's namespace. The other firm's PMs see an unfamiliar bank account (possibly with a £0 balance + no transactions, since transactions retain their old firm_id and the FK goes one way). Confusion + data integrity loss.
- An attacker who has compromised one firm's PM account can plant rows into another firm's view by transferring records.
- The `current_balance` trigger fires after the transfer; the new firm's `bank_accounts` row gets recomputed against transactions with the OLD firm_id (which still match by `bank_account_id`). The trigger doesn't filter by firm_id, so balances follow correctly. But this means money-flow data is now visible to firm B.

**Same hole exists on:** `properties`, `units` (FOR INSERT has WITH CHECK; FOR UPDATE doesn't), `leaseholders`, `apportionment_*`, `bank_accounts`, `service_charge_accounts`, `budget_line_items`, `transactions`, `payment_authorisations`, `invoices`, `bank_statement_imports`, `demands`, `compliance_items`, `insurance_policies`, `documents`, `contractors`, `works_orders`, `dispatch_log`, `section20_*`, `bsa_*`, `firm_portal_config`, `maintenance_requests`, `portal_messages`, `meetings`, `firm_inspection_config`, `inspection_report_links`, `suspense_items` (00025), `reconciliation_periods` (00025), `reconciliation_audit_log` (00025).

**Mitigation today:** None. RLS is the only firm-isolation mechanism.

**Fix:** Add `WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin())` to every `FOR ALL` policy. Example:

```sql
DROP POLICY bank_accounts_pm ON bank_accounts;
CREATE POLICY bank_accounts_pm ON bank_accounts
  FOR ALL
  USING (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());
```

Mechanical fix; one migration touching every policy. Recommend a single sweep migration `00026_rls_with_check_hardening.sql` as the first commit of the security-smoke pass.

**Recommended severity action:** Fix before any beta customer. This is the bulk of the security-smoke pass scope.

---

#### C-3 — Audit-trail tables permit DELETE — evidence destruction

**Files:** `00012_rls_policies.sql` for `dispatch_log` (191), `golden_thread_audit_log` (224), `payment_authorisations` (127); `00025_reconciliation_schema.sql:188` for `reconciliation_audit_log`.

**Exploit:** `FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin())` permits DELETE on every audit-evidence table. A PM can:

```sql
DELETE FROM reconciliation_audit_log WHERE bank_account_id = '<own>';
DELETE FROM payment_authorisations WHERE id = '<inconvenient-record>';
DELETE FROM dispatch_log WHERE works_order_id = '<inconvenient-job>';
DELETE FROM golden_thread_audit_log WHERE firm_id = auth_firm_id();
```

The `golden_thread_records` table itself is correctly protected (no UPDATE or DELETE policy at 00012:215-220 — `FOR INSERT` and `FOR SELECT` only). But the `golden_thread_audit_log` is a `FOR ALL` policy — meaning the audit-of-the-audit is mutable.

**Spec violation:** Spec §5.3 RICS RULE: "the reconciliation engine ... is the system component that demonstrates compliance, so its audit log is itself a compliance artefact and must be retained for a minimum of 6 years post-period." A PM-deletable audit log is non-compliant on its face.

**Mitigation today:** PROD-GATE flag #6 (Production-grade gate) and DECISIONS Data-integrity / auto-protect pass item 7 both call out append-only audit-log RLS as deferred. The flag is correctly planted at the right anchor in `00025_*.sql`. **The audit recognises this as known-deferred but elevates it to CRITICAL because:**

1. The retention rule is statutory (RICS Rule 3.7, 6 years post-period).
2. The fix is a 4-line RLS migration — cheap to land independently of the financial-rules Edge Function.
3. Without this, every reconciliation completion in the period from now until the fix lands has a destructible audit trail. If a regulator asks "show me the trail", the firm has to demonstrate non-deletion — at this stage they cannot.

**Fix:** Append-only RLS for every audit-evidence table:

```sql
DROP POLICY recaudit_pm ON reconciliation_audit_log;
CREATE POLICY recaudit_select ON reconciliation_audit_log
  FOR SELECT USING (firm_id = auth_firm_id() AND is_pm_or_admin());
CREATE POLICY recaudit_insert ON reconciliation_audit_log
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());
-- No UPDATE or DELETE policy — RLS rejects both for every role, including
-- service_role only when explicit. Service-role-key writes from Edge
-- Functions still bypass RLS, which is the intended path for back-office
-- corrections.
```

Same shape for `golden_thread_audit_log`, `dispatch_log`, `payment_authorisations`. Latter two are a judgement call: dispatch_log is both audit AND state (response/decline tracking). Accepting that, restrict to UPDATE-allowed-but-not-DELETE for dispatch_log + payment_authorisations.

**Recommended severity action:** Land the audit-log lockdown migration immediately. Independent of the rest of the security-smoke pass. Cheap, high-value, pure DDL.

---

#### C-4 — Storage RLS does not honour `documents.is_confidential`

**Files:** `supabase/migrations/00017_storage_rls.sql` + `00012_rls_policies.sql:165-177` for the `documents` table.

**Issue:** The `documents` table has a `documents_leaseholder_select` policy that excludes `is_confidential = true` files for leaseholders. But the `storage.objects` RLS for the `documents` bucket only checks the path-prefix (`firm_id` folder), not the confidentiality flag. So if a leaseholder somehow obtains the storage path of a confidential document (e.g., by a PM accidentally pasting a signed URL into a leaseholder portal message, or a leaked URL in email), the storage RLS allows them to fetch the file because they're an authenticated firm member.

**Exploit:**

1. Leaseholder is authenticated and a member of firm A.
2. They guess (or are leaked) the storage path of a confidential document: `<firm-A>/2026-01-15_board_minutes.pdf`.
3. They request `storage.objects.select('documents').eq('name', '<path>')` directly via supabase-js (bypassing the documents-table RLS that filters confidentiality).
4. Storage RLS at 00017 only checks `(storage.foldername(name))[1] = (auth.jwt() ->> 'firm_id')` — passes.
5. They get a download URL and read the file.

**Spec violation:** Spec §5.7: "is_confidential = true restricts visibility to firm admin and the PM assigned to the property. Used for legal correspondence, board-only documents, and HR-style matters. Leaseholder portal never displays confidential documents regardless of document_type permissions."

**Mitigation today:** None at storage layer. Mitigated only by the leaseholder portal UI not showing confidential documents (so paths are unknown) — but spec says "regardless of document_type permissions" implying the system's job is enforcement, not just hiding.

**Fix:** Storage RLS needs to join against the `documents` table to honour `is_confidential` per-role:

```sql
CREATE POLICY "documents: leaseholder select non-confidential"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = (auth.jwt() ->> 'firm_id')
    AND (
      -- Admin/PM/director: full access
      (auth.jwt() ->> 'user_role') IN ('admin', 'property_manager', 'director')
      -- Leaseholder: only documents flagged non-confidential AND attached to their unit
      OR EXISTS (
        SELECT 1 FROM public.documents d
        WHERE d.storage_path = storage.objects.name
          AND d.is_confidential = false
          AND d.property_id IN (
            SELECT property_id FROM public.leaseholders WHERE user_id = auth.uid()
          )
      )
    )
  );
```

Drops the simple firm-only policy in favour of role-aware storage RLS.

**Recommended severity action:** Land alongside the leaseholder portal commit (Phase 5). The exploit window only opens when leaseholders gain authenticated access — currently no leaseholder users are seeded, so the exposure is theoretical. **Promote to CRITICAL the moment Phase 5 ships.** Document inline at the leaseholder-portal entry point.

---

### HIGH (7)

#### H-1 — `enable_signup = true` + `enable_confirmations = false` permits anonymous auth.users creation

**File:** `supabase/config.toml:35-37`.

**Issue:** Self-signup is enabled, email confirmation is disabled. Anyone with the publishable key (which is intentionally public-facing) can call `auth.signUp(...)` and create an `auth.users` row without owning the email address.

**Why this matters even though `public.users` insert is admin-gated:**

- **Spam vector.** An attacker can enumerate the auth.users table by signup attempts (returns "user already exists" if the email is taken), inferring which emails have PropOS accounts. Privacy leak.
- **Confirmation-email reflection.** Even with `enable_confirmations = false`, certain Supabase auth flows still send emails (password reset, magic link). An attacker can use signup to seed emails for later magic-link reflection attacks.
- **Storage waste.** Each signup creates an auth.users row. No throttling visible.
- **Post-fix easier compromise.** If a firm decides to enable confirmations or email-link login later, every existing fake auth.users row is now a potential compromise vector.

**Mitigation today:** A signed-up user has no `public.users` row, so the JWT hook returns no `firm_id`/`user_role` claims. All RLS rejects. The user is effectively neutered.

**Fix:**

```toml
[auth]
enable_signup = false  # Admins create users via Dashboard + test_users.sql pattern
[auth.email]
enable_signup = false
enable_confirmations = true  # PoC -> production
```

The PropOS user-creation flow is admin-driven anyway (DECISIONS 2026-05-10 — Test users seed pattern).

**Recommended severity action:** Toggle off in production deployment config. Document in the Phase 8 self-host package.

---

#### H-2 — `portal_messages.pm_messages_self` lacks `firm_id` predicate — cross-firm message planting

**File:** `00012_rls_policies.sql:253-254`

```sql
CREATE POLICY pm_messages_self ON portal_messages
  FOR SELECT USING (from_user_id = auth.uid() OR to_user_id = auth.uid());
```

**Exploit:** A PM at firm A inserts a `portal_messages` row with `to_user_id = <user at firm B>`. The INSERT policy `pm_messages_pm` requires `firm_id = auth_firm_id()` — so the row gets `firm_id = firm A`. The user at firm B sees the message because `to_user_id = auth.uid()` matches.

**Impact:** Cross-firm spam / phishing / social-engineering vector. A malicious PM at one firm can send messages to any user at any other firm whose user_id they can guess (UUIDs are hard to guess but often surfaced in JOIN-bearing exports or AI processing pipelines).

**Fix:** Add `firm_id = auth_firm_id()` to the policy:

```sql
CREATE POLICY pm_messages_self ON portal_messages
  FOR SELECT USING (
    firm_id = auth_firm_id()
    AND (from_user_id = auth.uid() OR to_user_id = auth.uid())
  );
```

**Recommended severity action:** Phase 5 (leaseholder portal) is when this becomes exploitable. Fix as part of the portal commit.

---

#### H-3 — JWT hook silently ignores deactivated users with stale tokens

**File:** `supabase/migrations/00016_fix_role_claim.sql:31`

```sql
SELECT firm_id, role
INTO v_firm_id, v_role
FROM public.users
WHERE id = v_user_id AND active = true;
```

**Issue:** The JWT hook only sets claims if the user is `active = true`. If a user's `active` flag is flipped to `false`, the next JWT refresh (within `jwt_expiry = 3600`s) silently drops the claims. With no `firm_id` claim, all RLS rejects — so the user effectively loses access.

**That's correct behaviour.** But the **hour-long window before the next refresh** is a problem:

1. Firm admin offboards a PM by setting `active = false`.
2. The PM's existing JWT remains valid for up to 3600 seconds.
3. During that window, the PM still has full access to financial data.

**Mitigation today:** None. JWT expiry is the only revocation mechanism.

**Fix:** Two options:

1. **Reduce `jwt_expiry`** to 600 (10 minutes). Trades off UX (more frequent refresh) for security (shorter post-revocation window). Standard for finance apps.
2. **Implement an `active` check in RLS helpers.** Add `auth_user_active()` helper that returns `false` if `public.users.active = false`. Add to every policy. Expensive (extra JOIN per query) but immediate.

Option 1 is the pragmatic fix.

**Recommended severity action:** Lower `jwt_expiry` to 600 in production config. Document.

---

#### H-4 — `documents_leaseholder_select` uses `leaseholders.property_id` from a stale lifecycle

**File:** `00012_rls_policies.sql:169-177`

```sql
CREATE POLICY documents_leaseholder_select ON documents
  FOR SELECT USING (
    firm_id = auth_firm_id() AND
    auth_user_role() = 'leaseholder' AND
    is_confidential = false AND
    property_id IN (
      SELECT p.property_id FROM leaseholders p WHERE p.user_id = auth.uid()
    )
  );
```

**Issue:** The subquery `SELECT property_id FROM leaseholders WHERE user_id = auth.uid()` returns ALL leaseholders rows for the user — including historical (`is_current = false`) ones. A leaseholder who has moved on from a property retains read access to that property's documents indefinitely.

**Spec violation:** Spec §4.2 implies leaseholder visibility ends with tenancy ("Historical leaseholders: hidden by default" in the PM UI is a hint). But the RLS policy doesn't reflect it.

**Fix:**

```sql
property_id IN (
  SELECT property_id FROM leaseholders
  WHERE user_id = auth.uid() AND is_current = true
)
```

Same pattern needs applying to `demands_leaseholder_select` (00012:142-147), `s20_leaseholder_select` (00012:198-202), `mr_leaseholder` (00012:244-248).

**Recommended severity action:** Phase 5 portal hardening. Land in the same migration as H-2.

---

#### H-5 — `pgaudit` enabled but logging configuration not in repo

**File:** `00001_enable_pgaudit.sql` + LESSONS_LEARNED Phase 1.

**Issue:** LESSONS notes that pgAudit's logging configuration must be done via the Supabase Dashboard Extensions panel, not SQL (`ALTER SYSTEM` cannot run inside a transaction on Supabase hosted). The migration creates the extension; the runtime config is undocumented in the repo.

**Impact:** The "what does pgAudit actually log" answer is: whatever the Dashboard config says. There's no source-controlled assertion that DDL changes, role grants, or sensitive-table operations are logged. A regulator asking "show me the audit log of every schema change in the last 12 months" cannot be answered confidently from the repo alone.

**Fix:** Document the required pgAudit settings in `docs/PRODUCTION_DEPLOYMENT.md` (to be created):

```
pgaudit.log = 'ddl, role, write'
pgaudit.log_relation = on
pgaudit.log_statement_once = on
```

Plus a deployment checklist item: verify these settings in Supabase Dashboard before customer onboarding.

**Recommended severity action:** Phase 8 self-host package. Add now to the post-Phase-3 doc backlog.

---

#### H-6 — Publishable key committed to git via smoke specs

**Files:** `app/tests/smoke/financial-*.spec.ts` (all 5) — fallback string `'sb_publishable_M_cBRZKdJtIunGAUFBhD1g_SYMADNyT'`.

**Issue:** Even though `sb_publishable_*` keys are designed to be public-facing (they enforce RLS), committing one to a git history makes it a stable identifier for the project. An attacker who finds the public repo can:

1. Identify the Supabase project URL (`tmngfuonanizxyffrsjy.supabase.co` — also in repo).
2. Use the publishable key to call public Edge Functions (e.g., the `--no-verify-jwt` ones).
3. Attempt to discover RLS policies by trying signed-up auth (see H-1).
4. Burn rate-limit or quota on Supabase project.

**The 1g.6 DECISIONS entry already flags this:** "§6.5 hygiene fix (drop the publishable-key fallback below) is tracked as a separate follow-up commit." So the issue is documented; the fix is deferred.

**Fix:** Per the §6.5 hygiene plan: drop the fallback, require `VITE_SUPABASE_*` env vars to be set (test runner errors if missing). The publishable key can rotate via the Supabase Dashboard at any time.

**Recommended severity action:** Cheap fix; do as part of the security-smoke pass commit. ~10 minutes' work across 5 specs.

---

#### H-7 — Frontend `loadFirmContext` re-reads role from `public.users`, bypassing JWT

**File:** `app/src/hooks/useAuth.ts:43-66`

**Issue:** After successful auth, the client re-fetches `firm_id` and `role` directly from `public.users` rather than reading from the JWT claims. This means:

1. The client trusts the public.users row, not the JWT.
2. If C-1 is exploited (user mutates their own role), the client sees the new role immediately — no JWT refresh needed.
3. The defence-in-depth that "even if RLS lets you mutate, the JWT carries the real role" is undone.

**Fix:** Read role from JWT instead:

```ts
async function loadFirmContext() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) { setLoading(false); return }
  // Trust the JWT claims, not public.users — the JWT hook is the
  // authoritative source for role + firm_id.
  const claims = session.access_token
    ? JSON.parse(atob(session.access_token.split('.')[1])) as { firm_id?: string; user_role?: string }
    : {}
  const firmId = claims.firm_id ?? null
  const role = claims.user_role ?? null
  if (!firmId || !role) { setLoading(false); return }
  // firm_name is non-sensitive; reading from public.firms is fine
  const { data: firmData } = await supabase
    .from('firms').select('name').eq('id', firmId).single()
  setFirmContext({ firmId, firmName: firmData?.name ?? '', role: role as UserRole })
  setLoading(false)
}
```

**Recommended severity action:** Land alongside the C-1 fix. Both go in the security-smoke pass commit.

---

### MEDIUM (13)

| # | Finding | File anchor |
|---|---|---|
| M-1 | `bank_accounts.current_balance` directly mutable via UPDATE — bypasses trigger contract | `00012:111` (no column-grant restriction) |
| M-2 | No CHECK constraints on enum-style columns: `transactions.transaction_type`, `demands.status`, `bank_accounts.account_type`, `service_charge_accounts.status`, `users.role`, `properties.property_type`, `works_orders.status`, `works_orders.priority`, etc. | All schema migrations |
| M-3 | `transactions` has no sign-vs-type CHECK (receipt requires amount > 0; payment requires < 0) | `00005:118-138` |
| M-4 | `payment_authorisations` has no audit-stamp coherence CHECK (`(authorised_at IS NULL) = (authorised_by IS NULL)`) | `00005:170-185` |
| M-5 | No `last_mutation_at` rate-limit column on high-stakes tables | All schema |
| M-6 | `dispatch_log.token` stored in plaintext UUID — no hashing | `00020_dispatch_engine.sql` |
| M-7 | `contractor-response` Edge Function doesn't rate-limit token attempts | `contractor-response/index.ts` |
| M-8 | CORS `*` on `dispatch-engine` — any origin can call with valid JWT | `dispatch-engine/index.ts:13` |
| M-9 | No CSP header / SRI in vite.config or deployment config | `vite.config.ts` |
| M-10 | Session token in localStorage (default Supabase behaviour) — full session takeover via XSS | `app/src/lib/supabase.ts:24-27` |
| M-11 | `_migrations` table accessible to direct DB superuser only — no application-level audit of who ran which migration | `00018_migrations_table_rls.sql` |
| M-12 | `proposed JSONB` on `payment_authorisations` is mutable post-pending — direct DB tamper | `00022` (PROD-GATE Data-integrity item 3) |
| M-13 | `time-window sanity` CHECK missing on date columns (`transactions.transaction_date`, `demands.issued_date`) | All schema (PROD-GATE Data-integrity item 4) |

#### M-1 — Detailed: `bank_accounts.current_balance` directly mutable

The `sync_bank_account_balance` trigger maintains `current_balance` from `SUM(transactions.amount)` on every transactions INSERT/UPDATE/DELETE. But the `bank_accounts_pm` RLS policy permits direct UPDATE on the column — meaning a PM can:

```sql
UPDATE bank_accounts SET current_balance = 999999.99 WHERE id = '<own>';
```

The 1h.3 completion modal uses this column as the audit-trail's `closing_balance_snapshot`. A corrupted balance survives until the next transactions trigger fires (which then overwrites). Window is small, but exploitable for a PM who wants to fake a balance at completion time.

**Fix:** Either column-level grant restriction:

```sql
REVOKE UPDATE ON bank_accounts FROM authenticated;
GRANT UPDATE (
  account_name, bank_name, sort_code_last4, account_number_last4,
  is_active, opened_date, closed_date, requires_dual_auth,
  dual_auth_threshold, last_reconciled_at, rics_designated, csv_column_map,
  notes
) ON bank_accounts TO authenticated;
```

Or a BEFORE-UPDATE trigger that rejects any change to `current_balance`:

```sql
CREATE OR REPLACE FUNCTION block_balance_writes() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.current_balance IS DISTINCT FROM OLD.current_balance THEN
    RAISE EXCEPTION 'bank_accounts.current_balance is trigger-maintained; do not write directly';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER bank_accounts_balance_immutable
  BEFORE UPDATE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION block_balance_writes();
```

The trigger approach also catches service-role-key writes (defence-in-depth). Recommend the trigger.

**Already on PROD-GATE manifest (item 8).** Audit confirms.

#### M-2 — Detailed: Enum-style columns lack CHECK constraints

The schema uses TEXT columns with enum-like values (`transaction_type`, `demand.status`, etc.) but only adds CHECK constraints for the most recent ones (`payment_authorisations.action_type`, `reconciliation_periods.status`, `suspense_items.status`, `reconciliation_audit_log.action`). Older tables rely on application-side validation only.

**Exploit:** Direct DB write with an invalid value:

```sql
INSERT INTO transactions (..., transaction_type) VALUES (..., 'arbitrary_value');
INSERT INTO demands (..., status) VALUES (..., 'totally_made_up');
```

The application's TypeScript types don't help — direct DB writes via service-role-key (or smoke specs that go straight to supabase-js) bypass the type layer.

**Impact:** Data-integrity. Reports that filter by status will silently miss rows. Audit queries become unreliable.

**Fix:** Schema-wide CHECK sweep migration. List the canonical values per column from `app/src/lib/constants.ts` and codify as DB CHECK. This is exactly what Data-integrity / auto-protect pass item 1 calls for.

**Recommended severity action:** Bundle with the security-smoke pass migration since both are pure-DDL.

---

### LOW (9)

| # | Finding | Anchor |
|---|---|---|
| L-1 | `escHtml()` in dispatch-engine doesn't strip apostrophes — minor XSS in the email HTML if a contractor name contains a single quote inside an attribute. Currently no attribute interpolation, but defensive | `dispatch-engine/index.ts:227` |
| L-2 | No `last_login` write on auth events — `users.last_login` exists but is never updated | `00003:42` |
| L-3 | `auth.users → public.users` cascade is `ON DELETE CASCADE` — deleting an auth.users row drops the public.users row but does NOT cascade to financial records (FKs reference users.id with no ON DELETE). Result: orphaned `created_by` / `reconciled_by` / `completed_by` references | `00003:34` |
| L-4 | `meetings_read` allows any firm user to read all meetings — meeting metadata visibility may need role tiering for board-only items | `00012:259-260` |
| L-5 | `firm_portal_config` has both `fpc_pm` (admin/PM full access) and `fpc_read` (any firm member reads). Director / read_only / leaseholder all see `out_of_hours_phone`, etc. By design? | `00012:234-239` |
| L-6 | `AuthGuard` checks `isAuthenticated` only — doesn't validate `firmContext` is loaded. Race condition: protected route may render briefly before context is set | `AuthGuard.tsx` |
| L-7 | No RoleGuard component — role gates are per-component (`useAuthStore(s => s.firmContext?.role)`). Easy to forget on new components | All UI |
| L-8 | Worktree `.env.local` I created during this session contains the publishable key + URL. Gitignored, but exists on filesystem. Worth a `.env.local` rotation if any worktree filesystem is ever shared | `app/.env.local` |
| L-9 | `users.role` default is `'read_only'` — if `users_admin_all` policy fails to set role on insert, default applies. Low risk (admin-controlled inserts) but worth documenting that the application MUST always set role explicitly | `00003:38` |

---

### INFO / Confirmations (5)

| # | Finding | Anchor |
|---|---|---|
| I-1 | JWT `role` claim correctly left as `authenticated` per PostgREST contract; PropOS role lives at `user_role`. Confirms DECISIONS 2026-05-07 | `00016` |
| I-2 | JWT hook is `SECURITY DEFINER` with `SET search_path = public` — correct hardening | `00015` |
| I-3 | Service-role-key never appears in frontend code or .env files; only in Supabase Edge Function secrets | confirmed via grep |
| I-4 | `_migrations` table has RLS enabled with no policies — blocks all PostgREST access correctly | `00018` |
| I-5 | All 12 PROD-GATE manifest items have grep-confirmed code anchors. Manifest is complete — see §5 | grep audit |

---

## 3. Per-domain detailed findings

### 3.1 Auth & JWT

Findings: C-1, H-1, H-3, H-7, I-1, I-2.

The JWT hook architecture is sound (read role from `public.users`, inject into JWT, use in RLS via `auth_user_role()`). The break in the chain is **C-1** — the user can mutate their own row to change role. **H-7** compounds it because the client also re-reads from `public.users` directly. Together they undo the JWT-as-source-of-truth model.

**Recommended fix sequence:**

1. C-1: column-restrict UPDATE on `users` to non-privileged columns only.
2. H-7: switch `loadFirmContext` to read from JWT.
3. H-3: lower `jwt_expiry` to 600s.
4. H-1: disable signup in production.

Together these restore the trust model: JWT is authoritative; public.users is read-only from the application; admin operations go through admin-gated RLS.

### 3.2 RLS policies

Findings: C-2, C-3, H-2, H-4, M-1.

The `FOR ALL USING` pattern dominates 00012 and 00025. **30 of 33 policies lack `WITH CHECK`.** This is the single biggest mechanical fix in the codebase.

**Recommended fix sequence:**

1. C-2: sweep migration adding `WITH CHECK` to every `FOR ALL` policy.
2. C-3: split audit-trail tables into separate SELECT/INSERT-only policies (no UPDATE/DELETE).
3. H-2: add `firm_id` predicate to `pm_messages_self`.
4. H-4: add `is_current = true` to all four leaseholder-scoped policies.
5. M-1: column-restrict UPDATE on bank_accounts OR install the trigger guard.

### 3.3 Edge Functions

Findings: M-7, M-8, L-1.

Both deployed Edge Functions are solid. `contractor-response` is correctly minimal and uses service-role only because it's an unauth endpoint. `dispatch-engine` correctly uses the caller's JWT. Token expiry is checked. Service-role-key is in Edge Function secrets, never in the codebase.

The known gap is the **financial-rules Edge Function not yet built**. Per the PROD-GATE manifest, it's the home for:
- Atomic reconciliation completion (item 7)
- Server-side enforcement of dual-auth, self-auth, role gates (item 1, 6, 10)
- Append-only audit-log INSERT path (item 6)
- Direction-gating for RICS-designation toggle (DECISIONS 2026-05-10 1g.5 forward)

Audit confirms the manifest's framing: this Edge Function is the centrepiece of the security-smoke pass.

### 3.4 Storage

Findings: C-4.

The path-prefix RLS for the three buckets is correct as far as firm isolation. **C-4** is the only meaningful gap: confidentiality is enforced at the table layer but not the storage layer. Fix is a more elaborate storage RLS that joins back to `public.documents`.

### 3.5 Schema integrity

Findings: M-2, M-3, M-4, M-5, M-6, M-12, M-13, L-2, L-3, L-9.

Older migrations (00003-00011) lean heavily on application-side validation. The recent migrations (00022-00025) correctly add CHECK constraints + cross-column invariants. **The Data-integrity / auto-protect pass entry covers most of this scope.**

The audit adds one finding NOT in that list:
- **L-3**: `auth.users → public.users` cascade is one-way. If an auth.users is deleted (rare in practice), public.users cascades but financial FKs (`created_by`, `reconciled_by`) become orphan references. Recommend NOT cascading and instead requiring soft-delete on `public.users.active = false`.

### 3.6 Frontend / build

Findings: M-9, M-10, L-1, L-6, L-7, L-8, H-6.

The frontend is largely defensive (text rendering, no `dangerouslySetInnerHTML` visible). Main gaps:

- **No CSP** in `vite.config.ts` or visible build output — XSS protection is browser-default only.
- **Session in localStorage** — Supabase default; XSS = full session takeover.
- **Per-component role gates** instead of a centralised RoleGuard — drift risk.

The build / deployment story is Phase 8 territory. Recommend: when packaging for production, the deployment doc should mandate a CSP header at the Vercel / nginx layer.

### 3.7 Demo-mode / Production-grade gate

Findings: I-5.

The 12-item manifest is grep-clean. Every flag exists at the documented anchor. The `firms.is_demo` column is in place from 00025. The exit-demo flow itself (Phase 6/7) is the natural enforcement point.

**Recommendation for the exit-demo flow when it lands:**

```bash
# Pre-flight script — runs in deployment pipeline before allowing the
# "exit demo mode" admin action to flip firms.is_demo = false.
grep -r "FORWARD: PROD-GATE" --include='*.ts' --include='*.tsx' --include='*.sql' \
  app/src supabase/migrations supabase/functions
```

If output is non-empty AND the corresponding production replacement (Edge Function, trigger, etc.) is not deployed, refuse the exit. Documented in the Demo mode toggle DECISIONS entry (2026-05-10).

---

## 4. PROD-GATE manifest verification (§I-5 detail)

`grep -r "FORWARD: PROD-GATE"` finds 16 hits across:

- 6 in `supabase/migrations/00025_reconciliation_schema.sql` (matches manifest items 4, 5, 6, 8, 11)
- 4 in `app/src/lib/reconciliation/` (parseStatement.ts × 4 — manifest items 2, 3 + the OFX/QIF stubs)
- 1 in `app/src/lib/reconciliation/auditLog.ts` (manifest item 6 — actor stamping)
- 1 in `app/src/lib/reconciliation/matchingEngine.ts` (manifest item 1 — Edge Function lift)
- 2 in `app/src/components/modules/financial/ReconciliationCompleteModal.tsx` (manifest items 4, 7)
- 2 in `app/src/components/modules/financial/ReconciliationReviewModal.tsx` (manifest items 1, 6)
- 1 in `app/src/components/modules/financial/StatementImportModal.tsx` (manifest item 2)
- 1 in `app/src/components/modules/financial/ReconciliationTab.tsx` (re-reconciliation flow)

**12 manifest items, 16 anchor hits — every manifest item is represented.** Some items have multiple anchors (the column-mapping flag appears in both `parseStatement.ts` and `StatementImportModal.tsx`, which is intentional defence-in-depth).

The manifest is **complete and grep-clean**. The Demo-mode-exit pre-flight check is unblocked from the manifest's side; the work that's outstanding is the production replacements themselves.

---

## 5. Recommendations / phased remediation

### Tier 1 — Land before any beta customer (recommended fresh-chat commit)

Single migration `00026_security_hardening.sql`:

1. **C-1**: column-grant restriction on `users` UPDATE.
2. **C-2**: `WITH CHECK` clauses on all 30 `FOR ALL` policies.
3. **C-3**: Audit-trail tables → SELECT + INSERT only RLS (no UPDATE/DELETE).
4. **M-1**: BEFORE-UPDATE trigger blocking `bank_accounts.current_balance` writes.
5. **H-2**: `firm_id` predicate on `pm_messages_self`.
6. **H-4**: `is_current = true` on all leaseholder-scoped subselects.
7. **M-3**, **M-4**: cross-column CHECK constraints on transactions + payment_authorisations.

Plus app-side change `app/src/hooks/useAuth.ts` for **H-7** (read role from JWT).

Plus config change `supabase/config.toml` for **H-1**, **H-3** (signup off, jwt_expiry = 600).

Plus smoke spec hygiene fix for **H-6** (drop publishable-key fallback).

**Estimated:** 1 commit, 1 migration, ~4-6 hours of work, ~10-15 new smokes (the Security-smoke pass scope).

### Tier 2 — Land alongside Phase 5 (leaseholder portal)

1. **C-4**: Storage RLS that honours `documents.is_confidential`.
2. **H-2**, **H-4** (re-verify under leaseholder load).
3. **L-4**, **L-5**: revisit `meetings_read` and `fpc_read` for tiered access.

### Tier 3 — Land alongside Phase 8 (self-host package)

1. **H-5**: pgAudit log config doc.
2. **M-9**: CSP at deployment layer.
3. **M-10**: optional storage of session in cookies vs localStorage (revisit if XSS surface grows).
4. **H-1**: re-verify `enable_signup = false` in production deployment template.

### Tier 4 — Land alongside Data-integrity / auto-protect pass

1. **M-2**, **M-12**, **M-13**, **M-5**, **M-6**: schema CHECK sweep + rate-limit columns + JSONB immutability + token hashing.
2. **L-3**: cascade-on-delete review + soft-delete pattern.

---

## 6. Cross-reference with existing DECISIONS forward entries

### Updates to **Security-smoke pass** scope

The 1g.6 entry enumerates 6 smokes (RLS isolation, self-auth bypass, JWT tampering, hard-delete via service role, authority limit bypass, storage scoping). This audit adds 3 specific gaps that fall under the same scope:

- **C-1 smoke**: PM/leaseholder mutates own role → asserts RLS rejects (or post-fix, asserts column-grant enforces).
- **C-2 smoke**: PM mutates `firm_id` on owned `bank_accounts` row → asserts WITH CHECK rejects.
- **C-3 smoke**: PM attempts DELETE on `reconciliation_audit_log` → asserts append-only RLS rejects.

Recommend extending the canonical scope when the pass lands.

### Updates to **Data-integrity / auto-protect pass** scope

The 1g.6 entry enumerates 8 items. This audit adds 5 specific gaps:

- **M-2**: schema-wide CHECK sweep on enum-style columns (item 1 implicit but only covers transactions; needs broader scope).
- **M-3**: sign-vs-type CHECK on `transactions` (already item 1).
- **M-6**: `dispatch_log.token` storage as hash + comparison via `crypt()` instead of plaintext.
- **L-3**: cascade behaviour audit on `auth.users → public.users` and onward to financial records.
- **C-4**: storage-vs-table RLS coherence (cross-references the Security-smoke pass).

### Updates to **Production-grade gate** manifest

No additions. The manifest is complete (§I-5).

---

## 7. Out-of-scope for this audit

Recorded for completeness so a future audit pass knows what to cover:

- **Phase 4 BSA module** — Phase 4 work; revisit when BSA records have meaningful UI exposure.
- **Phase 5 leaseholder portal** — H-2, H-4, C-4 will all become live exploits the moment this lands. Re-audit at portal commit time.
- **Phase 6 reporting** — financial-summary report's handling of `suspense_carried_forward` and `closing_balance_snapshot`. Audit once the report exists.
- **Phase 7 Inspection App integration** — cross-product trust boundary. Audit at integration commit.
- **Anthropic API integration** (`document_processing.ts`) — when built, the prompt-injection / data-extraction-pollution surface needs review.
- **Penetration testing** — recommended before first real-customer onboarding. External vendor.

---

## 8. Closing

The PoC is structurally sound — the JWT + RLS architecture is the right shape for a multi-tenant regulated-finance system. The findings here are correctable mechanical gaps, not design flaws. **The single most important takeaway**: 30 RLS policies need `WITH CHECK` clauses. That one migration closes 4 of the 4 critical findings (C-1 directly, C-2 directly, C-3 partially, and removes the cross-firm primitive that several other findings depend on).

Tier 1 represents about a day's focused work and lands the system at a "safe to demo to a regulated customer" baseline. Tiers 2-4 are scheduled alongside their natural Phase boundaries.

This audit should be the first reference document for the **security-smoke pass commit** when it lands.

— Audit complete. 2026-05-10.
