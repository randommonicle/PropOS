-- Migration: 00033_demo_seed_legacy_drops
-- Purpose: Phase 4 entry — demo-seed of G1-G6 data, sweep of stale Py-Smoke
--   property residue, drop of legacy units/properties lease + freeholder columns,
--   and promotion of properties.landlord_id to NOT NULL.
--
--   Lands the data that:
--     - Lets the 2 .fixme'd 1i.6 smokes un-block (leaseholder self-read on
--       emergency_contacts; landlord-exempt s.153 path on demands).
--     - Gives Phase 4 BSA + 4a collection + 4c LPE realistic landlord / lease /
--       MC / emergency-contact / interested-party rows to exercise against.
--     - Closes the FORWARD anchors in 00031 (legacy units / properties col drops,
--       landlord_id NOT NULL) and 00032 (FORWARD: demo-seed for s.153 exempt path).
--
-- Scope confirmed 2026-05-11 (sign-off Q1-Q6 + worktree strategy):
--   Q1 — UI strip-only in PropertyDetailPage.tsx (form fields + freeholder line removed;
--        full read-from-unit_leases UI lands in a dedicated UI commit later).
--   Q2 — Idempotent seed via INSERT … WHERE NOT EXISTS keyed on (firm scope, name).
--   Q3 — Landlord types: Maple investor, Birchwood rmc_owned (HRB), Cedar rmc_owned.
--   Q4 — Leaseholder fixture BUNDLED: seed Demo Leaseholder rows per unit + linkage
--        of leaseholder@propos.local to one unit is handled by an updated test_users.sql
--        (Dashboard auth-user add required as the pre-step, mirroring 1i.3 pattern).
--   Q5 — Cedar Estate landlord = section_153_required=false (gives smoke 8 its anchor).
--   Q6 — Sweep + patch Py Smoke residue (3 property rows from test_properties.py with
--        no FK children — verified by pre-query 2026-05-11 — and patch the Python smoke
--        afterAll to stop the leak).
--
-- Statutory anchors (carried through from 00031 / 00032):
--   LTA 1987 s.47(1)         — landlord name on demands (landlords.section_47_*).
--   LTA 1987 s.48(1)         — address for service (landlords.section_48_address).
--   CLRA 2002 s.153          — landlord-name-and-address enforceability gate; landlord
--                              row may opt out via section_153_required=false (e.g.
--                              Welsh peppercorn rentcharge estate). Cedar = exemption case.
--   RICS Service Charge Code — Residential Code 4th ed., demo data marked as fixture
--                              via leaseholders/emergency_contacts notes/gdpr_consent_note.
--   UK GDPR Art. 30          — emergency_contacts.gdpr_consent_note carries provenance;
--                              demo rows tagged "Seed fixture — demo data only".
--
-- Forward anchors (do not implement here):
--   FORWARD: PropertyDetailPage.tsx full read-from-unit_leases UI — strip-only UI patch
--     lands in this commit; the Units table ground rent + lease end columns are removed
--     pending a dedicated UI commit that surfaces unit_leases (current row per unit) +
--     properties.landlord_id → landlords.name on the Overview card.
--   FORWARD: Phase 4c LPE pack generator — consumes interested_parties for forfeiture
--     mortgagee service (CLRA 2002 / pre-action protocol). Demo row on Maple Flat 1.
--   FORWARD: Phase 5 leaseholder portal commit — extends the leaseholder@propos.local
--     fixture seeded by test_users.sql update; un-fixme'd smokes 7 + 8 anchor here.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════════
-- Section A — Sweep stale Py-Smoke property residue (Q6 / pre-query verified)
--   tests/smoke_py/test_properties.py:test_create_property creates 'Py Smoke Block
--   <epoch>' rows via the UI with no teardown. Pre-query 2026-05-11 confirmed 0
--   FK-children across units / leaseholders / demands / documents /
--   compliance_items / works_orders / apportionment_schedules / bank_accounts /
--   service_charge_accounts. Safe to delete the property rows directly.
--   Properties has no Delete UI today, so a per-run teardown is not yet feasible
--   from the smoke side. The smoke docstring carries the FORWARD anchor; this
--   migration's idempotent LIKE-sweep is the safety net — re-applying drops any
--   residue. A properties Delete UI commit (Phase 5 settings audit) will close
--   the loop by adding teardown to tests/smoke_py/test_properties.py.
-- ═════════════════════════════════════════════════════════════════════════════

