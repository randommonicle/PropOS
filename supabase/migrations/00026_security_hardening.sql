-- Migration: 00026_security_hardening
-- Tier-1 security hardening per docs/SECURITY_AUDIT_2026-05-10.md §5.
-- Closes critical findings C-1, C-2, C-3 (C-4 deferred to Phase 5 leaseholder
-- portal commit). Closes high findings H-2, H-4. Closes medium findings M-1,
-- M-3, M-4. App-side companion: app/src/hooks/useAuth.ts (H-7) +
-- supabase/config.toml (H-1, H-3).
--
-- Cross-references:
--   - DECISIONS 2026-05-10 — Tier-1 security hardening (commit 1i.1).
--   - DECISIONS 2026-05-10 — Security-smoke pass (canonical scope).
--   - DECISIONS 2026-05-10 — Production-grade gate (FORWARD: PROD-GATE
--     convention; this migration plants no new flags as it CLOSES rather
--     than DEFERS, except C-4 below).
--
-- Fixup: 00027_fix_m1_trigger_recursion.sql replaces the M-1 trigger
-- function below with a pg_trigger_depth()-aware version after the smoke
-- suite caught the trigger blocking the legitimate sync_bank_account_balance
-- nested write. Both migrations are required to land the M-1 fix.

-- ════════════════════════════════════════════════════════════════════════════
-- C-1 — users_update_self permits role + firm_id self-mutation (CRITICAL)
-- ════════════════════════════════════════════════════════════════════════════
-- Audit §C-1. Column-grant approach (most defensive: anything new added later
-- is denied by default). The WITH CHECK predicate also locks the row's id
-- to auth.uid() so the policy is correct even if a future GRANT widens.

REVOKE UPDATE ON public.users FROM authenticated;
GRANT  UPDATE (full_name, phone) ON public.users TO authenticated;

