-- Migration: 00032_documents_compliance_emergency_interested_s153
-- Purpose: 1i.6 Phase 4 entry — data-model backfill commit 2 covering gaps G5/G6/G16/G17/G19/G26.
--   G5  documents:            categorisation tightening + sales-pack flags.
--   G6  compliance_items:     item_type CHECK + lpe_relevant + certificate_document_id FK.
--   G16 emergency_contacts:   new unit-scoped table (Blockman parity — Unit Details → Emergency Contacts).
--   G17 interested_parties:   new property/unit-scoped table (mortgagees, attorneys, executors, etc.).
--   G19 demands.s.153:        per-demand CLRA 2002 s.153 compliance flag + trigger gate on 'issued'.
--   G26 leaseholders verify:  read-only — versioning surface already adequate (no migration).
--
-- This is a SCHEMA-ONLY migration. Existing rows in `documents` / `compliance_items` are
-- backfilled to safe enum values before CHECK constraints land (idempotent UPDATEs).
--
-- Statutory anchors:
--   CLRA 2002 s.153            — landlord's name + address service requirement (enforceability gate
--                                 for demands; trigger blocks 'issued' state without compliance flag).
--   LTA 1985 ss.18-30          — service-charge documentation regime (G5/G6 categorisation supports
--                                 LPE-pack assembly per Phase 4c).
--   LTA 1987 ss.47-48          — landlord name + address on demands (the s.47 / s.48 fields are
--                                 sourced from landlords table — see migration 00031).
--   BSA 2022 s.78 / Reg 6      — golden-thread document categorisation for HRBs (G5 enum includes
--                                 'building_safety_case' / 'golden_thread' for Phase 4 BSA module).
--   RICS Service Charge        — Residential Code 4th ed., evidence retention requirements.
--   UK GDPR Art. 30            — records of processing; emergency_contacts.gdpr_consent_note pins
--                                 consent provenance per contact.
--
-- Forward anchors (do not implement here):
--   FORWARD: demo-seed commit — drop legacy units.{lease_start,lease_end,lease_term_years,
--     ground_rent_pa,ground_rent_review_date} (5 cols, 00004 lines 46-50) + properties.{
--     freeholder_name,freeholder_contact} (2 cols, 00004 lines 17-18); promote
--     properties.landlord_id to NOT NULL once seed data populated.
--   FORWARD: data-integrity / auto-protect pass (Phase 5) —
--     - interested_parties.legal_reference encrypt-at-rest (mortgage acct numbers; PII).
--     - emergency_contacts: encrypt-at-rest for phone+email if data-integrity sweep deems necessary.
--     - compliance_items: add next_due_date / frequency_interval / responsible_party /
--       last_inspection_date columns (deferred from 1i.6 per locked-plan scope).
--   FORWARD: Phase 4c LPE pack generator — consumes documents.{include_in_sales_pack,
--     lpe_category} + compliance_items.{lpe_relevant,certificate_document_id} for pack
--     assembly. Also consumes interested_parties for s.146 / forfeiture mortgagee service.
--   FORWARD: Phase 4a collection workflow — consumes demands.section_153_compliant as
--     a gate on the notice_stage state machine (pre_action → solicitor_referred path).
--   FORWARD: 1i.6 smoke leaseholder self-read on emergency_contacts — .fixme'd in
--     1i6-rls.spec.ts pending a leaseholder fixture user.

-- ═════════════════════════════════════════════════════════════════════════════
-- G5 — documents: categorisation tightening + sales-pack flags
-- ═════════════════════════════════════════════════════════════════════════════
-- documents.document_type currently free-form TEXT NOT NULL (00007 line 12).
-- Strategy: union the existing 12-value comment-enum with the 11 new LPE/BSA-relevant
-- values, then CHECK-constrain. Existing rows backfilled to 'general' if non-conforming.
-- Postgres ENUMs deliberately avoided: ALTER TYPE ADD VALUE is non-transactional and
-- couples schema iteration speed to deploy cadence. CHECK is the established pattern.