DELETE FROM properties WHERE name LIKE 'Py Smoke Block %';

-- ═════════════════════════════════════════════════════════════════════════════
-- Section B — Seed landlords (G1)
--   3 landlords, one per real demo property. Maple investor; Birchwood + Cedar
--   rmc_owned. Cedar's section_153_required=false models the Welsh peppercorn /
--   freehold-estate-management exemption case (smoke 8 anchor).
-- ═════════════════════════════════════════════════════════════════════════════

-- Maple House — investor freeholder
INSERT INTO landlords (
  firm_id, name, landlord_type, companies_house_number,
  registered_office_line1, registered_office_town, registered_office_postcode,
  contact_name, contact_email, contact_phone,
  section_47_name, section_47_address, section_48_address,
  section_153_required
)
SELECT
  f.id, 'Maple House Freeholders Ltd', 'investor', '08123456',
  '50 Investor Row', 'London', 'EC1V 9AB',
  'Charles Mortimer', 'charles@maplehouse-freeholders.co.uk', '+44 20 7946 0100',
  'Maple House Freeholders Ltd',
  '50 Investor Row, London, EC1V 9AB',
  '50 Investor Row, London, EC1V 9AB',
  true
FROM firms f
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM landlords l
     WHERE l.firm_id = f.id AND l.name = 'Maple House Freeholders Ltd'
  );

-- Birchwood Court — RMC-owned (HRB, 12 storeys; residents-owned freehold via RMC)
INSERT INTO landlords (
  firm_id, name, landlord_type, companies_house_number,
  registered_office_line1, registered_office_town, registered_office_postcode,
  contact_name, contact_email, contact_phone,
  section_47_name, section_47_address, section_48_address,
  section_153_required
)
SELECT
  f.id, 'Birchwood Court (RMC) Limited', 'rmc_owned', '11234567',
  '45 Oak Avenue', 'Manchester', 'M1 2CD',
  'Helen Thompson', 'directors@birchwood-rmc.co.uk', '+44 161 496 0200',
  'Birchwood Court (RMC) Limited',
  '45 Oak Avenue, Manchester, M1 2CD',
  'c/o Demo Property Management Ltd, EC1A 1BB',
  true
FROM firms f
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM landlords l
     WHERE l.firm_id = f.id AND l.name = 'Birchwood Court (RMC) Limited'
  );

-- Cedar Estate — RMC-owned, peppercorn rentcharge estate (s.153 exempt)
INSERT INTO landlords (
  firm_id, name, landlord_type, companies_house_number,
  registered_office_line1, registered_office_town, registered_office_postcode,
  contact_name, contact_email, contact_phone,
  section_47_name, section_47_address, section_48_address,
  section_153_required, notes
)
SELECT
  f.id, 'Cedar Estate Management Ltd', 'rmc_owned', '12345678',
  'Cedar Drive', 'Bristol', 'BS1 3EF',
  'Emma Williams', 'directors@cedar-estate.co.uk', '+44 117 496 0300',
  'Cedar Estate Management Ltd',
  'Cedar Drive, Bristol, BS1 3EF',
  'c/o Demo Property Management Ltd, EC1A 1BB',
  false,
  'CLRA 2002 s.153 exemption: peppercorn-rentcharge estate. Verified 2026-05-11.'
