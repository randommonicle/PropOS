-- Migration: 00004_property_registry
-- Purpose: Section 4.2 — Property registry (properties, units, apportionment, leaseholders).

-- ── properties ────────────────────────────────────────────────────────────────
CREATE TABLE properties (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           UUID NOT NULL REFERENCES firms(id),
  name              TEXT NOT NULL,
  address_line1     TEXT NOT NULL,
  address_line2     TEXT,
  town              TEXT NOT NULL,
  postcode          TEXT NOT NULL,
  property_type     TEXT NOT NULL, -- block | estate | mixed | house
  total_units       INTEGER,
  build_year        INTEGER,
  listed_status     TEXT DEFAULT 'none', -- none | grade_ii | grade_ii_star | grade_i
  freeholder_name   TEXT,
  freeholder_contact TEXT,
  managing_since    DATE,
  assigned_pm_id    UUID REFERENCES users(id),
  legacy_ref        TEXT,
  notes             TEXT,
  -- BSA fields
  is_hrb            BOOLEAN NOT NULL DEFAULT false,
  storey_count      INTEGER,
  height_metres     NUMERIC(6,2),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_properties_firm_id ON properties(firm_id);

-- ── units ─────────────────────────────────────────────────────────────────────
CREATE TABLE units (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                 UUID NOT NULL REFERENCES firms(id),
  property_id             UUID NOT NULL REFERENCES properties(id),
  unit_ref                TEXT NOT NULL,
  floor                   INTEGER,
  unit_type               TEXT NOT NULL DEFAULT 'flat',
  -- flat | house | commercial | parking | storage | other
  lease_start             DATE,
  lease_end               DATE,
  lease_term_years        INTEGER,
  ground_rent_pa          NUMERIC(12,2),
  ground_rent_review_date DATE,
  ground_rent_review_basis TEXT, -- fixed | rpi | doubling | review_only
  is_share_of_freehold    BOOLEAN NOT NULL DEFAULT false,
  is_currently_let        BOOLEAN NOT NULL DEFAULT false,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER units_updated_at
  BEFORE UPDATE ON units
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_units_firm_id ON units(firm_id);
CREATE INDEX idx_units_property_id ON units(property_id);

-- ── apportionment_schedules ───────────────────────────────────────────────────
-- A property can have multiple schedules (e.g. general + roof-only + lift-only)
CREATE TABLE apportionment_schedules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       UUID NOT NULL REFERENCES firms(id),
  property_id   UUID NOT NULL REFERENCES properties(id),
  schedule_name TEXT NOT NULL,
  method        TEXT NOT NULL,
  -- fixed_pct | floor_area | rateable_value | equal_share | weighted | hybrid | bespoke
  description   TEXT,
  lease_clause  TEXT,
  effective_from DATE NOT NULL,
  effective_to  DATE,
  approved_by   TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_apportionment_schedules_property ON apportionment_schedules(property_id);

-- ── apportionment_items ───────────────────────────────────────────────────────
-- The fraction (numerator/denominator) is authoritative.
-- percentage_calculated is derived and stored for display only.
CREATE TABLE apportionment_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               UUID NOT NULL REFERENCES firms(id),
  schedule_id           UUID NOT NULL REFERENCES apportionment_schedules(id),
  unit_id               UUID NOT NULL REFERENCES units(id),
  share_numerator       NUMERIC(12,6) NOT NULL,
  share_denominator     NUMERIC(12,6) NOT NULL,
  percentage_calculated NUMERIC(8,6) GENERATED ALWAYS AS
                        (share_numerator / share_denominator * 100) STORED,
  floor_area_sqm        NUMERIC(10,2),
  rateable_value        NUMERIC(12,2),
  weighting_factor      NUMERIC(8,4),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_apportionment_items_schedule ON apportionment_items(schedule_id);
CREATE INDEX idx_apportionment_items_unit ON apportionment_items(unit_id);

-- ── leaseholders ─────────────────────────────────────────────────────────────
CREATE TABLE leaseholders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               UUID NOT NULL REFERENCES firms(id),
  unit_id               UUID NOT NULL REFERENCES units(id),
  user_id               UUID REFERENCES users(id),
  full_name             TEXT NOT NULL,
  correspondence_address TEXT,
  email                 TEXT,
  phone                 TEXT,
  is_resident           BOOLEAN NOT NULL DEFAULT true,
  is_company            BOOLEAN NOT NULL DEFAULT false,
  company_name          TEXT,
  company_reg           TEXT,
  portal_access         BOOLEAN NOT NULL DEFAULT false,
  is_current            BOOLEAN NOT NULL DEFAULT true,
  from_date             DATE,
  to_date               DATE,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Expose property_id for joins without requiring a units join
ALTER TABLE leaseholders ADD COLUMN property_id UUID REFERENCES properties(id);

CREATE TRIGGER leaseholders_updated_at
  BEFORE UPDATE ON leaseholders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_leaseholders_firm_id ON leaseholders(firm_id);
CREATE INDEX idx_leaseholders_unit_id ON leaseholders(unit_id);
CREATE INDEX idx_leaseholders_property_id ON leaseholders(property_id);
