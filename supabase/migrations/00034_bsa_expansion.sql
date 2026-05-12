-- Migration: 00034_bsa_expansion
-- Purpose: Phase 4 BSA — Higher-Risk Building module expansion.
--
--   Builds on the 00009 baseline (buildings_bsa / golden_thread_records /
--   golden_thread_audit_log / bsa_mandatory_occurrences). The original 00009
--   surface modelled the Principal Accountable Person as a TEXT field on
--   buildings_bsa and the linked-document set as an inline UUID[] array on
--   golden_thread_records. Neither shape supports the RICS / Building Safety
--   Act 2022 — Higher-Risk Building regime adequately: multi-PAP is required
--   (corporate + resident accountable persons may coexist), per-link metadata
--   is required for the golden-thread document set, and Fire / Structural
--   Safety Strategies have no structured surface at all.
--
--   New tables (4):
--     - principal_accountable_persons  — junction; multi-PAP per HRB property
--                                         with role + lead-flag + audit-friendly
--                                         end-dating. Backs the BSA 2022 s.83 duty.
--     - building_safety_cases          — per-HRB living document with supersede
--                                         chain (mirrors golden_thread_records
--                                         immutability discipline). Backs BSA
--                                         2022 s.85.
--     - safety_strategies              — single discriminated table for fire +
--                                         structural strategies (matches the
--                                         action_type discriminator pattern from
--                                         payment_authorisations / 00023).
--                                         strategy_payload JSONB for type-
--                                         specific shape.
--     - golden_thread_documents        — proper junction replacing
--                                         golden_thread_records.document_ids[];
--                                         per-link metadata (primary / supporting /
--                                         superseded), unique-primary partial idx.
--                                         Mirrors the future lpe_pack_documents
--                                         shape (Phase 4c).
--
--   Schema extensions:
--     - buildings_bsa.safety_case_id          — FK to current building_safety_case.
--     - documents.document_type CHECK enum    — +6 BSA-specific values.
--     - golden_thread_records.document_ids[]  — DROPPED after junction backfill
--                                                (zero rows in demo — verified).
--     - buildings_bsa legacy PAP columns      — DROPPED after junction backfill
--                                                (zero rows in buildings_bsa today —
--                                                Birchwood seeded by this migration).
--
--   AUDIT R-8 close (BSA citation canonicalisation):
--     Canonical user-facing form: `Building Safety Act 2022 — Higher-Risk Building`.
--     UI strings + smokes move in lockstep — see Section L below for the file list.
--
-- Statutory anchors:
--   Building Safety Act 2022 s.78    — Mandatory occurrence reporting (existing
--                                       bsa_mandatory_occurrences; covered in 00009).
--   Building Safety Act 2022 s.83    — Principal Accountable Person duty;
--                                       multi-PAP / corporate + resident PAPs
--                                       supported via principal_accountable_persons.
--   Building Safety Act 2022 s.85    — Duty to compile and keep a Safety Case Report.
--   Building Safety Act 2022 s.88    — Golden Thread information requirements;
--                                       golden_thread_records remain IMMUTABLE
--                                       (no DELETE / UPDATE policies; see 00009 §6-7).
--   Building Safety Act 2022 s.91    — Resident Engagement Strategy; new document_type
--                                       enum value 'resident_engagement_strategy'.
--   Higher-Risk Buildings (Keeping   — Record-keeping obligations; golden_thread_documents
--     and Provision of Information)    junction supports per-link metadata required
--     Regulations 2024 (Reg 6)         for an evidentially-defensible audit trail.
--   RICS Code 4th ed.                — Major-works AP sign-off lane (FORWARD anchor
--                                       from 00028 §10; lands in Phase 4a invoicing).
--
-- Forward anchors (do not implement here):
--   FORWARD: documents.visible_to_leaseholder BOOLEAN — Phase 5 leaseholder portal
--     commit. MyBlockMan parity: per-document opt-in visibility, off by default
--     (build engineer holds the MyBlockMan user guide PDF as the spec source).
--   FORWARD: Phase 4a — major-works invoice AP sign-off lane consumes
--     principal_accountable_persons.id as the dual-auth-plus-one approver lane.
--     Closes the 00028 §10 FORWARD anchor (BSA HRB Accountable Person sign-off).
--   FORWARD: Phase 4c LPE pack — building_safety_cases + safety_strategies +
--     principal_accountable_persons feed §11_BSA section of HRB pack zip.
--   FORWARD: Phase 5 — golden_thread_documents DELETE policy: consider tightening
--     from admin-only to BLOCKED (mirror golden_thread_records immutability
--     discipline) once the UI surface is fully audited.
--   FORWARD: README.md phase roadmap rewrite — Phase 4 vs Phase 5 numbering is
--     stale on origin/main; opportunistic doc-only commit any time after 00034.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════════
-- Section A — principal_accountable_persons (junction)
--   Multi-PAP per HRB property. Each row is either a staff member (user_id set)
--   OR an external party (external_name set) — XOR check enforces exactly one
--   identity source. role∈{principal,accountable}; is_lead boolean with partial-
--   unique idx so at most one row per property is the lead.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE principal_accountable_persons (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             UUID NOT NULL REFERENCES firms(id),
  property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Staff PAP: user_id set, external_* fields NULL.
  external_name       TEXT,
  external_address    TEXT,
  external_email      TEXT,
  external_phone      TEXT,
  -- External PAP: external_name set, user_id NULL.
  role                TEXT NOT NULL,
  -- principal | accountable
  is_lead             BOOLEAN NOT NULL DEFAULT false,
  appointed_date      DATE NOT NULL,
  end_date            DATE,  -- NULL = currently appointed
  end_reason          TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pap_role_chk
    CHECK (role IN ('principal','accountable')),
  CONSTRAINT pap_identity_xor_chk
    CHECK ((user_id IS NOT NULL) <> (external_name IS NOT NULL)),
  CONSTRAINT pap_date_window_chk
    CHECK (end_date IS NULL OR end_date >= appointed_date)
);