FROM firms f
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM landlords l
     WHERE l.firm_id = f.id AND l.name = 'Cedar Estate Management Ltd'
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- Section C — Seed management_companies (G2) + directors
--   Two MCs (Birchwood + Cedar). Linked to their respective landlords (since the
--   RMC IS the landlord in both cases per landlord_type='rmc_owned'). Maple has
--   no MC — investor freeholder model.
-- ═════════════════════════════════════════════════════════════════════════════

-- Birchwood Court MC
INSERT INTO management_companies (
  firm_id, landlord_id, name, company_type, companies_house_number,
  incorporation_date, accounts_year_end, agm_due_date,
  registered_office_line1, registered_office_town, registered_office_postcode
)
SELECT
  f.id, l.id, 'Birchwood Court (RMC) Limited', 'rmc', '11234567',
  '2017-11-20', '2026-03-31', '2026-09-30',
  '45 Oak Avenue', 'Manchester', 'M1 2CD'
FROM firms f
JOIN landlords l ON l.firm_id = f.id AND l.name = 'Birchwood Court (RMC) Limited'
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM management_companies mc
     WHERE mc.firm_id = f.id AND mc.name = 'Birchwood Court (RMC) Limited'
  );

-- Cedar Estate MC
INSERT INTO management_companies (
  firm_id, landlord_id, name, company_type, companies_house_number,
  incorporation_date, accounts_year_end, agm_due_date,
  registered_office_line1, registered_office_town, registered_office_postcode
)
SELECT
  f.id, l.id, 'Cedar Estate Management Ltd', 'rmc', '12345678',
  '2014-05-12', '2026-03-31', '2026-09-30',
  'Cedar Drive', 'Bristol', 'BS1 3EF'
FROM firms f
JOIN landlords l ON l.firm_id = f.id AND l.name = 'Cedar Estate Management Ltd'
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM management_companies mc
     WHERE mc.firm_id = f.id AND mc.name = 'Cedar Estate Management Ltd'
  );

-- Birchwood Court MC — 2 directors
INSERT INTO management_company_directors (
  firm_id, management_company_id, name, contact_phone, contact_email,
  address, appointed_date, comments
)
SELECT f.id, mc.id, v.name, v.contact_phone, v.contact_email, v.address,
       v.appointed_date, v.comments
FROM firms f
JOIN management_companies mc
  ON mc.firm_id = f.id AND mc.name = 'Birchwood Court (RMC) Limited'
CROSS JOIN (VALUES
  ('Helen Thompson', '+44 7700 900201', 'helen.thompson@birchwood-rmc.co.uk',
   'Flat 8, Birchwood Court, 45 Oak Avenue, Manchester, M1 2CD',
   DATE '2017-11-20', 'Chair'),
  ('Robert Singh',  '+44 7700 900202', 'robert.singh@birchwood-rmc.co.uk',
   'Flat 14, Birchwood Court, 45 Oak Avenue, Manchester, M1 2CD',
   DATE '2017-11-20', 'Treasurer')
) AS v(name, contact_phone, contact_email, address, appointed_date, comments)
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM management_company_directors d
     WHERE d.management_company_id = mc.id AND d.name = v.name
  );

-- Cedar Estate MC — 2 directors
INSERT INTO management_company_directors (
  firm_id, management_company_id, name, contact_phone, contact_email,
  address, appointed_date, comments
)
SELECT f.id, mc.id, v.name, v.contact_phone, v.contact_email, v.address,
       v.appointed_date, v.comments
FROM firms f
JOIN management_companies mc
  ON mc.firm_id = f.id AND mc.name = 'Cedar Estate Management Ltd'
