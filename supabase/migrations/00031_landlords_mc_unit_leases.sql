-- Migration: 00031_landlords_mc_unit_leases
-- Purpose: 1i.5 Phase 4 entry — data-model backfill for gaps G1-G4.
--   G1 landlords: first-class entity (previously implicit via properties.freeholder_name).
--   G2 management_companies: RMC / RTM model.
--   G2 management_company_directors: structured director junction (Blockman-parity per 2026-05-11 audit).
--   G3 unit_leases: structured lease metadata per unit (versioned via supersedes_lease_id).
--   G4 ground rent schedule: nested in unit_leases (separate table deferred unless complexity warrants).
--
-- This is a SCHEMA-ONLY migration. Pre-check counts (2026-05-11) confirmed:
--   - 0 rows in properties with non-empty freeholder_name
--   - 0 rows in units with lease or ground rent data
-- ⇒ No data backfill INSERTs. Demo seed of landlord / lease data lands as a follow-up commit.
--
-- Statutory anchors:
--   LTA 1987 s.47(1)  — landlord name + address on demands.
--   LTA 1987 s.48(1)  — address for service of notices.
--   CLRA 2002 s.153   — landlord's name + address service requirement (enforceability gate).
--
-- Forward anchors (do not implement here):
--   FORWARD: 1i.6 (migration 00032) — drop legacy units.{lease_start,lease_end,lease_term_years,
--     ground_rent_pa,ground_rent_review_date,ground_rent_review_basis} after backfill exercised by UI;
--     drop properties.{freeholder_name,freeholder_contact}. Promote properties.landlord_id to NOT NULL
--     once seed data populated.
--   FORWARD: Phase 4c LPE pack generator — consumes landlords.section_47_* / section_48_address
--     and management_companies for pack header + s.47/s.48 compliance lines.
--   FORWARD: Phase 5 G23 secretarial workflow — see commented column list at bottom of
--     management_companies CREATE TABLE.