ALTER TABLE documents
  ADD COLUMN include_in_sales_pack BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN lpe_category          TEXT,
  ADD COLUMN fme_category          TEXT;

-- Backfill any free-form rows to a safe bucket before CHECK lands.
UPDATE documents
   SET document_type = 'general'
 WHERE document_type NOT IN (
    -- Existing values (00007 comment-enum):
    'lease','certificate','insurance','invoice','report','notice','correspondence',
    'minutes','plans','golden_thread','compliance','other','general',
    -- New 1i.6 values (LPE/BSA/compliance-aware):
    'gas_safety','electrical_eicr','lift_loler','fra','ews1','asbestos_register',
    'accounts_audited','accounts_draft','budget','insurance_schedule','insurance_summary',
    's20_intent','s20_estimates','s20_award','health_safety','building_safety_case',
    'energy_performance'
 );

ALTER TABLE documents
  ADD CONSTRAINT documents_document_type_chk
  CHECK (document_type IN (
    'lease','certificate','insurance','invoice','report','notice','correspondence',
    'minutes','plans','golden_thread','compliance','other','general',
    'gas_safety','electrical_eicr','lift_loler','fra','ews1','asbestos_register',
    'accounts_audited','accounts_draft','budget','insurance_schedule','insurance_summary',
    's20_intent','s20_estimates','s20_award','health_safety','building_safety_case',
    'energy_performance'
  ));

-- lpe_category — populated by PM when staging a doc for LPE-pack inclusion (Phase 4c).
ALTER TABLE documents
  ADD CONSTRAINT documents_lpe_category_chk
  CHECK (lpe_category IS NULL OR lpe_category IN (
    'lease','accounts','budget','demands','insurance','compliance',
    's20_consultations','planned_works','bsa','other'
  ));

-- fme_category — populated by PM when staging a doc for FME-pack inclusion (Phase 4d).
ALTER TABLE documents
  ADD CONSTRAINT documents_fme_category_chk
  CHECK (fme_category IS NULL OR fme_category IN (
    'estate_assets','restrictive_covenants','rentcharge_deed',
    'public_liability','accounts','budget','other'
  ));

CREATE INDEX idx_documents_include_in_sales_pack
  ON documents(property_id) WHERE include_in_sales_pack;
CREATE INDEX idx_documents_lpe_category
  ON documents(property_id, lpe_category) WHERE lpe_category IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- G6 — compliance_items: item_type CHECK + LPE/certificate fields
-- ═════════════════════════════════════════════════════════════════════════════
-- compliance_items.item_type currently free-form TEXT NOT NULL (00006 line 11).
-- compliance_items.document_id already exists (FK to documents, 00007 line 39) — kept
-- as the generic doc link. New certificate_document_id is the canonical compliance
-- certificate (separate semantic — a record may have a record-of-action doc AND a cert).

ALTER TABLE compliance_items
  ADD COLUMN lpe_relevant             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN certificate_document_id  UUID REFERENCES documents(id);

-- Backfill non-conforming item_type to 'other' before CHECK lands.
UPDATE compliance_items
   SET item_type = 'other'
 WHERE item_type NOT IN (
    'eicr','fra','gas_safety','asbestos_management','asbestos_refurb',
    'lift_thorough','lift_service','insurance','health_safety','water_hygiene',
    'legionella','pat_testing','fire_suppression','emergency_lighting',
    'planning','building_regs','other'
 );

ALTER TABLE compliance_items
  ADD CONSTRAINT compliance_items_item_type_chk
  CHECK (item_type IN (
    'eicr','fra','gas_safety','asbestos_management','asbestos_refurb',
    'lift_thorough','lift_service','insurance','health_safety','water_hygiene',
    'legionella','pat_testing','fire_suppression','emergency_lighting',
    'planning','building_regs','other'
  ));