CREATE TRIGGER principal_accountable_persons_updated_at
  BEFORE UPDATE ON principal_accountable_persons
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_pap_firm_id     ON principal_accountable_persons(firm_id);
CREATE INDEX idx_pap_property_id ON principal_accountable_persons(property_id);
CREATE INDEX idx_pap_user_id     ON principal_accountable_persons(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_pap_active      ON principal_accountable_persons(property_id) WHERE end_date IS NULL;

-- At most one lead PAP per property at any time.
CREATE UNIQUE INDEX uq_pap_one_lead_per_property
  ON principal_accountable_persons(property_id)
  WHERE is_lead AND end_date IS NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- Section B — building_safety_cases (supersede chain)
--   One CURRENT row per HRB property (partial-unique idx). Edits create a new
--   row pointing to the old via superseded_by_id; the old row flips
--   is_current_version=false. Mirrors golden_thread_records immutability
--   discipline (no updated_at on purpose).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE building_safety_cases (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                         UUID NOT NULL REFERENCES firms(id),
  property_id                     UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  version_number                  INTEGER NOT NULL DEFAULT 1,
  status                          TEXT NOT NULL,
  -- draft | submitted | accepted | revision_requested | superseded
  title                           TEXT NOT NULL,
  summary                         TEXT,
  prepared_by                     UUID REFERENCES users(id),
  prepared_at                     TIMESTAMPTZ,
  submitted_to_bsr_at             TIMESTAMPTZ,
  bsr_reference                   TEXT,
  bsr_acceptance_date             DATE,
  next_review_due                 DATE,
  safety_case_report_document_id  UUID REFERENCES documents(id),
  superseded_by_id                UUID REFERENCES building_safety_cases(id),
  is_current_version              BOOLEAN NOT NULL DEFAULT true,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- No updated_at: supersede pattern, new row per revision.
  CONSTRAINT bsc_status_chk
    CHECK (status IN ('draft','submitted','accepted','revision_requested','superseded'))
);

CREATE INDEX idx_bsc_firm_id     ON building_safety_cases(firm_id);
CREATE INDEX idx_bsc_property_id ON building_safety_cases(property_id);
CREATE INDEX idx_bsc_current     ON building_safety_cases(property_id) WHERE is_current_version;

-- At most one current case per property.
CREATE UNIQUE INDEX uq_bsc_one_current_per_property
  ON building_safety_cases(property_id)
  WHERE is_current_version;

-- ═════════════════════════════════════════════════════════════════════════════
-- Section C — safety_strategies (discriminated)
--   Single table for fire + structural strategies. strategy_type∈{fire,structural}
--   discriminator with strategy_payload JSONB for type-specific shape (matches
--   payment_authorisations.action_payload pattern from 00023). Mutable (updated_at
--   present) — status enum tracks current vs older rather than supersede chain.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE safety_strategies (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                  UUID NOT NULL REFERENCES firms(id),
  property_id              UUID NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  strategy_type            TEXT NOT NULL,
  -- fire | structural
  title                    TEXT NOT NULL,
  responsible_user_id      UUID REFERENCES users(id),
  responsible_external     TEXT,
  current_document_id      UUID REFERENCES documents(id),
  last_reviewed_date       DATE,
  next_review_due          DATE NOT NULL,
  review_frequency         INTERVAL NOT NULL DEFAULT INTERVAL '1 year',
  status                   TEXT NOT NULL,
  -- current | review_due | overdue | draft
  strategy_payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT safety_strategies_type_chk
    CHECK (strategy_type IN ('fire','structural')),
  CONSTRAINT safety_strategies_status_chk
    CHECK (status IN ('current','review_due','overdue','draft')),
  CONSTRAINT safety_strategies_review_window_chk
    CHECK (last_reviewed_date IS NULL OR next_review_due >= last_reviewed_date)
);

CREATE TRIGGER safety_strategies_updated_at
  BEFORE UPDATE ON safety_strategies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_safety_strategies_firm_id     ON safety_strategies(firm_id);
CREATE INDEX idx_safety_strategies_property_id ON safety_strategies(property_id);
CREATE INDEX idx_safety_strategies_type        ON safety_strategies(property_id, strategy_type);

-- At most one current row per (property, strategy_type) pairing.
CREATE UNIQUE INDEX uq_safety_strategies_one_current_per_type
  ON safety_strategies(property_id, strategy_type)
  WHERE status = 'current';

-- ═════════════════════════════════════════════════════════════════════════════
-- Section D — golden_thread_documents (junction)
--   Replaces the inline golden_thread_records.document_ids UUID[] (per-element
--   FK enforcement is impossible on an array; per-link metadata not modellable).
--   link_type∈{primary,supporting,superseded}; is_primary BOOLEAN with partial-
--   unique idx so at most one primary doc per record.
--
--   Junction rows are immutable (no updated_at) — golden-thread discipline.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE golden_thread_documents (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                  UUID NOT NULL REFERENCES firms(id),
  golden_thread_record_id  UUID NOT NULL REFERENCES golden_thread_records(id) ON DELETE RESTRICT,
  document_id              UUID NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  link_type                TEXT NOT NULL,
  -- primary | supporting | superseded
  is_primary               BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- No updated_at: junction rows immutable.
  CONSTRAINT gtd_link_type_chk
    CHECK (link_type IN ('primary','supporting','superseded')),
  CONSTRAINT gtd_unique_record_doc
    UNIQUE (golden_thread_record_id, document_id)
);

CREATE INDEX idx_gtd_firm_id     ON golden_thread_documents(firm_id);
CREATE INDEX idx_gtd_record_id   ON golden_thread_documents(golden_thread_record_id);
CREATE INDEX idx_gtd_document_id ON golden_thread_documents(document_id);

CREATE UNIQUE INDEX uq_gtd_one_primary_per_record
  ON golden_thread_documents(golden_thread_record_id)
  WHERE is_primary;

-- ═════════════════════════════════════════════════════════════════════════════
-- Section E — drop golden_thread_records.document_ids[] (after backfill)
--   Pre-check 2026-05-12 (worktree phase4-bsa): zero rows in golden_thread_records
--   on demo DB. Backfill loop is therefore a no-op; the array column is dropped
--   in the same statement set. If non-zero rows surface in a parallel commit
--   before apply, the UPDATE would migrate document_ids → golden_thread_documents
--   rows before the DROP.
-- ═════════════════════════════════════════════════════════════════════════════

-- Defensive backfill: any existing golden_thread_records with non-empty
-- document_ids gets junction rows created (link_type='supporting', is_primary=
-- false; primary cannot be inferred from a flat array).
INSERT INTO golden_thread_documents (firm_id, golden_thread_record_id, document_id, link_type, is_primary)
SELECT gtr.firm_id, gtr.id, doc_id, 'supporting', false
FROM golden_thread_records gtr
CROSS JOIN LATERAL unnest(gtr.document_ids) AS doc_id
WHERE gtr.document_ids IS NOT NULL
  AND array_length(gtr.document_ids, 1) > 0
  AND EXISTS (SELECT 1 FROM documents d WHERE d.id = doc_id)
ON CONFLICT (golden_thread_record_id, document_id) DO NOTHING;

ALTER TABLE golden_thread_records DROP COLUMN document_ids;

-- ═════════════════════════════════════════════════════════════════════════════
-- Section F — buildings_bsa: add safety_case_id FK; drop legacy PAP TEXT cols
--   Pre-check 2026-05-12: zero rows in buildings_bsa on demo DB. Backfill loop
--   is a no-op; legacy columns drop cleanly. Defensive INSERT preserves any
--   prod PAP TEXT data into the new junction (one row per non-NULL TEXT field).
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE buildings_bsa
  ADD COLUMN safety_case_id UUID REFERENCES building_safety_cases(id);

CREATE INDEX idx_buildings_bsa_safety_case_id
  ON buildings_bsa(safety_case_id) WHERE safety_case_id IS NOT NULL;

-- Defensive backfill: any buildings_bsa row carrying a non-NULL
-- principal_accountable_person TEXT becomes an external PAP junction row.
-- hrb_confirmed_date used as appointed_date fallback; created_at if NULL.
INSERT INTO principal_accountable_persons (
  firm_id, property_id, external_name, external_email,
  role, is_lead, appointed_date, notes
)
SELECT
  b.firm_id, b.property_id, b.principal_accountable_person,
  b.principal_accountable_person_email,
  'principal', true,
  COALESCE(b.hrb_confirmed_date, b.created_at::date),
  'Backfilled from buildings_bsa.principal_accountable_person TEXT column (00034).'
FROM buildings_bsa b
WHERE b.principal_accountable_person IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM principal_accountable_persons pap
     WHERE pap.property_id = b.property_id AND pap.external_name = b.principal_accountable_person
  );

