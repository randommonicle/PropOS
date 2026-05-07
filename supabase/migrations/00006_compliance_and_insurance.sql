-- Migration: 00006_compliance_and_insurance
-- Purpose: Section 4.4 — Compliance items and insurance policies.

-- ── compliance_items ──────────────────────────────────────────────────────────
-- reminder_days_before is an array e.g. {90,60,30,14,7}
-- A scheduled Edge Function checks this array and sends Resend notifications.
CREATE TABLE compliance_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           UUID NOT NULL REFERENCES firms(id),
  property_id       UUID NOT NULL REFERENCES properties(id),
  item_type         TEXT NOT NULL,
  -- eicr | fra | gas_safety | asbestos_management | asbestos_refurb
  -- lift_thorough | lift_service | insurance | health_safety | water_hygiene
  -- legionella | pat_testing | fire_suppression | emergency_lighting
  -- planning | building_regs | other
  description       TEXT NOT NULL,
  contractor_id     UUID,                     -- forward ref to contractors
  issue_date        DATE,
  expiry_date       DATE,
  reminder_days_before INTEGER[] NOT NULL DEFAULT '{90,30,14}',
  status            TEXT NOT NULL DEFAULT 'current',
  -- current | expiring_soon | expired | not_applicable | action_required
  document_id       UUID,
  notes             TEXT,
  next_action       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER compliance_items_updated_at
  BEFORE UPDATE ON compliance_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_compliance_items_firm ON compliance_items(firm_id);
CREATE INDEX idx_compliance_items_property ON compliance_items(property_id);
CREATE INDEX idx_compliance_items_expiry ON compliance_items(expiry_date);

-- ── insurance_policies ────────────────────────────────────────────────────────
CREATE TABLE insurance_policies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firms(id),
  property_id     UUID NOT NULL REFERENCES properties(id),
  insurer         TEXT NOT NULL,
  broker          TEXT,
  policy_number   TEXT,
  policy_type     TEXT NOT NULL,
  -- buildings | liability | directors_officers | terrorism | engineering | other
  premium_net     NUMERIC(12,2),
  premium_gross   NUMERIC(12,2),
  sum_insured     NUMERIC(16,2),
  inception_date  DATE NOT NULL,
  renewal_date    DATE NOT NULL,
  auto_renew      BOOLEAN NOT NULL DEFAULT false,
  document_id     UUID,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER insurance_policies_updated_at
  BEFORE UPDATE ON insurance_policies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_insurance_firm ON insurance_policies(firm_id);
CREATE INDEX idx_insurance_property ON insurance_policies(property_id);
CREATE INDEX idx_insurance_renewal ON insurance_policies(renewal_date);