CROSS JOIN (VALUES
  ('Emma Williams', '+44 7700 900301', 'emma.williams@cedar-estate.co.uk',
   '4 Cedar Drive, Bristol, BS1 3EF',
   DATE '2014-05-12', 'Chair'),
  ('David Patel',   '+44 7700 900302', 'david.patel@cedar-estate.co.uk',
   '11 Cedar Drive, Bristol, BS1 3EF',
   DATE '2014-05-12', 'Treasurer')
) AS v(name, contact_phone, contact_email, address, appointed_date, comments)
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM management_company_directors d
     WHERE d.management_company_id = mc.id AND d.name = v.name
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- Section D — Backfill properties.landlord_id + management_company_id
--   Must run before Section H (NOT NULL promotion). Maple gets landlord only;
--   Birchwood + Cedar get both landlord and management_company.
-- ═════════════════════════════════════════════════════════════════════════════

UPDATE properties p
   SET landlord_id = l.id
  FROM landlords l, firms f
 WHERE p.firm_id = f.id
   AND f.slug = 'demo-firm'
   AND l.firm_id = f.id
   AND p.name = 'Maple House'
   AND l.name = 'Maple House Freeholders Ltd'
   AND p.landlord_id IS NULL;

UPDATE properties p
   SET landlord_id = l.id,
       management_company_id = mc.id
  FROM landlords l, management_companies mc, firms f
 WHERE p.firm_id = f.id
   AND f.slug = 'demo-firm'
   AND l.firm_id = f.id
   AND mc.firm_id = f.id
   AND p.name = 'Birchwood Court'
   AND l.name = 'Birchwood Court (RMC) Limited'
   AND mc.name = 'Birchwood Court (RMC) Limited'
   AND p.landlord_id IS NULL;

UPDATE properties p
   SET landlord_id = l.id,
       management_company_id = mc.id
  FROM landlords l, management_companies mc, firms f
 WHERE p.firm_id = f.id
   AND f.slug = 'demo-firm'
   AND l.firm_id = f.id
   AND mc.firm_id = f.id
   AND p.name = 'Cedar Estate'
   AND l.name = 'Cedar Estate Management Ltd'
   AND mc.name = 'Cedar Estate Management Ltd'
   AND p.landlord_id IS NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- Section E — Seed unit_leases (G3 + G4 nested)
--   One current lease row per existing unit in the 3 demo properties.
--   Maple: 125-yr lease from 2010-06-24, £250 fixed ground rent.
--   Birchwood: 125-yr lease from 2018-04-01 new-build, peppercorn (RMC-owned).
--   Cedar: 125-yr lease from 2015-09-15, peppercorn (RMC-owned).
--   Idempotent via the partial-unique idx uq_unit_leases_one_current_per_unit
--   AND a NOT EXISTS guard so re-runs are silent.
-- ═════════════════════════════════════════════════════════════════════════════

INSERT INTO unit_leases (
  firm_id, unit_id, is_current,
  commencement_date, expiry_date, original_term_years, current_term_years,
  ground_rent_amount, ground_rent_review_basis,
  sublet_consent, alteration_consent, permitted_user
)
SELECT
  u.firm_id, u.id, true,
  CASE p.name
    WHEN 'Maple House'      THEN DATE '2010-06-24'
    WHEN 'Birchwood Court'  THEN DATE '2018-04-01'
    WHEN 'Cedar Estate'     THEN DATE '2015-09-15'
  END,
  CASE p.name
    WHEN 'Maple House'      THEN (DATE '2010-06-24' + INTERVAL '125 years')::date
    WHEN 'Birchwood Court'  THEN (DATE '2018-04-01' + INTERVAL '125 years')::date
    WHEN 'Cedar Estate'     THEN (DATE '2015-09-15' + INTERVAL '125 years')::date
  END,
  125, 125,
  CASE p.name WHEN 'Maple House' THEN 250.00 ELSE 0.00 END,
  CASE p.name WHEN 'Maple House' THEN 'fixed' ELSE 'peppercorn' END,
  'landlord_consent', 'landlord_consent',
  'Private residential dwelling'