-- ─────────────────────────────────────────────────────────────────────────────
-- G1 — landlords
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE landlords (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                       UUID NOT NULL REFERENCES firms(id),
  name                          TEXT NOT NULL,
  landlord_type                 TEXT NOT NULL,
  -- investor | rmc_owned | rtm | leaseholder_freehold | other
  companies_house_number        TEXT,
  registered_office_line1       TEXT,
  registered_office_line2       TEXT,
  registered_office_town        TEXT,
  registered_office_postcode    TEXT,
  correspondence_address        TEXT,
  contact_name                  TEXT,
  contact_email                 TEXT,
  contact_phone                 TEXT,
  -- Statutory service fields (Blockman parity audit 2026-05-11)
  section_47_name               TEXT,    -- LTA 1987 s.47(1) — name on demands; may differ from `name` (trading-as)
  section_47_address            TEXT,    -- LTA 1987 s.47(1) — landlord address on demands
  section_48_address            TEXT,    -- LTA 1987 s.48(1) — address for service of notices (often the agent)
  section_153_required          BOOLEAN NOT NULL DEFAULT true,   -- CLRA 2002 s.153
  section_153_welsh_translation BOOLEAN NOT NULL DEFAULT false,
  notes                         TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER landlords_updated_at
  BEFORE UPDATE ON landlords
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_landlords_firm_id ON landlords(firm_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- G2 — management_companies
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE management_companies (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                       UUID NOT NULL REFERENCES firms(id),
  landlord_id                   UUID REFERENCES landlords(id),
  -- Nullable: an RMC may BE the landlord (landlord_type='rmc_owned') and link via this FK,
  -- OR the MC may exist without a landlord role (e.g. resident-association without freehold).
  name                          TEXT NOT NULL,
  company_type                  TEXT NOT NULL,
  -- rmc | rtm | residents_association | other
  companies_house_number        TEXT,
  incorporation_date            DATE,
  accounts_year_end             DATE,    -- the financial year-end
  agm_due_date                  DATE,    -- next AGM due
  registered_office_line1       TEXT,
  registered_office_line2       TEXT,
  registered_office_town        TEXT,
  registered_office_postcode    TEXT,
  notes                         TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
  -- FORWARD (Phase 5 G23 — Company Secretarial workflow, per Blockman parity audit 2026-05-11):
  --   confirmation_statement_day_month TEXT       -- e.g. '25-01' (recurring day+month)
  --   board_quorum_text                TEXT
  --   agm_quorum_text                  TEXT
  --   egm_quorum_text                  TEXT
  --   produce_agm_notice               BOOLEAN
  --   min_directors                    INTEGER
  --   max_directors                    INTEGER
  --   limited_by                       TEXT       -- 'guarantee' | 'shares'
  --   governance_model                 TEXT       -- 'board_of_directors' | other
  --   ch_filing_email                  TEXT
  --   ch_filing_credentials_encrypted  TEXT       -- encrypt-at-rest required (data-integrity pass)
  --   sic_code_1..4                    TEXT
  -- Source: Blockman Block Manager → Secretarial screenshot, Barge Arm MC example.
);

CREATE TRIGGER management_companies_updated_at
  BEFORE UPDATE ON management_companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_management_companies_firm_id ON management_companies(firm_id);
CREATE INDEX idx_management_companies_landlord_id ON management_companies(landlord_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- G2 — management_company_directors (junction; Blockman parity)
-- Promoted from JSONB to structured table because Blockman exposes a structured
-- director list (Name / Contact / Email / Address / Appointed / Comments) and
-- Phase 5 G23 secretarial workflow will exercise this directly.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE management_company_directors (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                 UUID NOT NULL REFERENCES firms(id),
  management_company_id   UUID NOT NULL REFERENCES management_companies(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  contact_phone           TEXT,
  contact_email           TEXT,
  address                 TEXT,
  appointed_date          DATE NOT NULL,
  removed_date            DATE,            -- NULL = currently appointed
  comments                TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER management_company_directors_updated_at
  BEFORE UPDATE ON management_company_directors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_mcd_firm_id ON management_company_directors(firm_id);
CREATE INDEX idx_mcd_mc_id ON management_company_directors(management_company_id);
-- Fast lookup of currently-appointed directors per MC
CREATE INDEX idx_mcd_current ON management_company_directors(management_company_id)
  WHERE removed_date IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- G3 + G4 — unit_leases (G4 ground rent schedule nested)
-- Versioned via supersedes_lease_id; is_current flag with partial-unique idx.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE unit_leases (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                         UUID NOT NULL REFERENCES firms(id),
  unit_id                         UUID NOT NULL REFERENCES units(id),
  is_current                      BOOLEAN NOT NULL DEFAULT true,
  supersedes_lease_id             UUID REFERENCES unit_leases(id),
  -- Lease term
  commencement_date               DATE,
  expiry_date                     DATE,
  original_term_years             INTEGER,
  current_term_years              INTEGER,  -- post any statutory or voluntary extension
  -- Ground rent (G4 nested)
  ground_rent_amount              NUMERIC(12,2),
  ground_rent_review_basis        TEXT,
  -- fixed | rpi | doubling | peppercorn | review_only | other
  ground_rent_review_period_years INTEGER,
  ground_rent_next_review_date    DATE,
  ground_rent_history             JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- [{from: DATE, to: DATE, amount: NUMERIC, event: TEXT}]
  -- Lease covenants
  permitted_user                  TEXT,
  sublet_consent                  TEXT,     -- not_required | landlord_consent | absolute_prohibition
  pet_restriction                 TEXT,
  alteration_consent              TEXT,     -- not_required | landlord_consent | absolute_prohibition
  short_let_restriction           TEXT,
  -- Histories
  deed_of_variation_history       JSONB NOT NULL DEFAULT '[]'::jsonb,
  lease_extension_history         JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes                           TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER unit_leases_updated_at
  BEFORE UPDATE ON unit_leases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_unit_leases_firm_id ON unit_leases(firm_id);
CREATE INDEX idx_unit_leases_unit_id ON unit_leases(unit_id);
-- One current lease per unit
CREATE UNIQUE INDEX uq_unit_leases_one_current_per_unit
  ON unit_leases(unit_id) WHERE is_current;

-- ─────────────────────────────────────────────────────────────────────────────
-- properties — FK to landlord + management_company (nullable; NOT NULL deferred)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE properties ADD COLUMN landlord_id UUID REFERENCES landlords(id);
ALTER TABLE properties ADD COLUMN management_company_id UUID REFERENCES management_companies(id);

CREATE INDEX idx_properties_landlord_id ON properties(landlord_id);
CREATE INDEX idx_properties_management_company_id ON properties(management_company_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — mirror standard pattern from 00012_rls_policies.sql
-- firm-scoped reads; PM-tier writes; admin-only delete.
-- ─────────────────────────────────────────────────────────────────────────────

-- landlords
ALTER TABLE landlords ENABLE ROW LEVEL SECURITY;

CREATE POLICY landlords_select ON landlords
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY landlords_insert ON landlords
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY landlords_update ON landlords
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY landlords_delete ON landlords
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

-- management_companies
ALTER TABLE management_companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY management_companies_select ON management_companies
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY management_companies_insert ON management_companies
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY management_companies_update ON management_companies
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY management_companies_delete ON management_companies
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

-- management_company_directors
ALTER TABLE management_company_directors ENABLE ROW LEVEL SECURITY;

CREATE POLICY mcd_select ON management_company_directors
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY mcd_insert ON management_company_directors
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY mcd_update ON management_company_directors
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY mcd_delete ON management_company_directors
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

-- unit_leases
ALTER TABLE unit_leases ENABLE ROW LEVEL SECURITY;

CREATE POLICY unit_leases_select ON unit_leases
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY unit_leases_insert ON unit_leases
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY unit_leases_update ON unit_leases
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY unit_leases_delete ON unit_leases
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION QUERIES (run immediately after migration; paste results back)
-- Memory rule: migration plan must include the verification query (state-test,
-- distinct from runtime smokes).
-- ─────────────────────────────────────────────────────────────────────────────

-- Q1: four new tables exist with RLS enabled
--   expect 4 rows, all rowsecurity = true
-- SELECT tablename, rowsecurity FROM pg_tables
--  WHERE schemaname = 'public'
--    AND tablename IN ('landlords','management_companies',
--                      'management_company_directors','unit_leases')
--  ORDER BY tablename;

-- Q2: row counts (schema-only migration; all should be 0)
--   expect: each row reports 0
-- SELECT 'landlords' AS t, COUNT(*) FROM landlords
-- UNION ALL SELECT 'management_companies', COUNT(*) FROM management_companies
-- UNION ALL SELECT 'management_company_directors', COUNT(*) FROM management_company_directors
-- UNION ALL SELECT 'unit_leases', COUNT(*) FROM unit_leases;

-- Q3: properties FK columns present and nullable
--   expect 2 rows: landlord_id YES, management_company_id YES
-- SELECT column_name, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'properties'
--    AND column_name IN ('landlord_id','management_company_id')
--  ORDER BY column_name;

-- Q4: partial-unique index on unit_leases enforces one-current-lease-per-unit
--   expect 1 row showing the partial predicate
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE schemaname = 'public' AND tablename = 'unit_leases'
--    AND indexname = 'uq_unit_leases_one_current_per_unit';

-- Q5: RLS policies installed (4 per table × 4 tables = 16 rows)
-- SELECT tablename, policyname, cmd FROM pg_policies
--  WHERE tablename IN ('landlords','management_companies',
--                      'management_company_directors','unit_leases')
--  ORDER BY tablename, cmd;