ALTER TABLE buildings_bsa
  DROP COLUMN principal_accountable_person,
  DROP COLUMN principal_accountable_person_email,
  DROP COLUMN accountable_persons;

-- ═════════════════════════════════════════════════════════════════════════════
-- Section G — documents.document_type CHECK extension
--   Drop the 00032-installed CHECK and replace with the union including 6 new
--   BSA-specific values. Postgres ENUMs deliberately avoided per 00032 §G5
--   (ALTER TYPE ADD VALUE is non-transactional; CHECK is the established pattern).
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE documents
  DROP CONSTRAINT documents_document_type_chk;

ALTER TABLE documents
  ADD CONSTRAINT documents_document_type_chk
  CHECK (document_type IN (
    -- 00032 baseline (30 values):
    'lease','certificate','insurance','invoice','report','notice','correspondence',
    'minutes','plans','golden_thread','compliance','other','general',
    'gas_safety','electrical_eicr','lift_loler','fra','ews1','asbestos_register',
    'accounts_audited','accounts_draft','budget','insurance_schedule','insurance_summary',
    's20_intent','s20_estimates','s20_award','health_safety','building_safety_case',
    'energy_performance',
    -- 00034 BSA additions (6):
    'resident_engagement_strategy',  -- Building Safety Act 2022 s.91
    'fire_strategy',
    'structural_strategy',
    'bsa_registration',              -- HRB registration with the Building Safety Regulator
    'bsa_compliance_notice',         -- BSR-issued compliance / improvement notice
    'pap_appointment_letter'         -- evidence of Principal Accountable Person appointment
  ));

