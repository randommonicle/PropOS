-- Migration: 00007_documents
-- Purpose: Section 4.5 — Central document vault.
-- property_id, unit_id, leaseholder_id are nullable:
--   a document can be firm-level, property-level, or unit-level.

CREATE TABLE documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           UUID NOT NULL REFERENCES firms(id),
  property_id       UUID REFERENCES properties(id),
  unit_id           UUID REFERENCES units(id),
  leaseholder_id    UUID REFERENCES leaseholders(id),
  document_type     TEXT NOT NULL,
  -- lease | certificate | insurance | invoice | report | notice | correspondence
  -- minutes | plans | golden_thread | compliance | other
  filename          TEXT NOT NULL,
  storage_path      TEXT NOT NULL,
  mime_type         TEXT,
  file_size_bytes   INTEGER,
  upload_date       TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by       UUID REFERENCES users(id),
  description       TEXT,
  tags              TEXT[],
  ai_summary        TEXT,           -- Claude-generated 2-3 sentence summary
  ai_extracted_data JSONB,          -- structured data extracted by Claude
  ai_processed_at   TIMESTAMPTZ,
  is_confidential   BOOLEAN NOT NULL DEFAULT false,
  retention_until   DATE,           -- GDPR retention date
  version_number    INTEGER NOT NULL DEFAULT 1,
  superseded_by     UUID REFERENCES documents(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_documents_firm ON documents(firm_id);
CREATE INDEX idx_documents_property ON documents(property_id);
CREATE INDEX idx_documents_type ON documents(document_type);
CREATE INDEX idx_documents_upload ON documents(upload_date);

-- Now that documents table exists, resolve forward refs from earlier migrations
ALTER TABLE compliance_items ADD CONSTRAINT fk_compliance_document FOREIGN KEY (document_id) REFERENCES documents(id);
ALTER TABLE insurance_policies ADD CONSTRAINT fk_insurance_document FOREIGN KEY (document_id) REFERENCES documents(id);
ALTER TABLE demands ADD CONSTRAINT fk_demands_document FOREIGN KEY (document_id) REFERENCES documents(id);
ALTER TABLE invoices ADD CONSTRAINT fk_invoices_document FOREIGN KEY (document_id) REFERENCES documents(id);

-- Storage bucket for documents (idempotent — Supabase ignores if already exists)
-- Note: bucket creation is done via the Supabase dashboard or CLI, not SQL.
-- This comment serves as the documentation reference.
-- Bucket name: 'documents' (see STORAGE_BUCKETS constant in app/src/lib/constants.ts)
-- Bucket settings: private (requires signed URL), max file size 50MB, allowed MIME types: all