DROP POLICY IF EXISTS users_update_self ON public.users;
CREATE POLICY users_update_self ON public.users
  FOR UPDATE
  USING      (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- ════════════════════════════════════════════════════════════════════════════
-- C-2 — All FOR ALL USING policies missing WITH CHECK (CRITICAL)
-- ════════════════════════════════════════════════════════════════════════════
-- Audit §C-2. Mechanical sweep: drop + recreate every FOR ALL policy with
-- paired WITH CHECK matching the USING predicate. Closes the cross-firm
-- firm_id mutation primitive.

-- 00012 sweep (28 policies; payment_auth_pm, dispatch_log_pm, gt_audit_pm
-- are NOT here because §C-3 splits them into per-action policies below).

DROP POLICY IF EXISTS users_admin_all ON public.users;
CREATE POLICY users_admin_all ON public.users
  FOR ALL
  USING      (firm_id = auth_firm_id() AND auth_user_role() = 'admin')
  WITH CHECK (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

DROP POLICY IF EXISTS leaseholders_pm_all ON public.leaseholders;
CREATE POLICY leaseholders_pm_all ON public.leaseholders
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS apportionment_schedules_pm ON public.apportionment_schedules;
CREATE POLICY apportionment_schedules_pm ON public.apportionment_schedules
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS apportionment_items_pm ON public.apportionment_items;
CREATE POLICY apportionment_items_pm ON public.apportionment_items
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS bank_accounts_pm ON public.bank_accounts;
CREATE POLICY bank_accounts_pm ON public.bank_accounts
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS sca_pm ON public.service_charge_accounts;
CREATE POLICY sca_pm ON public.service_charge_accounts
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS budget_pm ON public.budget_line_items;
CREATE POLICY budget_pm ON public.budget_line_items
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS transactions_pm ON public.transactions;
CREATE POLICY transactions_pm ON public.transactions
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS invoices_pm ON public.invoices;
CREATE POLICY invoices_pm ON public.invoices
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS bsi_pm ON public.bank_statement_imports;
CREATE POLICY bsi_pm ON public.bank_statement_imports
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS demands_pm ON public.demands;
CREATE POLICY demands_pm ON public.demands
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS compliance_pm ON public.compliance_items;
CREATE POLICY compliance_pm ON public.compliance_items
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS insurance_pm ON public.insurance_policies;
CREATE POLICY insurance_pm ON public.insurance_policies
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS documents_pm ON public.documents;
CREATE POLICY documents_pm ON public.documents
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS contractors_pm ON public.contractors;
CREATE POLICY contractors_pm ON public.contractors
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS works_orders_pm ON public.works_orders;
CREATE POLICY works_orders_pm ON public.works_orders
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS s20_pm ON public.section20_consultations;
CREATE POLICY s20_pm ON public.section20_consultations
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS s20_obs_pm ON public.section20_observations;
CREATE POLICY s20_obs_pm ON public.section20_observations
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS buildings_bsa_pm ON public.buildings_bsa;
CREATE POLICY buildings_bsa_pm ON public.buildings_bsa
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS bsa_occurrences_pm ON public.bsa_mandatory_occurrences;
CREATE POLICY bsa_occurrences_pm ON public.bsa_mandatory_occurrences
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS fpc_pm ON public.firm_portal_config;
CREATE POLICY fpc_pm ON public.firm_portal_config
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS mr_pm ON public.maintenance_requests;
CREATE POLICY mr_pm ON public.maintenance_requests
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS pm_messages_pm ON public.portal_messages;
CREATE POLICY pm_messages_pm ON public.portal_messages
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS meetings_pm ON public.meetings;
CREATE POLICY meetings_pm ON public.meetings
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS fic_pm ON public.firm_inspection_config;
CREATE POLICY fic_pm ON public.firm_inspection_config
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS irl_pm ON public.inspection_report_links;
CREATE POLICY irl_pm ON public.inspection_report_links
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

-- mr_leaseholder is also FOR ALL — recreated under H-4 below with the
-- additional is_current = true filter.

-- 00025 sweep (2 policies; recaudit_pm split below in §C-3).

DROP POLICY IF EXISTS suspense_pm ON public.suspense_items;
CREATE POLICY suspense_pm ON public.suspense_items
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS recperiod_pm ON public.reconciliation_periods;
CREATE POLICY recperiod_pm ON public.reconciliation_periods
  FOR ALL
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

-- ════════════════════════════════════════════════════════════════════════════
-- C-3 — Audit-trail tables permit DELETE (CRITICAL)
-- ════════════════════════════════════════════════════════════════════════════
-- Audit §C-3. RICS Rule 3.7 evidence trail: 6-year retention minimum.
-- reconciliation_audit_log + golden_thread_audit_log → SELECT + INSERT only
-- (no UPDATE/DELETE policy: RLS rejects both for every authenticated role).
-- dispatch_log + payment_authorisations are state-tracking too: keep UPDATE
-- (with WITH CHECK), drop DELETE.

DROP POLICY IF EXISTS recaudit_pm ON public.reconciliation_audit_log;
CREATE POLICY recaudit_select ON public.reconciliation_audit_log
  FOR SELECT USING (firm_id = auth_firm_id() AND is_pm_or_admin());
CREATE POLICY recaudit_insert ON public.reconciliation_audit_log
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS gt_audit_pm ON public.golden_thread_audit_log;
CREATE POLICY gt_audit_select ON public.golden_thread_audit_log
  FOR SELECT USING (firm_id = auth_firm_id() AND is_pm_or_admin());
CREATE POLICY gt_audit_insert ON public.golden_thread_audit_log
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS dispatch_log_pm ON public.dispatch_log;
CREATE POLICY dispatch_log_select ON public.dispatch_log
  FOR SELECT USING (firm_id = auth_firm_id() AND is_pm_or_admin());
CREATE POLICY dispatch_log_insert ON public.dispatch_log
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());
CREATE POLICY dispatch_log_update ON public.dispatch_log
  FOR UPDATE
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

DROP POLICY IF EXISTS payment_auth_pm ON public.payment_authorisations;
CREATE POLICY payment_auth_select ON public.payment_authorisations
  FOR SELECT USING (firm_id = auth_firm_id() AND is_pm_or_admin());
CREATE POLICY payment_auth_insert ON public.payment_authorisations
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());
CREATE POLICY payment_auth_update ON public.payment_authorisations
  FOR UPDATE
  USING      (firm_id = auth_firm_id() AND is_pm_or_admin())
  WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