-- Backfill lpe_relevant for the LPE-pack-relevant compliance categories.
-- Source: standard LPE2 enquiries section — gas + electrical + lift + asbestos + fire.
UPDATE compliance_items
   SET lpe_relevant = true
 WHERE item_type IN (
    'gas_safety','eicr','lift_thorough','asbestos_management','asbestos_refurb','fra'
 );

CREATE INDEX idx_compliance_items_lpe_relevant
  ON compliance_items(property_id) WHERE lpe_relevant;
CREATE INDEX idx_compliance_items_certificate_document_id
  ON compliance_items(certificate_document_id) WHERE certificate_document_id IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- G16 — emergency_contacts (new table)
-- ═════════════════════════════════════════════════════════════════════════════
-- Blockman parity (screenshot 2026-05-11, Unit Details → Emergency Contacts):
--   Name | Contact Type | Phone | Email | Notes | GDPR Consent Note + "Add New" button.
-- Unit-anchored (hangs off Unit Details sub-nav); property_id denormalised for RLS / idx.

CREATE TABLE emergency_contacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             UUID NOT NULL REFERENCES firms(id),
  unit_id             UUID NOT NULL REFERENCES units(id),
  property_id         UUID NOT NULL REFERENCES properties(id),
  name                TEXT NOT NULL,
  contact_type        TEXT NOT NULL,
  -- key_holder | next_of_kin | attorney | resident_carer | utility_isolator | other
  relationship        TEXT,
  phone               TEXT,
  email               TEXT,
  notes               TEXT,
  gdpr_consent_note   TEXT,
  -- UK GDPR Art. 30 — records of processing. Captures consent provenance:
  -- "verbal consent from leaseholder Mr Perez 2025-11-01" or similar.
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT emergency_contacts_contact_type_chk
    CHECK (contact_type IN (
      'key_holder','next_of_kin','attorney','resident_carer','utility_isolator','other'
    )),
  CONSTRAINT emergency_contacts_contact_present_chk
    CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE TRIGGER emergency_contacts_updated_at
  BEFORE UPDATE ON emergency_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_emergency_contacts_firm_id ON emergency_contacts(firm_id);