-- ═════════════════════════════════════════════════════════════════════════════
-- Section H — Triggers (golden-thread audit + HRB-only gates + PAP min-active)
-- ═════════════════════════════════════════════════════════════════════════════

-- ── H.1 — HRB-only gate for building_safety_cases ────────────────────────────
-- Reject INSERT on building_safety_cases if property is not flagged HRB.
-- Authoritative source: properties.is_hrb (set when property is created;
-- 1:1-matched to buildings_bsa.is_hrb).
CREATE OR REPLACE FUNCTION bsc_enforce_hrb_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_hrb BOOLEAN;
BEGIN
  SELECT is_hrb INTO v_is_hrb FROM public.properties WHERE id = NEW.property_id;
  IF v_is_hrb IS NULL OR NOT v_is_hrb THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Building Safety Act 2022 — Higher-Risk Building: building_safety_cases may only be created for properties with properties.is_hrb=true',
      HINT    = 'Set properties.is_hrb=true (and create the matching buildings_bsa row) before inserting a building safety case.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION bsc_enforce_hrb_only() FROM PUBLIC;

CREATE TRIGGER bsc_hrb_only
  BEFORE INSERT ON building_safety_cases
  FOR EACH ROW EXECUTE FUNCTION bsc_enforce_hrb_only();

-- ── H.2 — HRB-only gate for safety_strategies ────────────────────────────────
CREATE OR REPLACE FUNCTION safety_strategies_enforce_hrb_only()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_hrb BOOLEAN;
BEGIN
  SELECT is_hrb INTO v_is_hrb FROM public.properties WHERE id = NEW.property_id;
  IF v_is_hrb IS NULL OR NOT v_is_hrb THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Building Safety Act 2022 — Higher-Risk Building: safety_strategies may only be created for properties with properties.is_hrb=true',
      HINT    = 'Set properties.is_hrb=true before inserting fire / structural safety strategies.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION safety_strategies_enforce_hrb_only() FROM PUBLIC;

CREATE TRIGGER strat_hrb_only
  BEFORE INSERT ON safety_strategies
  FOR EACH ROW EXECUTE FUNCTION safety_strategies_enforce_hrb_only();

-- ── H.3 — PAP min-one-active for HRB properties ──────────────────────────────
-- Reject UPDATE that sets end_date OR DELETE if it would leave an HRB property
-- with zero active PAPs. INSERT is unconstrained (always adds an active row).
CREATE OR REPLACE FUNCTION pap_enforce_min_one_active_hrb()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_hrb        BOOLEAN;
  v_active_count  INTEGER;
  v_property_id   UUID;
