-- Migration: 00012_rls_policies
-- Purpose: Row-Level Security policies for all PropOS tables.
-- Every table enforces firm_id = auth.jwt()->>'firm_id'.
-- Golden Thread records have an additional block on DELETE and UPDATE.
--
-- Role-based access per Section 3.3:
--   admin | property_manager: full access to financial and all modules
--   director: read-only financial, full property/works access
--   leaseholder: own unit's data only
--   contractor: dispatch_log rows for their own jobs only
--   read_only: SELECT only on non-financial tables

-- Helper function: extract firm_id from the JWT claims
CREATE OR REPLACE FUNCTION auth_firm_id() RETURNS UUID AS $$
  SELECT (auth.jwt() ->> 'firm_id')::UUID;
$$ LANGUAGE SQL STABLE;

-- Helper function: extract user role from the JWT claims
CREATE OR REPLACE FUNCTION auth_user_role() RETURNS TEXT AS $$
  SELECT auth.jwt() ->> 'role';
$$ LANGUAGE SQL STABLE;

-- Helper: true if current user is admin or property_manager
CREATE OR REPLACE FUNCTION is_pm_or_admin() RETURNS BOOLEAN AS $$
  SELECT auth_user_role() IN ('admin', 'property_manager');
$$ LANGUAGE SQL STABLE;

-- ─────────────────────────────────────────────────────────────────────────────
-- firms
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE firms ENABLE ROW LEVEL SECURITY;

CREATE POLICY firms_select ON firms
  FOR SELECT USING (id = auth_firm_id());

CREATE POLICY firms_update ON firms
  FOR UPDATE USING (id = auth_firm_id() AND auth_user_role() = 'admin');

-- ─────────────────────────────────────────────────────────────────────────────
-- users
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select ON users
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY users_update_self ON users
  FOR UPDATE USING (id = auth.uid());

CREATE POLICY users_admin_all ON users
  FOR ALL USING (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

-- ─────────────────────────────────────────────────────────────────────────────
-- properties
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

CREATE POLICY properties_select ON properties
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY properties_insert ON properties
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY properties_update ON properties
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY properties_delete ON properties
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

-- ─────────────────────────────────────────────────────────────────────────────
-- units
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE units ENABLE ROW LEVEL SECURITY;

CREATE POLICY units_select ON units
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY units_insert ON units
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY units_update ON units
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- leaseholders
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE leaseholders ENABLE ROW LEVEL SECURITY;

CREATE POLICY leaseholders_pm_all ON leaseholders
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

-- Leaseholders see only their own record
CREATE POLICY leaseholders_self_select ON leaseholders
  FOR SELECT USING (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- apportionment tables
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE apportionment_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY apportionment_schedules_pm ON apportionment_schedules
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

ALTER TABLE apportionment_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY apportionment_items_pm ON apportionment_items
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- Financial tables — admin and property_manager only
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_accounts_pm ON bank_accounts
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

ALTER TABLE service_charge_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY sca_pm ON service_charge_accounts
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

ALTER TABLE budget_line_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY budget_pm ON budget_line_items
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY transactions_pm ON transactions
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

ALTER TABLE payment_authorisations ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_auth_pm ON payment_authorisations
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_pm ON invoices
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

ALTER TABLE bank_statement_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY bsi_pm ON bank_statement_imports
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

-- Leaseholders can view their own demands
ALTER TABLE demands ENABLE ROW LEVEL SECURITY;
CREATE POLICY demands_pm ON demands
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());
CREATE POLICY demands_leaseholder_select ON demands
  FOR SELECT USING (
    firm_id = auth_firm_id() AND
    auth_user_role() = 'leaseholder' AND
    unit_id IN (SELECT unit_id FROM leaseholders WHERE user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- compliance_items
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE compliance_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY compliance_pm ON compliance_items
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());
CREATE POLICY compliance_director_select ON compliance_items
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_user_role() IN ('director', 'read_only'));

ALTER TABLE insurance_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY insurance_pm ON insurance_policies
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- documents
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY documents_pm ON documents
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());
-- Leaseholders see non-confidential docs for their property
CREATE POLICY documents_leaseholder_select ON documents
  FOR SELECT USING (
    firm_id = auth_firm_id() AND
    auth_user_role() = 'leaseholder' AND
    is_confidential = false AND
    property_id IN (
      SELECT p.property_id FROM leaseholders p WHERE p.user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- contractors / works
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE contractors ENABLE ROW LEVEL SECURITY;
CREATE POLICY contractors_pm ON contractors
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

ALTER TABLE works_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY works_orders_pm ON works_orders
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

ALTER TABLE dispatch_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY dispatch_log_pm ON dispatch_log
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

ALTER TABLE section20_consultations ENABLE ROW LEVEL SECURITY;
CREATE POLICY s20_pm ON section20_consultations
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());
-- Leaseholders can read S20 consultations for their property
CREATE POLICY s20_leaseholder_select ON section20_consultations
  FOR SELECT USING (
    firm_id = auth_firm_id() AND auth_user_role() = 'leaseholder' AND
    property_id IN (SELECT property_id FROM leaseholders WHERE user_id = auth.uid())
  );

ALTER TABLE section20_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY s20_obs_pm ON section20_observations
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- BSA module
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE buildings_bsa ENABLE ROW LEVEL SECURITY;
CREATE POLICY buildings_bsa_pm ON buildings_bsa
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

-- GOLDEN THREAD: SELECT and INSERT only. UPDATE and DELETE are BLOCKED for everyone.
ALTER TABLE golden_thread_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY gt_select ON golden_thread_records
  FOR SELECT USING (firm_id = auth_firm_id());
CREATE POLICY gt_insert ON golden_thread_records
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());
-- Explicitly no UPDATE or DELETE policies — they will be rejected by RLS.

ALTER TABLE golden_thread_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY gt_audit_pm ON golden_thread_audit_log
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

ALTER TABLE bsa_mandatory_occurrences ENABLE ROW LEVEL SECURITY;
CREATE POLICY bsa_occurrences_pm ON bsa_mandatory_occurrences
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- Portal / comms
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE firm_portal_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY fpc_pm ON firm_portal_config
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());
-- All firm users can read portal config (needed to display out-of-hours info)
CREATE POLICY fpc_read ON firm_portal_config
  FOR SELECT USING (firm_id = auth_firm_id());

ALTER TABLE maintenance_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY mr_pm ON maintenance_requests
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());
CREATE POLICY mr_leaseholder ON maintenance_requests
  FOR ALL USING (
    firm_id = auth_firm_id() AND auth_user_role() = 'leaseholder' AND
    unit_id IN (SELECT unit_id FROM leaseholders WHERE user_id = auth.uid())
  );

ALTER TABLE portal_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY pm_messages_pm ON portal_messages
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());
CREATE POLICY pm_messages_self ON portal_messages
  FOR SELECT USING (from_user_id = auth.uid() OR to_user_id = auth.uid());

ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
CREATE POLICY meetings_pm ON meetings
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());
CREATE POLICY meetings_read ON meetings
  FOR SELECT USING (firm_id = auth_firm_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- Inspection App config
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE firm_inspection_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY fic_pm ON firm_inspection_config
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

ALTER TABLE inspection_report_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY irl_pm ON inspection_report_links
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());
