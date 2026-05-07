-- Migration: 00009_bsa_module
-- Purpose: Section 4.7 — Building Safety Act 2022 module.
-- buildings_bsa, golden_thread_records (IMMUTABLE), golden_thread_audit_log,
-- bsa_mandatory_occurrences.
--
-- CRITICAL: golden_thread_records are LEGALLY IMMUTABLE under BSA 2022 s.88
-- and The Higher-Risk Buildings (Keeping and Provision of Information) Regulations 2024.
-- Records are NEVER deleted or overwritten. They are superseded by new records.
-- RLS policies block DELETE and UPDATE on this table.

-- ── buildings_bsa ─────────────────────────────────────────────────────────────
CREATE TABLE buildings_bsa (
  id                                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                             UUID NOT NULL REFERENCES firms(id),
  property_id                         UUID NOT NULL REFERENCES properties(id) UNIQUE,
  is_hrb                              BOOLEAN NOT NULL DEFAULT false,
  hrb_confirmed_date                  DATE,
  height_metres                       NUMERIC(6,2),
  storey_count                        INTEGER,
  residential_unit_count              INTEGER,
  hrb_registration_number             TEXT,
  hrb_registration_date               DATE,
  hrb_registration_document_id        UUID,
  principal_accountable_person        TEXT,
  principal_accountable_person_email  TEXT,
  accountable_persons                 JSONB,
  responsible_person_fire             TEXT,
  bac_status                          TEXT NOT NULL DEFAULT 'not_required',
  -- not_required | pending_instruction | applied | issued | expired | compliance_notice
  bac_application_date                DATE,
  bac_issue_date                      DATE,
  bac_expiry_date                     DATE,
  bac_document_id                     UUID,
  safety_case_report_document_id      UUID,
  safety_case_report_date             DATE,
  resident_engagement_strategy_doc_id UUID,
  mandatory_occurrence_reporting      BOOLEAN NOT NULL DEFAULT false,
  notes                               TEXT,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER buildings_bsa_updated_at
  BEFORE UPDATE ON buildings_bsa
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_buildings_bsa_firm ON buildings_bsa(firm_id);

-- ── golden_thread_records ─────────────────────────────────────────────────────
-- IMMUTABLE RECORDS — no updated_at column by design.
-- To correct an error: create a new record and set superseded_by_id on the old one.
CREATE TABLE golden_thread_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           UUID NOT NULL REFERENCES firms(id),
  property_id       UUID NOT NULL REFERENCES properties(id),
  record_type       TEXT NOT NULL,
  -- design | construction | material_change | inspection | maintenance
  -- safety_assessment | incident | handover | resident_communication | other
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  recorded_by       UUID REFERENCES users(id),
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_date        DATE,
  document_ids      UUID[],
  is_safety_critical BOOLEAN NOT NULL DEFAULT false,
  version_number    INTEGER NOT NULL DEFAULT 1,
  superseded_by_id  UUID REFERENCES golden_thread_records(id),
  is_current_version BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  -- No updated_at: this record is immutable after creation.
);

CREATE INDEX idx_golden_thread_firm ON golden_thread_records(firm_id);
CREATE INDEX idx_golden_thread_property ON golden_thread_records(property_id);
CREATE INDEX idx_golden_thread_current ON golden_thread_records(property_id, is_current_version);

-- ── golden_thread_audit_log ───────────────────────────────────────────────────
CREATE TABLE golden_thread_audit_log (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                 UUID NOT NULL REFERENCES firms(id),
  property_id             UUID NOT NULL REFERENCES properties(id),
  golden_thread_record_id UUID REFERENCES golden_thread_records(id),
  action                  TEXT NOT NULL,
  -- created | viewed | superseded | exported | transferred | access_denied
  performed_by            UUID REFERENCES users(id),
  performed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address              INET,
  user_agent              TEXT,
  notes                   TEXT
);

CREATE INDEX idx_gt_audit_firm ON golden_thread_audit_log(firm_id);
CREATE INDEX idx_gt_audit_record ON golden_thread_audit_log(golden_thread_record_id);

-- ── bsa_mandatory_occurrences ─────────────────────────────────────────────────
CREATE TABLE bsa_mandatory_occurrences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firms(id),
  property_id     UUID NOT NULL REFERENCES properties(id),
  occurrence_type TEXT NOT NULL,
  -- incident | near_miss | structural_risk | fire_risk | other
  description     TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  reported_to_bsr BOOLEAN NOT NULL DEFAULT false,
  bsr_report_date DATE,
  bsr_reference   TEXT,
  severity        TEXT NOT NULL DEFAULT 'risk',
  -- incident | near_miss | risk
  document_ids    UUID[],
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bsa_occurrences_firm ON bsa_mandatory_occurrences(firm_id);
CREATE INDEX idx_bsa_occurrences_property ON bsa_mandatory_occurrences(property_id);