BEGIN
  v_property_id := COALESCE(NEW.property_id, OLD.property_id);
  SELECT is_hrb INTO v_is_hrb FROM public.properties WHERE id = v_property_id;
  IF v_is_hrb IS NULL OR NOT v_is_hrb THEN
    RETURN COALESCE(NEW, OLD);  -- non-HRB: no minimum-PAP requirement.
  END IF;

  SELECT COUNT(*) INTO v_active_count
    FROM public.principal_accountable_persons
   WHERE property_id = v_property_id AND end_date IS NULL;

  IF v_active_count = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Building Safety Act 2022 — Higher-Risk Building: at least one active Principal Accountable Person must be appointed for an HRB property',
      HINT    = 'Appoint a replacement PAP (INSERT new row) before ending the last active appointment.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE EXECUTE ON FUNCTION pap_enforce_min_one_active_hrb() FROM PUBLIC;

CREATE TRIGGER pap_min_one_active
  AFTER UPDATE OR DELETE ON principal_accountable_persons
  FOR EACH ROW EXECUTE FUNCTION pap_enforce_min_one_active_hrb();

-- ── H.4 — Golden-thread audit on building_safety_cases INSERT ────────────────
-- BSA 2022 s.88 — every safety-case creation / revision is a golden-thread
-- event. Audit log row carries property_id + action='created' + structured
-- notes (subject_type:uuid) so post-hoc grep / index queries are tractable.
CREATE OR REPLACE FUNCTION bsc_write_golden_thread_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.golden_thread_audit_log
    (firm_id, property_id, action, performed_by, notes)
  VALUES
    (NEW.firm_id, NEW.property_id, 'created', auth.uid(),
     'bsa_case:' || NEW.id::text || ' status:' || NEW.status || ' version:' || NEW.version_number);
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION bsc_write_golden_thread_audit() FROM PUBLIC;

CREATE TRIGGER bsc_golden_thread_audit
  AFTER INSERT ON building_safety_cases
  FOR EACH ROW EXECUTE FUNCTION bsc_write_golden_thread_audit();

-- ── H.5 — Golden-thread audit on principal_accountable_persons INSERT ────────
CREATE OR REPLACE FUNCTION pap_write_golden_thread_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.golden_thread_audit_log
    (firm_id, property_id, action, performed_by, notes)
  VALUES
    (NEW.firm_id, NEW.property_id, 'created', auth.uid(),
     'pap:' || NEW.id::text || ' role:' || NEW.role || ' lead:' || NEW.is_lead::text);
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION pap_write_golden_thread_audit() FROM PUBLIC;

CREATE TRIGGER pap_golden_thread_audit
  AFTER INSERT ON principal_accountable_persons
  FOR EACH ROW EXECUTE FUNCTION pap_write_golden_thread_audit();

-- ═════════════════════════════════════════════════════════════════════════════
-- Section I — RLS policies (mirror 00031 / 00032 pattern)
--   firm-scoped SELECT; PM-tier writes via is_pm_or_admin(); admin-only DELETE.
--   Leaseholder read-all-in-firm on principal_accountable_persons (leaseholders
--   are legally entitled to know their PAP — BSA 2022 s.91 resident engagement).
--   Leaseholder read on own-property building_safety_cases (leaseholders may
--   request safety case extracts — BSA 2022 s.91).
--   No leaseholder read on safety_strategies (operational doc; staff-only).
--   No leaseholder read on golden_thread_documents (audit-grade; staff-only).
-- ═════════════════════════════════════════════════════════════════════════════

-- principal_accountable_persons
ALTER TABLE principal_accountable_persons ENABLE ROW LEVEL SECURITY;

CREATE POLICY pap_select ON principal_accountable_persons
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY pap_leaseholder_select ON principal_accountable_persons
  FOR SELECT USING (
    firm_id = auth_firm_id()
    AND auth_user_role() = 'leaseholder'
  );
-- Permissive policy combined with pap_select via OR. Leaseholders see ALL PAPs
-- in their firm (BSA 2022 s.91 — leaseholders are entitled to know the AP for
-- any HRB they may live in or visit; not just their own block).

CREATE POLICY pap_insert ON principal_accountable_persons
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY pap_update ON principal_accountable_persons
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY pap_delete ON principal_accountable_persons
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

-- building_safety_cases
ALTER TABLE building_safety_cases ENABLE ROW LEVEL SECURITY;

-- Firm-wide SELECT is restricted to STAFF (auth_user_role <> 'leaseholder')
-- so the leaseholder policy below is the ONLY path leaseholders take. Without
-- the staff-only predicate the two policies OR-combine and leaseholders see
-- firm-wide cases (caught by smoke 9 in bsa-module.spec.ts). Pre-existing
-- 00032 emergency_contacts / interested_parties policies have the same shape
-- — FORWARD anchor for a Phase 5 RLS-tightening sweep (no functional impact
-- until leaseholder portal UI exists).
CREATE POLICY bsc_select ON building_safety_cases
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_user_role() <> 'leaseholder');