FROM units u
JOIN properties p ON p.id = u.property_id
JOIN firms f ON f.id = u.firm_id
WHERE f.slug = 'demo-firm'
  AND p.name IN ('Maple House', 'Birchwood Court', 'Cedar Estate')
  AND NOT EXISTS (
    SELECT 1 FROM unit_leases ul WHERE ul.unit_id = u.id AND ul.is_current
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- Section F — Seed leaseholders (one current per unit)
--   Required by smoke 8 (landlord-exempt s.153 demand needs leaseholder_id FK on
--   demands) and by future Phase 4a collection workflow smokes. The 1i.6 smoke
--   leftover row (notes LIKE 'Smoke 1i6%') is tolerated — separate from this seed.
-- ═════════════════════════════════════════════════════════════════════════════

INSERT INTO leaseholders (
  firm_id, unit_id, property_id, full_name,
  is_current, is_resident, is_company, portal_access,
  email, phone, from_date, notes
)
SELECT
  u.firm_id, u.id, u.property_id,
  'Demo Leaseholder ' || p.name || ' ' || u.unit_ref,
  true, true, false, false,
  'demo.leaseholder.'
    || lower(replace(p.name, ' ', '-')) || '.'
    || lower(replace(u.unit_ref, ' ', '-'))
    || '@propos.local',
  '+44 7700 900100',
  CASE p.name
    WHEN 'Maple House'      THEN DATE '2010-06-24'
    WHEN 'Birchwood Court'  THEN DATE '2018-04-01'
    WHEN 'Cedar Estate'     THEN DATE '2015-09-15'
  END,
  'Seed fixture — demo data only'
FROM units u
JOIN properties p ON p.id = u.property_id
JOIN firms f ON f.id = u.firm_id
WHERE f.slug = 'demo-firm'
  AND p.name IN ('Maple House', 'Birchwood Court', 'Cedar Estate')
  AND NOT EXISTS (
    SELECT 1 FROM leaseholders lh
     WHERE lh.unit_id = u.id
       AND lh.full_name = 'Demo Leaseholder ' || p.name || ' ' || u.unit_ref
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- Section G — Seed emergency_contacts (G16) + interested_parties (G17)
--   One key_holder per unit; one mortgagee on Maple Flat 1 (LPE / s.146 anchor).
-- ═════════════════════════════════════════════════════════════════════════════

-- emergency_contacts — one key_holder per unit
INSERT INTO emergency_contacts (
  firm_id, unit_id, property_id,
  name, contact_type, relationship, phone, gdpr_consent_note, notes
)
SELECT
  u.firm_id, u.id, u.property_id,
  'Demo Key Holder for ' || p.name || ' ' || u.unit_ref,
  'key_holder',
  'Neighbour',
  '+44 7700 900400',
  'Seed fixture — demo data only',
  'Demo seed (00033)'
FROM units u
JOIN properties p ON p.id = u.property_id
JOIN firms f ON f.id = u.firm_id
WHERE f.slug = 'demo-firm'
  AND p.name IN ('Maple House', 'Birchwood Court', 'Cedar Estate')
  AND NOT EXISTS (
    SELECT 1 FROM emergency_contacts ec
     WHERE ec.unit_id = u.id
       AND ec.name = 'Demo Key Holder for ' || p.name || ' ' || u.unit_ref
  );

-- interested_parties — one mortgagee on Maple Flat 1
INSERT INTO interested_parties (
  firm_id, property_id, unit_id,
  party_type, name, address, contact_phone, contact_email,
  legal_reference, effective_from, notes
)
SELECT
  u.firm_id, u.property_id, u.id,
  'mortgagee',
  'Demo Bank PLC',
  '1 Banking Way, London, EC2A 1XX',
  '+44 20 7946 0500',
  'mortgages@demo-bank.example',
  'MTG-DEMO-001',
  DATE '2010-06-24',
  'Demo seed (00033) — Phase 4c LPE pack generator anchor; CLRA 2002 / s.146 forfeiture-protocol mortgagee service'
FROM units u
JOIN properties p ON p.id = u.property_id
JOIN firms f ON f.id = u.firm_id
WHERE f.slug = 'demo-firm'
  AND p.name = 'Maple House'
  AND u.unit_ref = 'Flat 1'
  AND NOT EXISTS (
    SELECT 1 FROM interested_parties ip
     WHERE ip.unit_id = u.id AND ip.name = 'Demo Bank PLC'
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- Section H — Drop legacy units / properties columns (FORWARD anchor from 00031)
--   Pre-flight grep 2026-05-11 confirmed blocking refs in:
--     - app/src/types/database.ts (regen alongside this migration)
--     - app/src/components/modules/properties/PropertyDetailPage.tsx (strip-only patch)
--     - supabase/seed/demo_seed.mjs:122 (lease_term_years column dropped from INSERT)
--   No RLS policies / triggers reference these columns (grep verified).
--   ground_rent_review_basis (00004:51) is KEPT — not in the 5-col legacy set;
--   the unit_leases.ground_rent_review_basis is the canonical surface going forward
--   but the units column is retained until a follow-up data-migration sweep.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE units
  DROP COLUMN lease_start,
  DROP COLUMN lease_end,
  DROP COLUMN lease_term_years,
  DROP COLUMN ground_rent_pa,
  DROP COLUMN ground_rent_review_date;

ALTER TABLE properties
  DROP COLUMN freeholder_name,
  DROP COLUMN freeholder_contact;

-- ═════════════════════════════════════════════════════════════════════════════
-- Section I — Promote properties.landlord_id to NOT NULL
--   Safe to run AFTER Section A sweep + Section D backfill. Section A removed the
--   3 unlinked Py-Smoke rows; Section D linked all 3 real demo properties. Any
--   property still NULL here would fail the ALTER — by design.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE properties ALTER COLUMN landlord_id SET NOT NULL;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run immediately after migration; paste results back)
-- Memory rule: migration plan must include the verification query (state-test,
-- distinct from runtime smokes).
-- ═════════════════════════════════════════════════════════════════════════════

-- Q1: seed row counts
--   expect: 3 landlords, 2 management_companies, 4 directors, 9 unit_leases,
--   ≥9 leaseholders (current; +1 leftover from 1i.6 smoke tolerated),
--   9 emergency_contacts, 1 interested_party.
-- SELECT 'landlords' AS t, COUNT(*) FROM landlords
-- UNION ALL SELECT 'management_companies', COUNT(*) FROM management_companies
-- UNION ALL SELECT 'management_company_directors', COUNT(*) FROM management_company_directors
-- UNION ALL SELECT 'unit_leases_current', COUNT(*) FROM unit_leases WHERE is_current
-- UNION ALL SELECT 'leaseholders_current', COUNT(*) FROM leaseholders WHERE is_current
-- UNION ALL SELECT 'emergency_contacts', COUNT(*) FROM emergency_contacts
-- UNION ALL SELECT 'interested_parties', COUNT(*) FROM interested_parties;

-- Q2: every property linked to a landlord (expect 0 rows)
-- SELECT id, name FROM properties WHERE landlord_id IS NULL;

-- Q3: landlord_id is NOT NULL (expect is_nullable='NO')
-- SELECT column_name, is_nullable FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='properties' AND column_name='landlord_id';

-- Q4: legacy columns are gone (expect 0 rows)
-- SELECT table_name, column_name FROM information_schema.columns
--  WHERE table_schema='public'
--    AND (
--      (table_name='units' AND column_name IN ('lease_start','lease_end','lease_term_years','ground_rent_pa','ground_rent_review_date'))
--    OR (table_name='properties' AND column_name IN ('freeholder_name','freeholder_contact'))
--    );

-- Q5: section_153 exempt landlord present (expect 1 row: Cedar Estate Management Ltd)
-- SELECT name, landlord_type, section_153_required
--   FROM landlords WHERE section_153_required = false;

-- Q6: Py Smoke residue is gone (expect 0 rows)
-- SELECT COUNT(*) FROM properties WHERE name LIKE 'Py Smoke Block %';
