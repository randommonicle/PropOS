-- Migration: 00010_portals_and_comms
-- Purpose: Section 4.8 — Portals and communications.
-- firm_portal_config, maintenance_requests, portal_messages, meetings.

-- ── firm_portal_config ────────────────────────────────────────────────────────
CREATE TABLE firm_portal_config (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                   UUID NOT NULL REFERENCES firms(id) UNIQUE,
  -- Out-of-hours emergency triage settings
  out_of_hours_phone        TEXT,
  out_of_hours_start        TIME NOT NULL DEFAULT '18:00',
  out_of_hours_end          TIME NOT NULL DEFAULT '08:30',
  out_of_hours_days         TEXT[] NOT NULL DEFAULT '{saturday,sunday}',
  emergency_guidance_text   TEXT,
  show_999_prompt           BOOLEAN NOT NULL DEFAULT true,
  -- Office hours JSONB: { monday: {open:'08:30', close:'17:30'}, ... }
  office_hours              JSONB,
  -- Correspondence style
  correspondence_tone       TEXT DEFAULT 'formal',   -- formal | semi-formal | plain
  correspondence_signoff    TEXT DEFAULT 'Yours sincerely',
  letterhead_storage_path   TEXT,
  standard_clauses          JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER firm_portal_config_updated_at
  BEFORE UPDATE ON firm_portal_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── maintenance_requests ──────────────────────────────────────────────────────
-- Emergency triage fields create an audit trail of the firm's duty-of-care process.
CREATE TABLE maintenance_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                 UUID NOT NULL REFERENCES firms(id),
  property_id             UUID NOT NULL REFERENCES properties(id),
  unit_id                 UUID NOT NULL REFERENCES units(id),
  leaseholder_id          UUID REFERENCES leaseholders(id),
  description             TEXT NOT NULL,
  reported_date           DATE NOT NULL DEFAULT CURRENT_DATE,
  reported_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  priority                TEXT NOT NULL DEFAULT 'normal',
  -- emergency | high | normal | low
  status                  TEXT NOT NULL DEFAULT 'open',
  -- open | acknowledged | in_progress | resolved | closed | rejected
  works_order_id          UUID REFERENCES works_orders(id),
  acknowledged_at         TIMESTAMPTZ,
  resolved_date           DATE,
  resolution_notes        TEXT,
  -- Emergency triage audit trail fields (Section 5.2)
  submitted_out_of_hours  BOOLEAN NOT NULL DEFAULT false,
  emergency_triage_shown  BOOLEAN NOT NULL DEFAULT false,
  emergency_self_declared BOOLEAN,  -- true=yes, false=no, null=not shown
  triage_timestamp        TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER maintenance_requests_updated_at
  BEFORE UPDATE ON maintenance_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_mr_firm ON maintenance_requests(firm_id);
CREATE INDEX idx_mr_property ON maintenance_requests(property_id);
CREATE INDEX idx_mr_status ON maintenance_requests(status);

-- ── portal_messages ───────────────────────────────────────────────────────────
CREATE TABLE portal_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firms(id),
  property_id     UUID NOT NULL REFERENCES properties(id),
  unit_id         UUID REFERENCES units(id),
  thread_id       UUID,
  from_user_id    UUID REFERENCES users(id),
  to_user_id      UUID REFERENCES users(id),
  direction       TEXT NOT NULL,   -- inbound | outbound
  subject         TEXT,
  body            TEXT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at         TIMESTAMPTZ,
  document_ids    UUID[]
);

CREATE INDEX idx_portal_messages_firm ON portal_messages(firm_id);
CREATE INDEX idx_portal_messages_thread ON portal_messages(thread_id);

-- ── meetings ──────────────────────────────────────────────────────────────────
CREATE TABLE meetings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               UUID NOT NULL REFERENCES firms(id),
  property_id           UUID NOT NULL REFERENCES properties(id),
  meeting_type          TEXT NOT NULL,
  -- agm | egm | directors | working_group
  scheduled_date        TIMESTAMPTZ NOT NULL,
  location              TEXT,
  quorum_required       INTEGER,
  quorum_met            BOOLEAN,
  status                TEXT NOT NULL DEFAULT 'scheduled',
  -- scheduled | held | cancelled | postponed
  minutes_document_id   UUID REFERENCES documents(id),
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER meetings_updated_at
  BEFORE UPDATE ON meetings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_meetings_firm ON meetings(firm_id);
CREATE INDEX idx_meetings_property ON meetings(property_id);