CREATE POLICY bsc_leaseholder_select ON building_safety_cases
  FOR SELECT USING (
    firm_id = auth_firm_id()
    AND auth_user_role() = 'leaseholder'
    AND property_id IN (
      SELECT u.property_id FROM public.units u
      JOIN public.leaseholders lh ON lh.unit_id = u.id
       WHERE lh.user_id = auth.uid() AND lh.is_current = true
    )
  );
-- Leaseholders see safety cases for properties where they hold a current
-- leasehold interest. Mirrors emergency_contacts_leaseholder_select from 00032.

CREATE POLICY bsc_insert ON building_safety_cases
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY bsc_update ON building_safety_cases
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY bsc_delete ON building_safety_cases
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

-- safety_strategies
ALTER TABLE safety_strategies ENABLE ROW LEVEL SECURITY;

-- Staff-only SELECT (operational doc; not exposed to leaseholders). The
-- staff-only predicate is essential because permissive policies OR-combine —
-- a bare firm-wide policy would let leaseholders read. Auditor passes
-- (they're staff, not 'leaseholder'). See bsc_select comment above for the
-- pre-existing pattern leak noted as a Phase 5 FORWARD anchor.
CREATE POLICY safety_strategies_select ON safety_strategies
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_user_role() <> 'leaseholder');

CREATE POLICY safety_strategies_insert ON safety_strategies
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY safety_strategies_update ON safety_strategies
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY safety_strategies_delete ON safety_strategies
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

-- golden_thread_documents
ALTER TABLE golden_thread_documents ENABLE ROW LEVEL SECURITY;

-- Staff-only SELECT (audit-grade junction; not exposed to leaseholders).
-- Same staff-only predicate rationale as building_safety_cases / safety_strategies.
CREATE POLICY gtd_select ON golden_thread_documents
  FOR SELECT USING (firm_id = auth_firm_id() AND auth_user_role() <> 'leaseholder');

CREATE POLICY gtd_insert ON golden_thread_documents
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

-- Junction rows are immutable in spirit (per golden-thread discipline), but a
-- repointing UPDATE may be necessary for primary-flag corrections. Restrict to
-- PM-tier. FORWARD anchor: tighten to BLOCKED in Phase 5 if UI surface allows.
CREATE POLICY gtd_update ON golden_thread_documents
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY gtd_delete ON golden_thread_documents
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_user_role() = 'admin');

-- ═════════════════════════════════════════════════════════════════════════════
-- Section J — Demo seed for Birchwood Court (the seeded HRB fixture)
--   Birchwood Court: is_hrb=true, storey_count=12, height_metres=38.5
--   (seeded by supabase/seed/demo_seed.mjs into properties; buildings_bsa row
--   not previously seeded — created here so the new tables can chain off it).
--
--   Seed contents:
--     - 1 buildings_bsa row for Birchwood (was missing; needed for completeness)
--     - 2 PAP rows: corporate (external_name=Birchwood RMC) + resident
--                    (user_id=leaseholder@propos.local) — exercises both XOR branches
--     - 1 building_safety_case row (status='accepted', BSR accepted Apr 2024)
--     - 2 safety_strategies rows (fire + structural, both status='current')
--     - 2 golden_thread_records rows (design + safety_assessment)
--   Idempotent via NOT EXISTS guards.
-- ═════════════════════════════════════════════════════════════════════════════

-- J.1 — buildings_bsa row for Birchwood (HRB metadata catch-up)
INSERT INTO buildings_bsa (
  firm_id, property_id, is_hrb, hrb_confirmed_date,
  height_metres, storey_count, residential_unit_count,
  hrb_registration_number, hrb_registration_date,
  bac_status, mandatory_occurrence_reporting,
  notes
)
SELECT
  f.id, p.id, true, DATE '2024-04-01',
  38.5, 12, 3,
  'HRB-2024-DEMO-001', DATE '2024-04-01',
  'issued', true,
  'Demo seed (00034) — Birchwood Court HRB fixture for Phase 4 BSA module.'
FROM firms f
JOIN properties p ON p.firm_id = f.id AND p.name = 'Birchwood Court'
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM buildings_bsa b WHERE b.property_id = p.id
  );

-- J.2 — building_safety_case row (status='accepted')
INSERT INTO building_safety_cases (
  firm_id, property_id, version_number, status, title, summary,
  prepared_at, submitted_to_bsr_at, bsr_reference, bsr_acceptance_date,
  next_review_due, is_current_version
)
SELECT
  f.id, p.id, 1, 'accepted',
  'Birchwood Court Safety Case Report — v1',
  'Initial Safety Case Report submitted under Building Safety Act 2022 s.85. Accepted by the Building Safety Regulator on 2024-04-15.',
  TIMESTAMPTZ '2024-03-20 09:00:00+00',
  TIMESTAMPTZ '2024-04-01 14:30:00+00',
  'BSR-SCR-2024-DEMO-001',
  DATE '2024-04-15',
  DATE '2027-04-15',
  true
