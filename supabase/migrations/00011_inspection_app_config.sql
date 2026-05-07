-- Migration: 00011_inspection_app_config
-- Purpose: Section 4.9 — Inspection App white-label configuration.
-- firm_inspection_config, inspection_report_links.
-- The Inspection App itself is NOT modified in Phases 1-6 (Section 1.4 note).

-- ── firm_inspection_config ────────────────────────────────────────────────────
-- One row per firm. Controls branding and content of the field inspection tool.
-- Changes are reflected in the Inspection App without a code deploy.
CREATE TABLE firm_inspection_config (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                     UUID NOT NULL REFERENCES firms(id) UNIQUE,
  app_name                    TEXT NOT NULL DEFAULT 'Property Inspection',
  logo_storage_path           TEXT,
  report_header_text          TEXT,
  report_footer_text          TEXT,
  primary_colour              TEXT DEFAULT '1B3A5C',
  -- hex colour, used in report branding
  inspection_sections         JSONB,
  -- array of { section_name, order, required, description }
  defect_categories           JSONB,
  -- array of { category_name, trade, default_priority }
  auto_create_works_order     BOOLEAN NOT NULL DEFAULT true,
  works_order_review_required BOOLEAN NOT NULL DEFAULT true,
  include_photos_in_report    BOOLEAN NOT NULL DEFAULT true,
  include_bsa_section         BOOLEAN NOT NULL DEFAULT false,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER firm_inspection_config_updated_at
  BEFORE UPDATE ON firm_inspection_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── inspection_report_links ───────────────────────────────────────────────────
-- Bridge table linking Inspection App report IDs to PropOS records.
-- Does not duplicate report content — the Inspection App owns the report data.
CREATE TABLE inspection_report_links (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                 UUID NOT NULL REFERENCES firms(id),
  property_id             UUID NOT NULL REFERENCES properties(id),
  inspection_app_report_id TEXT NOT NULL,
  inspection_date         DATE NOT NULL,
  inspected_by            UUID REFERENCES users(id),
  report_document_id      UUID REFERENCES documents(id),
  defect_count            INTEGER DEFAULT 0,
  works_orders_created    INTEGER DEFAULT 0,
  synced_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_irl_firm ON inspection_report_links(firm_id);
CREATE INDEX idx_irl_property ON inspection_report_links(property_id);