-- ════════════════════════════════════════════════════════════════════════════
-- M-1 — bank_accounts.current_balance directly mutable (MEDIUM, but
--       defence-in-depth on the trigger contract; PROD-GATE manifest item 8)
-- ════════════════════════════════════════════════════════════════════════════
-- Audit §M-1. The sync_bank_account_balance trigger (00005:145) maintains
-- current_balance from SUM(transactions.amount). This BEFORE-UPDATE trigger
-- blocks any direct write to current_balance, so the trigger contract is
-- enforced rather than conventional. Catches service-role-key writes too.
--
-- IMPORTANT: this function is REPLACED by 00027_fix_m1_trigger_recursion.sql
-- with a pg_trigger_depth()-aware version. As written below it ALSO rejects
-- the legitimate UPDATE issued by sync_bank_account_balance — caught by the
-- smoke suite immediately after apply. Both 00026 and 00027 are required for
-- the M-1 fix to function. Left here in original form for the historical
-- record; the active definition is in 00027.

CREATE OR REPLACE FUNCTION block_balance_writes() RETURNS TRIGGER
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_balance IS DISTINCT FROM OLD.current_balance THEN
    RAISE EXCEPTION 'bank_accounts.current_balance is trigger-maintained; do not write directly. Use a transactions row to adjust the balance.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bank_accounts_balance_immutable
  BEFORE UPDATE ON public.bank_accounts
  FOR EACH ROW
  EXECUTE FUNCTION block_balance_writes();

-- ════════════════════════════════════════════════════════════════════════════
-- H-2 — pm_messages_self lacks firm_id predicate (HIGH)
-- ════════════════════════════════════════════════════════════════════════════
-- Audit §H-2. Cross-firm message planting: a PM at firm A inserts a row with
-- to_user_id pointing at firm B; firm B's user sees it via the lacking
-- firm_id predicate. Add the firm_id check.

DROP POLICY IF EXISTS pm_messages_self ON public.portal_messages;
CREATE POLICY pm_messages_self ON public.portal_messages
  FOR SELECT USING (
    firm_id = auth_firm_id()
    AND (from_user_id = auth.uid() OR to_user_id = auth.uid())
  );

-- ════════════════════════════════════════════════════════════════════════════
-- H-4 — leaseholder-scoped policies use stale (is_current=false) records
-- ════════════════════════════════════════════════════════════════════════════
-- Audit §H-4. Subselects on `leaseholders WHERE user_id = auth.uid()` return
-- historical leaseholder records too. Add `is_current = true` filter to all
-- four leaseholder-scoped policies.

DROP POLICY IF EXISTS documents_leaseholder_select ON public.documents;
CREATE POLICY documents_leaseholder_select ON public.documents
  FOR SELECT USING (
    firm_id = auth_firm_id()
    AND auth_user_role() = 'leaseholder'
    AND is_confidential = false
    AND property_id IN (
      SELECT property_id FROM public.leaseholders
      WHERE user_id = auth.uid() AND is_current = true
    )
  );

DROP POLICY IF EXISTS demands_leaseholder_select ON public.demands;
CREATE POLICY demands_leaseholder_select ON public.demands
  FOR SELECT USING (
    firm_id = auth_firm_id()
    AND auth_user_role() = 'leaseholder'
    AND unit_id IN (
      SELECT unit_id FROM public.leaseholders
      WHERE user_id = auth.uid() AND is_current = true
    )
  );