FROM firms f
JOIN properties p ON p.firm_id = f.id AND p.name = 'Birchwood Court'
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM building_safety_cases bsc
     WHERE bsc.property_id = p.id AND bsc.is_current_version
  );

-- J.3 — buildings_bsa.safety_case_id pointer
UPDATE buildings_bsa b
   SET safety_case_id = bsc.id
  FROM building_safety_cases bsc, firms f, properties p
 WHERE b.firm_id = f.id
   AND f.slug = 'demo-firm'
   AND p.firm_id = f.id
   AND p.name = 'Birchwood Court'
   AND b.property_id = p.id
   AND bsc.property_id = p.id
   AND bsc.is_current_version
   AND b.safety_case_id IS NULL;

-- J.4 — Corporate PAP (Birchwood Court RMC; external_name branch)
INSERT INTO principal_accountable_persons (
  firm_id, property_id, external_name, external_address, external_email,
  role, is_lead, appointed_date, notes
)
SELECT
  f.id, p.id,
  'Birchwood Court (RMC) Limited',
  '45 Oak Avenue, Manchester, M1 2CD',
  'directors@birchwood-rmc.co.uk',
  'principal', true, DATE '2024-04-01',
  'Demo seed (00034) — corporate Principal Accountable Person (the RMC itself).'
FROM firms f
JOIN properties p ON p.firm_id = f.id AND p.name = 'Birchwood Court'
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM principal_accountable_persons pap
     WHERE pap.property_id = p.id AND pap.external_name = 'Birchwood Court (RMC) Limited'
  );

-- J.5 — Resident PAP (leaseholder@propos.local; user_id branch)
INSERT INTO principal_accountable_persons (
  firm_id, property_id, user_id,
  role, is_lead, appointed_date, notes
)
SELECT
  f.id, p.id, u.id,
  'accountable', false, DATE '2024-04-01',
  'Demo seed (00034) — resident accountable person (BSA 2022 s.83 secondary AP).'
FROM firms f
JOIN properties p ON p.firm_id = f.id AND p.name = 'Birchwood Court'
JOIN users u      ON u.firm_id = f.id AND u.email = 'leaseholder@propos.local'
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM principal_accountable_persons pap
     WHERE pap.property_id = p.id AND pap.user_id = u.id
  );

-- J.6 — Fire safety strategy
INSERT INTO safety_strategies (
  firm_id, property_id, strategy_type, title,
  responsible_external, last_reviewed_date, next_review_due, status,
  strategy_payload, notes
)
SELECT
  f.id, p.id, 'fire',
  'Birchwood Court — Fire Safety Strategy 2024',
  'Birchwood Court (RMC) Limited via PK Fire Consultants Ltd',
  DATE '2024-04-01', DATE '2025-04-01', 'current',
  jsonb_build_object(
    'evacuation_strategy',   'stay_put',
    'compartmentation',      'fully_compartmented',
    'sprinkler_coverage',    'common_parts_only',
    'fra_reference',         'FRA-2024-BIRCH-001'
  ),
  'Demo seed (00034) — fire safety strategy per BSA 2022 / Fire Safety (England) Regulations 2022.'
FROM firms f
JOIN properties p ON p.firm_id = f.id AND p.name = 'Birchwood Court'
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM safety_strategies s
     WHERE s.property_id = p.id AND s.strategy_type = 'fire' AND s.status = 'current'
  );

-- J.7 — Structural safety strategy
INSERT INTO safety_strategies (
  firm_id, property_id, strategy_type, title,
  responsible_external, last_reviewed_date, next_review_due, status,
  strategy_payload, notes
)
SELECT
  f.id, p.id, 'structural',
  'Birchwood Court — Structural Safety Strategy 2024',
  'Carter Engineering Ltd (Chartered Structural Engineers)',
  DATE '2024-04-01', DATE '2026-04-01', 'current',
  jsonb_build_object(
    'inspection_frequency',  'biennial',
    'construction_type',     'reinforced_concrete_frame',
    'last_intrusive_survey', '2023-09-12',
    'movement_monitoring',   'quarterly'
  ),
  'Demo seed (00034) — structural safety strategy per BSA 2022 / Building Regulations Approved Document A.'
FROM firms f
JOIN properties p ON p.firm_id = f.id AND p.name = 'Birchwood Court'
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM safety_strategies s
     WHERE s.property_id = p.id AND s.strategy_type = 'structural' AND s.status = 'current'
  );

