-- Migration: 00008_contractors_and_works
-- Purpose: Section 4.6 — Contractors, works orders, dispatch log, Section 20 consultation.

-- ── contractors ───────────────────────────────────────────────────────────────
CREATE TABLE contractors (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             UUID NOT NULL REFERENCES firms(id),
  company_name        TEXT NOT NULL,
  contact_name        TEXT,
  email               TEXT,
  phone               TEXT,
  address             TEXT,
  trade_categories    TEXT[],
  -- e.g. {'electrical','roofing','general_maintenance','lift_maintenance'}
  insurance_expiry    DATE,
  gas_safe_number     TEXT,
  electrical_approval TEXT,         -- NICEIC, NAPIT etc.
  preferred_order     INTEGER DEFAULT 99, -- lower = higher dispatch priority
  approved            BOOLEAN NOT NULL DEFAULT false,
  active              BOOLEAN NOT NULL DEFAULT true,
  portal_access       BOOLEAN NOT NULL DEFAULT false,
  rating              NUMERIC(3,2), -- 0.00 to 5.00
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER contractors_updated_at
  BEFORE UPDATE ON contractors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_contractors_firm ON contractors(firm_id);
CREATE INDEX idx_contractors_approved ON contractors(firm_id, approved, active);

-- Now that contractors exists, resolve forward refs
ALTER TABLE compliance_items ADD CONSTRAINT fk_compliance_contractor FOREIGN KEY (contractor_id) REFERENCES contractors(id);

-- ── works_orders ──────────────────────────────────────────────────────────────
CREATE TABLE works_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           UUID NOT NULL REFERENCES firms(id),
  property_id       UUID NOT NULL REFERENCES properties(id),
  unit_id           UUID REFERENCES units(id),           -- NULL for common area jobs
  contractor_id     UUID REFERENCES contractors(id),
  source_type       TEXT,
  -- manual | inspection_report | maintenance_request | compliance_item | section20
  source_id         UUID,
  description       TEXT NOT NULL,
  order_type        TEXT NOT NULL DEFAULT 'reactive',
  -- reactive | planned | section20 | emergency | recall
  priority          TEXT NOT NULL DEFAULT 'normal',
  -- emergency | high | normal | low
  raised_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  required_by       DATE,
  estimated_cost    NUMERIC(14,2),
  actual_cost       NUMERIC(14,2),
  status            TEXT NOT NULL DEFAULT 'draft',
  -- draft | dispatching | accepted | in_progress | complete | cancelled | disputed | dispatch_failed
  invoice_id        UUID REFERENCES invoices(id),
  section20_id      UUID,                               -- forward ref
  dispatch_started_at TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_by        UUID REFERENCES users(id),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER works_orders_updated_at
  BEFORE UPDATE ON works_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_works_orders_firm ON works_orders(firm_id);
CREATE INDEX idx_works_orders_property ON works_orders(property_id);
CREATE INDEX idx_works_orders_status ON works_orders(status);

-- Resolve invoice forward refs
ALTER TABLE invoices ADD CONSTRAINT fk_invoices_works_order FOREIGN KEY (works_order_id) REFERENCES works_orders(id);

-- ── dispatch_log ──────────────────────────────────────────────────────────────
-- Full audit trail of every dispatch attempt by the dispatch engine.
-- Every send, response, timeout, and escalation is recorded here.
CREATE TABLE dispatch_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               UUID NOT NULL REFERENCES firms(id),
  works_order_id        UUID NOT NULL REFERENCES works_orders(id),
  contractor_id         UUID NOT NULL REFERENCES contractors(id),
  sequence_position     INTEGER NOT NULL,  -- 1 = first contacted
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_deadline     TIMESTAMPTZ NOT NULL,
  response_received_at  TIMESTAMPTZ,
  response              TEXT,              -- accepted | declined | no_response
  decline_reason        TEXT,
  token                 TEXT,              -- secure tokenised URL for accept/decline
  token_expires_at      TIMESTAMPTZ,
  notified_via          TEXT NOT NULL DEFAULT 'email',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dispatch_log_works_order ON dispatch_log(works_order_id);
CREATE INDEX idx_dispatch_log_deadline ON dispatch_log(response_deadline) WHERE response IS NULL;

-- ── section20_consultations ───────────────────────────────────────────────────
-- State machine enforced by Edge Function section20-workflow, not the DB.
-- £250 threshold per leaseholder — LTA 1985 s.20
CREATE TABLE section20_consultations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                 UUID NOT NULL REFERENCES firms(id),
  property_id             UUID NOT NULL REFERENCES properties(id),
  works_description       TEXT NOT NULL,
  estimated_cost          NUMERIC(14,2),
  -- LTA 1985 s.20 threshold: £250 per leaseholder
  threshold_exceeded      BOOLEAN GENERATED ALWAYS AS (estimated_cost > 250) STORED,
  status                  TEXT NOT NULL DEFAULT 'stage1_pending',
  stage1_notice_date      DATE,
  stage1_response_deadline DATE,
  stage1_closed_date      DATE,
  stage2_notice_date      DATE,
  stage2_response_deadline DATE,
  stage2_closed_date      DATE,
  nominated_contractor_id UUID REFERENCES contractors(id),
  awarded_contractor_id   UUID REFERENCES contractors(id),
  final_cost              NUMERIC(14,2),
  dispensation_applied    BOOLEAN NOT NULL DEFAULT false,
  dispensation_grounds    TEXT,
  dispensation_granted    BOOLEAN,
  document_ids            UUID[],
  created_by              UUID REFERENCES users(id),
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER section20_updated_at
  BEFORE UPDATE ON section20_consultations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_s20_firm ON section20_consultations(firm_id);
CREATE INDEX idx_s20_property ON section20_consultations(property_id);

-- Resolve section20_id forward refs
ALTER TABLE works_orders ADD CONSTRAINT fk_works_section20 FOREIGN KEY (section20_id) REFERENCES section20_consultations(id);
ALTER TABLE invoices ADD CONSTRAINT fk_invoices_section20 FOREIGN KEY (section20_id) REFERENCES section20_consultations(id);

-- ── section20_observations ────────────────────────────────────────────────────
CREATE TABLE section20_observations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             UUID NOT NULL REFERENCES firms(id),
  consultation_id     UUID NOT NULL REFERENCES section20_consultations(id),
  leaseholder_id      UUID REFERENCES leaseholders(id),
  stage               TEXT NOT NULL,          -- stage1 | stage2
  received_date       DATE NOT NULL,
  content             TEXT NOT NULL,
  nominated_contractor TEXT,
  response_text       TEXT,
  responded_by        UUID REFERENCES users(id),
  responded_at        TIMESTAMPTZ,
  document_id         UUID REFERENCES documents(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_s20_obs_consultation ON section20_observations(consultation_id);