DROP POLICY IF EXISTS s20_leaseholder_select ON public.section20_consultations;
CREATE POLICY s20_leaseholder_select ON public.section20_consultations
  FOR SELECT USING (
    firm_id = auth_firm_id()
    AND auth_user_role() = 'leaseholder'
    AND property_id IN (
      SELECT property_id FROM public.leaseholders
      WHERE user_id = auth.uid() AND is_current = true
    )
  );

DROP POLICY IF EXISTS mr_leaseholder ON public.maintenance_requests;
CREATE POLICY mr_leaseholder ON public.maintenance_requests
  FOR ALL
  USING (
    firm_id = auth_firm_id()
    AND auth_user_role() = 'leaseholder'
    AND unit_id IN (
      SELECT unit_id FROM public.leaseholders
      WHERE user_id = auth.uid() AND is_current = true
    )
  )
  WITH CHECK (
    firm_id = auth_firm_id()
    AND auth_user_role() = 'leaseholder'
    AND unit_id IN (
      SELECT unit_id FROM public.leaseholders
      WHERE user_id = auth.uid() AND is_current = true
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- M-3 — transactions sign-vs-type integrity (MEDIUM)
-- ════════════════════════════════════════════════════════════════════════════
-- Audit §M-3. Locks in what the UI already enforces: receipt > 0, payment < 0,
-- journal != 0. Direct DB writes that violate this are now rejected.

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_sign_type_chk
  CHECK (
    (transaction_type = 'receipt' AND amount > 0)
    OR (transaction_type = 'payment' AND amount < 0)
    OR (transaction_type = 'journal' AND amount <> 0)
    OR transaction_type NOT IN ('receipt', 'payment', 'journal')
  );

-- NOTE: the final clause keeps the constraint permissive for any future
-- transaction_type values not yet enumerated; the M-2 schema-wide enum CHECK
-- sweep (Tier-4 / Data-integrity pass) will replace this with a stricter
-- form. Recorded here so the constraint doesn't silently fail on a future
-- transaction_type addition.

-- ════════════════════════════════════════════════════════════════════════════
-- M-4 — payment_authorisations audit-stamp coherence (MEDIUM)
-- ════════════════════════════════════════════════════════════════════════════
-- Audit §M-4. Structural invariant: a row with authorised_at set MUST have
-- authorised_by set, and vice versa. Same for rejected_at / rejected_by /
-- rejection_reason. Detects tampering / corruption.

ALTER TABLE public.payment_authorisations
  ADD CONSTRAINT pa_authorised_pair_chk
  CHECK ((authorised_at IS NULL) = (authorised_by IS NULL));

ALTER TABLE public.payment_authorisations
  ADD CONSTRAINT pa_rejected_triple_chk
  CHECK (
    (rejected_at IS NULL AND rejected_by IS NULL AND rejection_reason IS NULL)
    OR
    (rejected_at IS NOT NULL AND rejected_by IS NOT NULL AND rejection_reason IS NOT NULL)
  );

-- ════════════════════════════════════════════════════════════════════════════
-- C-4 — Storage RLS does not honour documents.is_confidential (CRITICAL)
-- ════════════════════════════════════════════════════════════════════════════
-- DEFERRED to Phase 5 leaseholder-portal commit. Today no leaseholder users
-- are seeded, so the exposure is theoretical. The fix requires storage.objects
-- policy that joins back to public.documents, which is best landed alongside
-- the portal UI work that introduces the first leaseholder principal.
--
-- FORWARD: PROD-GATE — replace before any leaseholder principal is seeded.
-- Reason: storage RLS at 00017_storage_rls.sql does not check
-- documents.is_confidential. Anchor: docs/SECURITY_AUDIT_2026-05-10.md §C-4.