-- J.8 — Golden-thread records (design + safety_assessment categories)
INSERT INTO golden_thread_records (
  firm_id, property_id, record_type, title, description,
  event_date, is_safety_critical, version_number, is_current_version
)
SELECT
  f.id, p.id, 'design',
  'Original construction drawings — Birchwood Court',
  'As-built drawings retained from 2018 construction. RIBA Stage 6 handover pack.',
  DATE '2018-04-01', true, 1, true
FROM firms f
JOIN properties p ON p.firm_id = f.id AND p.name = 'Birchwood Court'
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM golden_thread_records gtr
     WHERE gtr.property_id = p.id AND gtr.title = 'Original construction drawings — Birchwood Court'
  );

INSERT INTO golden_thread_records (
  firm_id, property_id, record_type, title, description,
  event_date, is_safety_critical, version_number, is_current_version
)
SELECT
  f.id, p.id, 'safety_assessment',
  'Safety Case Report acceptance — BSR 2024-04-15',
  'Building Safety Regulator accepted the v1 Safety Case Report submitted 2024-04-01. Reference BSR-SCR-2024-DEMO-001.',
  DATE '2024-04-15', true, 1, true
FROM firms f
JOIN properties p ON p.firm_id = f.id AND p.name = 'Birchwood Court'
WHERE f.slug = 'demo-firm'
  AND NOT EXISTS (
    SELECT 1 FROM golden_thread_records gtr
     WHERE gtr.property_id = p.id AND gtr.title = 'Safety Case Report acceptance — BSR 2024-04-15'
  );

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (run immediately after migration; paste results back)
-- Memory rule: migration plan must include the verification query (state-test,
-- distinct from runtime smokes).
-- ═════════════════════════════════════════════════════════════════════════════

-- Q1: four new tables present with RLS enabled
--   expect 4 rows, all rowsecurity=true
-- SELECT tablename, rowsecurity FROM pg_tables
--  WHERE schemaname = 'public'
--    AND tablename IN ('principal_accountable_persons','building_safety_cases',
--                      'safety_strategies','golden_thread_documents')
--  ORDER BY tablename;

-- Q2: RLS policy count per new table
--   expect: principal_accountable_persons=5 (incl. leaseholder_select),
--           building_safety_cases=5 (incl. leaseholder_select),
--           safety_strategies=4, golden_thread_documents=4
-- SELECT tablename, COUNT(*) AS policy_count FROM pg_policies
--  WHERE tablename IN ('principal_accountable_persons','building_safety_cases',
--                      'safety_strategies','golden_thread_documents')
--  GROUP BY tablename ORDER BY tablename;

-- Q3: Birchwood Court seed populated end-to-end
--   expect (joined to Birchwood property_id):
--     buildings_bsa                       = 1 row
--     building_safety_cases is_current    = 1 row
--     principal_accountable_persons active= 2 rows (corporate + resident)
--     safety_strategies status='current'  = 2 rows (fire + structural)
--     golden_thread_records is_current    = 2 rows
-- SELECT 'buildings_bsa' AS t, COUNT(*) FROM buildings_bsa b
--   JOIN properties p ON p.id=b.property_id WHERE p.name='Birchwood Court'
-- UNION ALL SELECT 'bsc_current', COUNT(*) FROM building_safety_cases bsc
--   JOIN properties p ON p.id=bsc.property_id WHERE p.name='Birchwood Court' AND bsc.is_current_version
-- UNION ALL SELECT 'pap_active', COUNT(*) FROM principal_accountable_persons pap
--   JOIN properties p ON p.id=pap.property_id WHERE p.name='Birchwood Court' AND pap.end_date IS NULL
-- UNION ALL SELECT 'safety_strategies_current', COUNT(*) FROM safety_strategies s
--   JOIN properties p ON p.id=s.property_id WHERE p.name='Birchwood Court' AND s.status='current'
-- UNION ALL SELECT 'gtr_current', COUNT(*) FROM golden_thread_records gtr
--   JOIN properties p ON p.id=gtr.property_id WHERE p.name='Birchwood Court' AND gtr.is_current_version;

-- Q4: golden_thread_audit_log entries from BSA seed
--   expect ≥3 rows for Birchwood property: 1 from bsc INSERT + 2 from pap INSERTs.
-- SELECT COUNT(*) FROM golden_thread_audit_log gtal
--   JOIN properties p ON p.id=gtal.property_id
--  WHERE p.name='Birchwood Court'
--    AND (gtal.notes LIKE 'bsa_case:%' OR gtal.notes LIKE 'pap:%');

-- Q5: every HRB property has ≥1 active PAP (BSA 2022 s.83 invariant)
--   expect 0 rows (violation set)
-- SELECT p.id, p.name FROM properties p
--  WHERE p.is_hrb = true
--    AND NOT EXISTS (
--      SELECT 1 FROM principal_accountable_persons pap
--       WHERE pap.property_id = p.id AND pap.end_date IS NULL
--    );