CREATE INDEX idx_emergency_contacts_unit_id ON emergency_contacts(unit_id);
CREATE INDEX idx_emergency_contacts_property_id ON emergency_contacts(property_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- G17 — interested_parties (new table)
-- ═════════════════════════════════════════════════════════════════════════════
-- LPE-relevant (solicitors enquire about registered charges) AND forfeiture-relevant
-- (CLRA 2002 / pre-action protocol requires serving mortgagee before s.146 forfeiture).
-- effective_from / effective_to support historical view (Blockman shows current-only
-- UI initially per 2026-05-11 audit; schema supports historical view without migration).

CREATE TABLE interested_parties (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firms(id),
  property_id     UUID NOT NULL REFERENCES properties(id),
  unit_id         UUID REFERENCES units(id),  -- NULL = property-wide party
  party_type      TEXT NOT NULL,
  -- mortgagee | attorney | executor | assignee | chargee | other
  name            TEXT NOT NULL,
  address         TEXT,
  contact_phone   TEXT,
  contact_email   TEXT,
  legal_reference TEXT,
  -- e.g. mortgage account number, charge number. PLAINTEXT for now —
  -- FORWARD: encrypt-at-rest in data-integrity pass alongside contractors.bank_account_*
  -- and management_companies.ch_filing_credentials_*.
  effective_from  DATE,
  effective_to    DATE,  -- NULL = currently effective
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT interested_parties_party_type_chk
    CHECK (party_type IN ('mortgagee','attorney','executor','assignee','chargee','other')),
  CONSTRAINT interested_parties_effective_window_chk
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

CREATE TRIGGER interested_parties_updated_at
  BEFORE UPDATE ON interested_parties
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_interested_parties_firm_id ON interested_parties(firm_id);
CREATE INDEX idx_interested_parties_property_id ON interested_parties(property_id);
CREATE INDEX idx_interested_parties_unit_id ON interested_parties(unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX idx_interested_parties_current ON interested_parties(property_id) WHERE effective_to IS NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- G19 — demands.section_153_compliant + enforcement trigger
-- ═════════════════════════════════════════════════════════════════════════════
-- CLRA 2002 s.153: a demand for service charge or admin charge is unenforceable unless
-- it is accompanied by a notice containing the landlord's name and address. This flag
-- asserts the prescribed s.47 / s.48 lines were composed onto the demand at issue.
-- Trigger checks landlords.section_153_required (added in 00031 line 51) — most landlords
-- require it; rare exemptions (e.g. Welsh peppercorn estates) can opt out at landlord level.

ALTER TABLE demands
  ADD COLUMN section_153_compliant BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION enforce_section_153_on_issue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_landlord_id UUID;
  v_required    BOOLEAN;
BEGIN
  -- Fires only on transition INTO 'issued' (INSERT with status='issued', or UPDATE that
  -- changes status from non-issued to 'issued'). Existing issued demands are unaffected
  -- by UPDATEs that don't change status — by design.
  IF NEW.status = 'issued' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'issued') THEN
    SELECT p.landlord_id INTO v_landlord_id
      FROM public.properties p
     WHERE p.id = NEW.property_id;

    IF v_landlord_id IS NULL THEN
      -- No landlord linked yet (pre-seed state — FORWARD anchor in 00031 promotes
      -- properties.landlord_id to NOT NULL after demo seed). Conservative default:
      -- require s.153 compliance until a landlord exemption can be looked up.
      v_required := true;
    ELSE
      SELECT section_153_required INTO v_required
        FROM public.landlords WHERE id = v_landlord_id;
      -- Defensive: if landlord row missing (shouldn't happen with FK in place), require.
      IF v_required IS NULL THEN v_required := true; END IF;
    END IF;

    IF v_required AND NOT NEW.section_153_compliant THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',  -- check_violation — matches the CHECK-failure pattern surfaced to PostgREST
        MESSAGE = 'CLRA 2002 s.153: cannot issue demand without landlord-name+address service compliance (set section_153_compliant=true)',
        HINT    = 'Compose the s.47 / s.48 lines onto the demand and set section_153_compliant=true before transitioning status to ''issued''.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION enforce_section_153_on_issue() FROM PUBLIC;
-- Function is invoked by trigger only; no direct callers needed.

CREATE TRIGGER demands_enforce_section_153
  BEFORE INSERT OR UPDATE OF status, section_153_compliant ON demands
  FOR EACH ROW EXECUTE FUNCTION enforce_section_153_on_issue();

-- ═════════════════════════════════════════════════════════════════════════════
-- G26 — leaseholders previous-owners verification (read-only; no migration)
-- ═════════════════════════════════════════════════════════════════════════════
-- Verified at 1i.6 time: leaseholders table (00004 lines 109-129) already exposes:
--   is_current BOOLEAN  — distinguishes prior owners from current
--   from_date  DATE     — ownership start
--   to_date    DATE     — ownership end (NULL = current)
-- The Blockman "Previous Owners (1)" badge maps to `leaseholders WHERE NOT is_current
-- AND unit_id = $unit`. No new columns / table needed. UI surface for previous owners
-- lands as a UI-only commit (no schema change).

-- ═════════════════════════════════════════════════════════════════════════════
-- RLS — mirror standard pattern from 00012 / 00031:
--   firm-scoped SELECT; PM-tier writes (is_pm_or_admin); admin-only DELETE.
--   Leaseholder self-read on emergency_contacts mirrors the 00026 H-4 pattern
--   (subselect on leaseholders WHERE user_id=auth.uid() AND is_current=true).
--   No leaseholder read on interested_parties — legal-grade data; staff-only.
-- ═════════════════════════════════════════════════════════════════════════════

-- emergency_contacts
ALTER TABLE emergency_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY emergency_contacts_select ON emergency_contacts
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY emergency_contacts_leaseholder_select ON emergency_contacts
  FOR SELECT USING (
    firm_id = auth_firm_id()
    AND auth_user_role() = 'leaseholder'
    AND unit_id IN (
      SELECT unit_id FROM public.leaseholders
       WHERE user_id = auth.uid() AND is_current = true
    )
  );
-- Note: PostgreSQL combines multiple permissive SELECT policies with OR. Staff (admin/pm/
-- senior_pm/director/accounts/auditor) reach rows via emergency_contacts_select; a
-- leaseholder authenticated user reaches own-unit rows via emergency_contacts_leaseholder_select.

CREATE POLICY emergency_contacts_insert ON emergency_contacts
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY emergency_contacts_update ON emergency_contacts
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY emergency_contacts_delete ON emergency_contacts
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

-- interested_parties
ALTER TABLE interested_parties ENABLE ROW LEVEL SECURITY;

CREATE POLICY interested_parties_select ON interested_parties
  FOR SELECT USING (firm_id = auth_firm_id());
-- Deliberately NO leaseholder_select policy — mortgagee / executor / chargee records
-- are legal-grade data exposed only to staff (incl. auditor for regulatory review).

CREATE POLICY interested_parties_insert ON interested_parties
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY interested_parties_update ON interested_parties
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY interested_parties_delete ON interested_parties
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run immediately after migration; paste results back)
-- Memory rule: migration plan must include the verification query (state-test,
-- distinct from runtime smokes).
-- ═════════════════════════════════════════════════════════════════════════════

-- Q1: G5 — documents column additions + CHECK constraints present
--   expect 3 columns + 3 constraints
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'documents'
--    AND column_name IN ('include_in_sales_pack','lpe_category','fme_category')
--  ORDER BY column_name;
--
-- SELECT conname FROM pg_constraint
--  WHERE conrelid = 'public.documents'::regclass
--    AND conname IN ('documents_document_type_chk','documents_lpe_category_chk','documents_fme_category_chk')
--  ORDER BY conname;

-- Q2: G6 — compliance_items column additions + CHECK + backfill counts
--   expect 2 columns + 1 constraint + lpe_relevant distribution
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'compliance_items'
--    AND column_name IN ('lpe_relevant','certificate_document_id')
--  ORDER BY column_name;
--
-- SELECT conname FROM pg_constraint
--  WHERE conrelid = 'public.compliance_items'::regclass
--    AND conname = 'compliance_items_item_type_chk';
--
-- SELECT lpe_relevant, COUNT(*) FROM compliance_items GROUP BY lpe_relevant ORDER BY lpe_relevant;

-- Q3: G16 + G17 — new tables exist with RLS enabled + policy counts
--   expect 2 rows rowsecurity=true; ≥4 policies on emergency_contacts; 4 on interested_parties
-- SELECT tablename, rowsecurity FROM pg_tables
--  WHERE schemaname = 'public'
--    AND tablename IN ('emergency_contacts','interested_parties')
--  ORDER BY tablename;
--
-- SELECT tablename, COUNT(*) AS policy_count FROM pg_policies
--  WHERE tablename IN ('emergency_contacts','interested_parties')
--  GROUP BY tablename ORDER BY tablename;

-- Q4: G19 — column + trigger + function present
--   expect 1 column, 1 trigger, 1 function
-- SELECT column_name, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'demands'
--    AND column_name = 'section_153_compliant';
--
-- SELECT tgname, tgenabled FROM pg_trigger
--  WHERE tgname = 'demands_enforce_section_153'
--    AND tgrelid = 'public.demands'::regclass;
--
-- SELECT proname, prosecdef FROM pg_proc
--  WHERE proname = 'enforce_section_153_on_issue';

-- Q5: G26 — leaseholders versioning surface present (read-only verify, no migration)
--   expect 3 rows: is_current / from_date / to_date
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'leaseholders'
--    AND column_name IN ('is_current','from_date','to_date')
--  ORDER BY column_name;
