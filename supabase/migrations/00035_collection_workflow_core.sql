-- Migration: 00035_collection_workflow_core
-- Purpose: Phase 4a — Collection workflow core (regulatory backbone).
--
--   Establishes the seven-stage notice-stage state machine on `demands`, the
--   canonical letter-event surface (`notice_letters_sent`), the LTA 1985 sch.11
--   administration-charges regime, lease-clause-gated interest accrual, the
--   LPA 1925 s.146 forfeiture action surface, and the pg_cron handoff queue
--   feeding the existing `dispatch-engine` Edge Function.
--
--   This is the regulatory core. Supporting modules (payment mandates / ground
--   rent remittance / charge schedules / issues tracker) ship in 00036 — same
--   PR, applied sequentially.
--
--   New tables (7):
--     - block_collection_settings   — per-block reminder cadence + admin-fee
--                                     defaults + interest-clause fallback.
--                                     Established BEFORE the trigger surfaces
--                                     that reference its FK.
--     - notice_letters_sent         — canonical letter-event log. INSERT-only
--                                     by RLS (no UPDATE policy — immutable
--                                     audit, mirrors golden_thread_records
--                                     discipline from 00009/00034). Backs the
--                                     Blockman parity SC History "Message" /
--                                     "SN" columns.
--     - administration_charges      — LTA 1985 sch.11 / CLRA 2002 sch.11
--                                     variable admin charges; own statutory
--                                     "summary of rights" enforceability gate
--                                     mirroring the s.153 pattern from 00032.
--     - demand_interest_charges     — Q2-decided: lease-clause-only in 00035.
--                                     statutory_court_rate FORWARD-anchored
--                                     to the CCJ-tracking commit.
--     - forfeiture_actions          — LPA 1925 s.146; 14-day grace period +
--                                     mortgagee-served-before-claim trigger.
--                                     References interested_parties (00032)
--                                     for the mortgagee FK.
--     - notice_dispatch_queue       — pg_cron / Edge Function handoff queue.
--                                     pg_cron enqueues; dispatch-engine drains
--                                     via FOR UPDATE SKIP LOCKED.
--     - golden_thread_audit_log     — (existing from 00009; not new here, but
--                                     used as audit sink for forfeiture and
--                                     payment-authorisation state transitions
--                                     via existing triggers).
--
--   Schema extensions:
--     - demands.notice_stage              — seven-stage CHECK enum + two
--                                            terminal lateral states
--                                            (settled/withdrawn).
--     - demands.with_solicitor            — GENERATED ALWAYS AS (stage IN
--                                            solicitor/legal) STORED.
--                                            Blockman Overdue Units parity.
--     - demands.demand_reference          — TEXT, app-populated (format
--                                            {seq}/{unit_ref} per Blockman).
--                                            Sequence enforcement FORWARD.
--     - demands.s20b_notified_date        — LTA 1985 s.20B(2) notice anchor.
--     - demands.earliest_unbilled_cost_date — anchors the 18-month clock.
--     - unit_leases.interest_clause_*     — four new columns + coherence CHK.
--     - payment_authorisations.action_type CHECK enum — +3 values:
--         solicitor_escalation, commence_possession_proceedings,
--         major_works_invoice_ap_signoff. Closes 00028 §10 FORWARD anchor.
--     - documents.document_type CHECK enum — +4 letter-PDF values:
--         notice_letter_reminder, notice_letter_final,
--         notice_letter_solicitor, notice_letter_s146.
--     - unit_ledger_history view          — UNION of transactions +
--                                            notice_letters_sent +
--                                            administration_charges +
--                                            demand_interest_charges per unit.
--                                            Security-invoker (RLS bubbles up).
--
--   Triggers (5):
--     - demands_notice_stage_transition         — forward-only by default;
--                                                  PA gate on the two
--                                                  consequential edges; admin
--                                                  override for reverse.
--     - demands_s20b_18mo_chk                   — LTA 1985 s.20B(1) blocks
--                                                  status='issued' after 540
--                                                  days unless s.20B notice
--                                                  date present.
--     - enforce_interest_clause_present         — blocks INSERT into
--                                                  demand_interest_charges
--                                                  when unit_lease has no
--                                                  contractual interest basis.
--     - enforce_admin_charge_summary_of_rights  — LTA 1985 sch.11 para 4
--                                                  enforceability gate, mirrors
--                                                  the 00032 s.153 pattern.
--     - forfeiture_stage_transition             — forward-only stage chain
--                                                  + 14-day grace period
--                                                  + mortgagee-served-before-
--                                                  possession-claim.
--
--   pg_cron jobs (1):
--     - progress_demand_notice_stages()  — daily 06:00 UTC. Walks demands
--                                          due_date vs block_collection_settings
--                                          thresholds; advances stages up to
--                                          pre_action (auto-progression stops
--                                          before the PA-gated edges by design);
--                                          enqueues notice_dispatch_queue rows.
--                                          SECURITY DEFINER, service_role owned.
--
-- Statutory anchors:
--   LTA 1985 s.20B(1)/(2)        — 18-month rule on demands for service-charge
--                                   costs incurred more than 18 months prior
--                                   to demand. DB-enforced via trigger
--                                   `demands_s20b_18mo_chk`. Previously slated
--                                   for the financial-rules Edge Function
--                                   (00005 line 81) — now belt-and-braces in
--                                   DB.
--   LTA 1985 s.21B + 2007 Regs   — summary of rights & obligations mandatory
--                                   on demands. Existing `demands.s21b_attached`
--                                   (00005:97) remains the gate; unchanged here.
--   LTA 1985 sch.11 / CLRA 2002  — variable administration charges regime.
--     sch.11                       Separate enforceability summary; mirrored
--                                  via administration_charges.summary_of_rights_attached
--                                  + trigger gate on status='demanded'.
--   LTA 1987 ss.47-48            — landlord name + address on demands. Existing
--                                   `demands.section_153_compliant` (00032)
--                                   remains the gate; unchanged here.
--   CLRA 2002 s.153              — demand enforceability via s.47/s.48 service.
--                                   Existing trigger (00032) remains.
--   LPA 1925 s.146               — forfeiture pre-action requirements;
--                                   14-day grace period after service;
--                                   mortgagee service requirement (uses
--                                   interested_parties from 00032).
--   County Courts Act 1984 s.69  — judgment interest rate (currently 8%);
--                                   FORWARD-anchored to CCJ-tracking commit.
--   RICS Code 4th ed.            — §6 collection / §7 escalation. Dual-auth
--     (eff. 2026-04-07)            gate on solicitor referral + possession
--                                  proceedings via the payment_authorisations
--                                  action_type extension.
--   TPI Consumer Charter Ed.3    — fair-treatment standards for arrears;
--     (eff. 2025-01-01)            reflected in the auto-progression cadence
--                                  defaults (14/28/42/60 days).
--   Building Safety Act 2022     — major-works invoice AP sign-off lane on
--                                  HRB properties uses the new action_type
--                                  major_works_invoice_ap_signoff against
--                                  principal_accountable_persons (00034). This
--                                  CLOSES the 00028 §10 FORWARD anchor.
--
-- Forward anchors (do not implement here):
--   FORWARD: `statutory_court_rate` interest accrual basis — lands with the
--     CCJ tracking commit (Phase 4a→4b boundary). The CHECK enum on
--     demand_interest_charges.accrual_basis is intentionally one-value-only
--     until CCJ infrastructure exists.
--   FORWARD: Leaseholder portal SELECT policies on notice_letters_sent,
--     administration_charges, demand_interest_charges, forfeiture_actions —
--     Phase 5 leaseholder portal commit. All staff-only in 00035 (same
--     posture as 00032 interested_parties).
--   FORWARD: Free-tier Supabase project auto-pause defeats pg_cron after
--     1 week of inactivity. PROD-GATE manifest item — Pro-tier upgrade
--     required pre-launch.
--   FORWARD: Financial-rules Edge Function — the 5 .fixme'd flows in
--     bank-accounts.spec.ts + payment-authorisations.spec.ts remain pending;
--     some collection paths (e.g. solicitor-fee passthrough on
--     administration_charges) will gain belt-and-braces enforcement when
--     the Edge Function lands.
--   FORWARD: demand_reference uniqueness — column is TEXT nullable in 00035
--     pending app-layer sequence generator. Consider per-property uniqueness
--     once volume justifies (Phase 4b).
--   FORWARD: Letter template renderer — HTML→PDF for the reminder/STD/FN/SOL
--     letter bodies with the s.47/s.48 + s.21B + sch.11 prescribed blocks.
--     Extends dispatch-engine Edge Function. Required for notice_dispatch_queue
--     to actually generate PDFs in production. 00035 ships schema + queue +
--     state machine; template renderer is a separate commit (Phase 4a/UX).
--   FORWARD: notice_letters_sent.balance_snapshot JSONB shape validation —
--     deferred to template-renderer commit where the snapshot writer lives.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════════
-- Section A — block_collection_settings (per-block cadence + admin-fee defaults)
--   Established FIRST so trigger surfaces below can FK / read from it. One row
--   per property. PM-tier editable. interest_clause_default_* feeds the
--   demand_interest_charges trigger when the unit_lease itself has no override.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE block_collection_settings (
  property_id                          UUID PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  firm_id                              UUID NOT NULL REFERENCES firms(id),
  -- Cadence (days after demand due_date)
  reminder_1_days_after_due            INTEGER NOT NULL DEFAULT 14,
  reminder_2_days_after_due            INTEGER NOT NULL DEFAULT 28,
  final_notice_days_after_due          INTEGER NOT NULL DEFAULT 42,
  pre_action_days_after_due            INTEGER NOT NULL DEFAULT 60,
  auto_progress_enabled                BOOLEAN NOT NULL DEFAULT true,
  -- Admin fee defaults (LTA 1985 sch.11)
  r1_admin_fee_net                     NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  r2_admin_fee_net                     NUMERIC(12,2) NOT NULL DEFAULT 60.00,
  fn1_admin_fee_net                    NUMERIC(12,2) NOT NULL DEFAULT 100.00,
  pre_action_admin_fee_net             NUMERIC(12,2) NOT NULL DEFAULT 150.00,
  default_vat_rate_pct                 NUMERIC(4,2)  NOT NULL DEFAULT 20.00,
  -- Interest-clause block-level fallback (overridden by unit_leases.interest_clause_*)
  interest_clause_default_present      BOOLEAN NOT NULL DEFAULT false,
  interest_clause_default_text         TEXT,
  interest_clause_default_rate_pct     NUMERIC(5,2),
  interest_clause_default_basis        TEXT,
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bcs_cadence_chk
    CHECK (reminder_1_days_after_due < reminder_2_days_after_due
           AND reminder_2_days_after_due < final_notice_days_after_due
           AND final_notice_days_after_due < pre_action_days_after_due),
  CONSTRAINT bcs_interest_default_coherence_chk
    CHECK (interest_clause_default_present = false
           OR (interest_clause_default_text IS NOT NULL
               AND interest_clause_default_rate_pct IS NOT NULL
               AND interest_clause_default_basis IN ('above_base_rate','fixed'))),
  CONSTRAINT bcs_admin_fees_non_negative_chk
    CHECK (r1_admin_fee_net >= 0
           AND r2_admin_fee_net >= 0
           AND fn1_admin_fee_net >= 0
           AND pre_action_admin_fee_net >= 0)
);

CREATE TRIGGER block_collection_settings_updated_at
  BEFORE UPDATE ON block_collection_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_bcs_firm_id ON block_collection_settings(firm_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- Section B — unit_leases.interest_clause_* extensions (G3 surface)
--   Per-unit override of block-level default. coherence_chk enforces all-or-
--   nothing — if present=true, the three describing columns MUST be populated.
--   FORWARD: trigger `enforce_interest_clause_present` (Section F) consults
--   this surface when accruing interest.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE unit_leases
  ADD COLUMN interest_clause_present     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN interest_clause_text        TEXT,
  ADD COLUMN interest_clause_rate_pct    NUMERIC(5,2),
  ADD COLUMN interest_clause_basis       TEXT;

ALTER TABLE unit_leases
  ADD CONSTRAINT unit_leases_interest_clause_coherence_chk
  CHECK (interest_clause_present = false
         OR (interest_clause_text IS NOT NULL
             AND interest_clause_rate_pct IS NOT NULL
             AND interest_clause_basis IN ('above_base_rate','fixed')));

COMMENT ON COLUMN unit_leases.interest_clause_present IS
  'Per-unit override: does this lease expressly provide for interest on arrears? LTA 1985 silent on pre-judgment interest — only contractually recoverable. When true, the three describing columns must be populated (coherence CHK).';

-- ═════════════════════════════════════════════════════════════════════════════
-- Section C — demands extensions (state machine + s.20B + parity columns)
--   Five new columns. notice_stage CHECK enum covers seven escalation states
--   plus two terminal lateral states (settled = paid in full; withdrawn =
--   demand cancelled). with_solicitor is a GENERATED STORED column for
--   Blockman Overdue Units parity. demand_reference is plain TEXT — app
--   populates {seq}/{unit_ref} per Blockman convention (sequence enforcement
--   FORWARD).
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE demands
  ADD COLUMN notice_stage                  TEXT    NOT NULL DEFAULT 'current',
  ADD COLUMN demand_reference              TEXT,
  ADD COLUMN s20b_notified_date            DATE,
  ADD COLUMN earliest_unbilled_cost_date   DATE,
  ADD COLUMN with_solicitor                BOOLEAN GENERATED ALWAYS AS
    (notice_stage IN ('solicitor_referred','legal_proceedings')) STORED;

ALTER TABLE demands
  ADD CONSTRAINT demands_notice_stage_chk
  CHECK (notice_stage IN (
    'current','reminder_1','reminder_2','final_notice',
    'pre_action','solicitor_referred','legal_proceedings',
    'settled','withdrawn'
  ));

CREATE INDEX idx_demands_notice_stage ON demands(notice_stage)
  WHERE notice_stage NOT IN ('settled','withdrawn');
CREATE INDEX idx_demands_with_solicitor ON demands(unit_id)
  WHERE with_solicitor = true;

COMMENT ON COLUMN demands.notice_stage IS
  'Seven-stage collection notice state machine + two terminal states. Forward-only progression except for admin override; pre_action→solicitor_referred and solicitor_referred→legal_proceedings require an accepted payment_authorisation (RICS dual-auth). settled = paid in full; withdrawn = demand cancelled. Auto-progression by pg_cron stops at pre_action by design.';

COMMENT ON COLUMN demands.with_solicitor IS
  'Generated column for Blockman Overdue Units report parity. True when notice_stage IN (solicitor_referred, legal_proceedings).';

-- ═════════════════════════════════════════════════════════════════════════════
-- Section D — demands_notice_stage_transition trigger
--   Forward-only progression in the main 7-stage chain. Reverse and lateral
--   transitions are admin-gated. The two consequential edges
--   (pre_action→solicitor_referred and solicitor_referred→legal_proceedings)
--   require an accepted payment_authorisation referencing this demand_id in
--   the proposed JSONB. settled and withdrawn are terminal states reachable
--   from any active stage (matches Blockman "Withdraw Demand" / "Mark Settled"
--   button semantic).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION enforce_notice_stage_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  stage_order TEXT[] := ARRAY['current','reminder_1','reminder_2','final_notice',
                              'pre_action','solicitor_referred','legal_proceedings'];
  old_idx INTEGER;
  new_idx INTEGER;
  pa_exists BOOLEAN;
BEGIN
  -- No-op if notice_stage unchanged
  IF OLD.notice_stage = NEW.notice_stage THEN
    RETURN NEW;
  END IF;

  -- Terminal-from-anywhere: settled / withdrawn always allowed (PM action)
  IF NEW.notice_stage IN ('settled','withdrawn') THEN
    RETURN NEW;
  END IF;

  -- Out of terminal: admin-only (correcting a mistaken settle/withdraw)
  IF OLD.notice_stage IN ('settled','withdrawn') THEN
    IF NOT auth_has_role('admin') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'Reverting from terminal notice_stage requires admin role',
        HINT    = 'Settled and withdrawn are terminal states; only admin may re-open a demand.';
    END IF;
    RETURN NEW;
  END IF;

  old_idx := array_position(stage_order, OLD.notice_stage);
  new_idx := array_position(stage_order, NEW.notice_stage);

  -- Reverse transition in main chain: admin only
  IF new_idx < old_idx AND NOT auth_has_role('admin') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Reverse notice_stage transition not permitted',
      HINT    = format('From %s to %s requires admin role; PM-tier may only progress forward.',
                       OLD.notice_stage, NEW.notice_stage);
  END IF;

  -- Consequential edge 1: pre_action → solicitor_referred requires PA
  IF OLD.notice_stage = 'pre_action' AND NEW.notice_stage = 'solicitor_referred' THEN
    SELECT EXISTS (
      SELECT 1 FROM payment_authorisations
       WHERE action_type = 'solicitor_escalation'
         AND status      = 'authorised'
         AND firm_id     = NEW.firm_id
         AND (proposed->>'demand_id')::uuid = NEW.id
    ) INTO pa_exists;
    IF NOT pa_exists THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'RICS dual-auth: solicitor referral requires accepted payment_authorisation of action_type=solicitor_escalation referencing this demand',
        HINT    = 'Request a Payment Authorisation with action_type=solicitor_escalation and proposed.demand_id=this demand. Two staff must approve (requester ≠ authoriser).';
    END IF;
  END IF;

  -- Consequential edge 2: solicitor_referred → legal_proceedings requires PA
  IF OLD.notice_stage = 'solicitor_referred' AND NEW.notice_stage = 'legal_proceedings' THEN
    SELECT EXISTS (
      SELECT 1 FROM payment_authorisations
       WHERE action_type = 'commence_possession_proceedings'
         AND status      = 'authorised'
         AND firm_id     = NEW.firm_id
         AND (proposed->>'demand_id')::uuid = NEW.id
    ) INTO pa_exists;
    IF NOT pa_exists THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'RICS dual-auth: possession proceedings require accepted payment_authorisation of action_type=commence_possession_proceedings referencing this demand',
        HINT    = 'Possession proceedings are near-irreversible (leaseholder may lose home). Request a Payment Authorisation with action_type=commence_possession_proceedings; two staff must approve.';
    END IF;
  END IF;

  -- Skip-ahead (more than one stage forward) only allowed for admin
  IF (new_idx - old_idx) > 1 AND NOT auth_has_role('admin') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Skip-ahead notice_stage transition not permitted for non-admin',
      HINT    = format('Cannot skip from %s to %s. Advance one stage at a time, or escalate to admin.',
                       OLD.notice_stage, NEW.notice_stage);
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION enforce_notice_stage_transition() FROM PUBLIC;

CREATE TRIGGER demands_notice_stage_transition
  BEFORE UPDATE OF notice_stage ON demands
  FOR EACH ROW EXECUTE FUNCTION enforce_notice_stage_transition();

-- ═════════════════════════════════════════════════════════════════════════════
-- Section E — demands_s20b_18mo_chk trigger
--   LTA 1985 s.20B(1): service-charge costs incurred more than 18 months
--   before the demand are unrecoverable UNLESS the leaseholder was notified
--   within those 18 months that the costs were incurred (s.20B(2) notice).
--   Trigger fires on transition into status='issued'. 540 days = 18 calendar
--   months conservatively (some leases / tribunals interpret differently;
--   conservative gate avoids unenforceable demands).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION enforce_s20b_18mo_rule()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  -- Only enforce on transition into 'issued'
  IF NEW.status = 'issued' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'issued') THEN
    -- Skip if no cost date anchor present — not all demand types track this
    IF NEW.earliest_unbilled_cost_date IS NULL THEN
      RETURN NEW;
    END IF;
    -- Skip ground-rent demands: s.20B applies to service charges only
    IF NEW.demand_type = 'ground_rent' THEN
      RETURN NEW;
    END IF;
    -- Compute days since earliest cost
    IF NEW.issued_date IS NOT NULL
       AND (NEW.issued_date - NEW.earliest_unbilled_cost_date) > 540
       AND NEW.s20b_notified_date IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'LTA 1985 s.20B(1): cannot issue demand for service charge costs incurred more than 18 months ago without prior s.20B(2) notice',
        HINT    = 'Either reduce the demand to costs incurred within the last 18 months, or serve an s.20B(2) notice on the leaseholder and set demands.s20b_notified_date.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION enforce_s20b_18mo_rule() FROM PUBLIC;

CREATE TRIGGER demands_s20b_18mo_chk
  BEFORE INSERT OR UPDATE OF status, earliest_unbilled_cost_date, s20b_notified_date ON demands
  FOR EACH ROW EXECUTE FUNCTION enforce_s20b_18mo_rule();

-- ═════════════════════════════════════════════════════════════════════════════
-- Section F — notice_letters_sent (canonical letter-event log)
--   Immutable audit table. RLS allows INSERT (PM-tier) and SELECT (staff-only)
--   but NO UPDATE policy — once a letter is sent, the record is frozen. Mirrors
--   the golden_thread_records discipline from 00009/00034.
--
--   letter_code is the Blockman parity surface (R1, R2, FN1, SOL1...). The
--   letter_type column gives the categorisation for filtering / reporting.
--   balance_snapshot JSONB captures the unit's ledger state at time-of-send
--   so reissuing the demand later doesn't retroactively change the historical
--   reminder PDF's numbers.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE notice_letters_sent (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                     UUID NOT NULL REFERENCES firms(id),
  demand_id                   UUID REFERENCES demands(id) ON DELETE RESTRICT,
  -- demand_id nullable: some letters (e.g. S20B notices) are unit-level, not
  -- tied to a specific demand.
  unit_id                     UUID NOT NULL REFERENCES units(id),
  leaseholder_id              UUID REFERENCES leaseholders(id),
  letter_code                 TEXT NOT NULL,
  letter_type                 TEXT NOT NULL,
  sequence_number             INTEGER,
  -- Per-unit running sequence (Blockman "SN" column); app populates.
  sent_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_method                 TEXT NOT NULL,
  document_id                 UUID REFERENCES documents(id),
  sent_by                     UUID REFERENCES users(id),
  -- NULL allowed: pg_cron / dispatch-engine generated letters have no human sender.
  recipient_address_snapshot  TEXT,
  recipient_email_snapshot    TEXT,
  balance_snapshot            JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Shape: { balance_forward, payments_received, charges_added, total_due }
  dispatched_via_dispatch_engine BOOLEAN NOT NULL DEFAULT false,
  resends_letter_id           UUID REFERENCES notice_letters_sent(id),
  -- NULL = original send (state-machine progression).
  -- NOT NULL = resend of a prior letter (e.g. post lost / wrong address).
  -- App-layer enforces letter_code matches the parent's; DB CHECK omitted
  -- (subqueries not permitted in CHECK). Trigger-based belt-and-braces is
  -- FORWARD-anchored.
  resend_reason               TEXT,
  -- Free-text PM justification when resends_letter_id IS NOT NULL.
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT nls_letter_code_chk
    CHECK (letter_code IN (
      'STD1','R1','R2','FN1','PA1','SOL1','POSS1','S20B','S146_NTC','GR_DEMAND'
    )),
  CONSTRAINT nls_letter_type_chk
    CHECK (letter_type IN (
      'demand','reminder','final_notice','pre_action','solicitor_referral',
      'possession_notice','s20b_notice','forfeiture_notice','ground_rent_demand'
    )),
  CONSTRAINT nls_sent_method_chk
    CHECK (sent_method IN ('post','email','myblockman_portal','hand_delivered'))
);

CREATE INDEX idx_nls_firm_id          ON notice_letters_sent(firm_id);
CREATE INDEX idx_nls_demand_id        ON notice_letters_sent(demand_id) WHERE demand_id IS NOT NULL;
CREATE INDEX idx_nls_unit_id          ON notice_letters_sent(unit_id);
CREATE INDEX idx_nls_sent_at          ON notice_letters_sent(sent_at);
CREATE INDEX idx_nls_letter_code      ON notice_letters_sent(letter_code);
CREATE INDEX idx_nls_resends_letter_id ON notice_letters_sent(resends_letter_id) WHERE resends_letter_id IS NOT NULL;

COMMENT ON TABLE notice_letters_sent IS
  'Canonical letter-event log for arrears collection (Blockman SC History "Message"/"SN" parity). Immutable audit: RLS allows INSERT + SELECT only, no UPDATE policy. balance_snapshot JSONB pins the unit ledger at time-of-send so retroactive ledger edits do not mutate historical PDFs. Re-sends use resends_letter_id self-FK + resend_reason (notice_stage stays put on re-send); fresh state-machine progressions have resends_letter_id=NULL.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Section G — administration_charges (LTA 1985 sch.11 / CLRA 2002 sch.11)
--   Variable admin charges (reminder admin fee, final-notice admin fee,
--   solicitor referral fee, etc.). Separate statutory regime from service
--   charges — own "summary of rights and obligations" form (CLRA 2002 sch.11
--   para 4) which is the enforceability gate. summary_of_rights_attached
--   BOOLEAN + trigger mirror the 00032 section_153 / 21B pattern.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE administration_charges (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                     UUID NOT NULL REFERENCES firms(id),
  unit_id                     UUID NOT NULL REFERENCES units(id),
  leaseholder_id              UUID NOT NULL REFERENCES leaseholders(id),
  demand_id                   UUID REFERENCES demands(id) ON DELETE RESTRICT,
  triggering_letter_id        UUID REFERENCES notice_letters_sent(id),
  charge_type                 TEXT NOT NULL,
  amount_net                  NUMERIC(12,2) NOT NULL,
  vat_rate_pct                NUMERIC(4,2)  NOT NULL DEFAULT 20.00,
  vat_amount                  NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  amount_gross                NUMERIC(12,2) NOT NULL,
  summary_of_rights_attached  BOOLEAN NOT NULL DEFAULT false,
  status                      TEXT NOT NULL DEFAULT 'pending',
  raised_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  raised_by                   UUID REFERENCES users(id),
  demanded_at                 TIMESTAMPTZ,
  disputed_at                 TIMESTAMPTZ,
  disputed_by                 UUID REFERENCES users(id),
  dispute_resolution          TEXT,
  linked_transaction_id       UUID REFERENCES transactions(id),
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_charges_charge_type_chk
    CHECK (charge_type IN (
      'reminder_admin_fee','final_notice_admin_fee','solicitor_referral_fee',
      'pre_action_admin_fee','court_fee_passthrough','other_admin_charge'
    )),
  CONSTRAINT admin_charges_status_chk
    CHECK (status IN ('pending','demanded','paid','disputed','waived','tribunal_struck_out')),
  CONSTRAINT admin_charges_amount_coherence_chk
    CHECK (amount_gross = amount_net + COALESCE(vat_amount, 0)),
  CONSTRAINT admin_charges_amounts_non_negative_chk
    CHECK (amount_net >= 0 AND vat_amount >= 0 AND amount_gross >= 0)
);

CREATE TRIGGER administration_charges_updated_at
  BEFORE UPDATE ON administration_charges
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_admin_charges_firm_id      ON administration_charges(firm_id);
CREATE INDEX idx_admin_charges_unit_id      ON administration_charges(unit_id);
CREATE INDEX idx_admin_charges_demand_id    ON administration_charges(demand_id) WHERE demand_id IS NOT NULL;
CREATE INDEX idx_admin_charges_status       ON administration_charges(status);

-- Enforceability gate: cannot transition status to 'demanded' without the
-- prescribed sch.11 summary of rights & obligations. Mirrors the 00032 s.153
-- trigger shape.
CREATE OR REPLACE FUNCTION enforce_admin_charge_summary_of_rights()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'demanded'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'demanded')
     AND NOT NEW.summary_of_rights_attached THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'CLRA 2002 sch.11 para 4: cannot demand an administration charge without serving the prescribed summary of tenants'' rights and obligations',
      HINT    = 'Attach the sch.11 summary to the demand and set administration_charges.summary_of_rights_attached=true before transitioning status to ''demanded''.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION enforce_admin_charge_summary_of_rights() FROM PUBLIC;

CREATE TRIGGER admin_charges_enforce_summary_of_rights
  BEFORE INSERT OR UPDATE OF status, summary_of_rights_attached ON administration_charges
  FOR EACH ROW EXECUTE FUNCTION enforce_admin_charge_summary_of_rights();

-- ═════════════════════════════════════════════════════════════════════════════
-- Section H — demand_interest_charges (Q2: lease-clause-only in 00035)
--   Interest accrual gated by contractual basis. statutory_court_rate (s.69
--   County Courts Act 1984) FORWARD-anchored to CCJ tracking commit. Trigger
--   refuses INSERT when the underlying unit_lease has no interest_clause_present
--   override AND the block-level default is also absent.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE demand_interest_charges (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                  UUID NOT NULL REFERENCES firms(id),
  demand_id                UUID NOT NULL REFERENCES demands(id) ON DELETE RESTRICT,
  unit_id                  UUID NOT NULL REFERENCES units(id),
  unit_lease_id            UUID REFERENCES unit_leases(id),
  period_from              DATE NOT NULL,
  period_to                DATE NOT NULL,
  principal_amount         NUMERIC(12,2) NOT NULL,
  rate_pct                 NUMERIC(5,2)  NOT NULL,
  interest_amount          NUMERIC(12,2) NOT NULL,
  accrual_basis            TEXT NOT NULL,
  lease_clause_ref         TEXT NOT NULL,
  linked_transaction_id    UUID REFERENCES transactions(id),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by               UUID REFERENCES users(id),
  CONSTRAINT dic_accrual_basis_chk
    CHECK (accrual_basis IN ('lease_clause')),
  -- FORWARD: 'statutory_court_rate' added when CCJ tracking lands.
  CONSTRAINT dic_period_chk
    CHECK (period_to >= period_from),
  CONSTRAINT dic_amounts_non_negative_chk
    CHECK (principal_amount >= 0 AND interest_amount >= 0 AND rate_pct >= 0)
);

CREATE INDEX idx_dic_firm_id     ON demand_interest_charges(firm_id);
CREATE INDEX idx_dic_demand_id   ON demand_interest_charges(demand_id);
CREATE INDEX idx_dic_unit_id     ON demand_interest_charges(unit_id);

-- Statutory enforceability gate: interest only chargeable with contractual basis.
-- Checks unit_leases first (current lease for the unit), falls back to
-- block_collection_settings interest_clause_default_present.
CREATE OR REPLACE FUNCTION enforce_interest_clause_present()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_unit_lease_has_clause   BOOLEAN;
  v_block_default_present   BOOLEAN;
  v_property_id             UUID;
BEGIN
  -- Check unit_lease override
  SELECT interest_clause_present INTO v_unit_lease_has_clause
    FROM unit_leases
   WHERE id = NEW.unit_lease_id;

  IF v_unit_lease_has_clause IS TRUE THEN
    RETURN NEW;
  END IF;

  -- Fall back to block-level default
  SELECT property_id INTO v_property_id FROM units WHERE id = NEW.unit_id;
  SELECT interest_clause_default_present INTO v_block_default_present
    FROM block_collection_settings
   WHERE property_id = v_property_id;

  IF v_block_default_present IS TRUE THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'Cannot accrue interest without contractual basis: neither the unit_lease nor the block-level setting has interest_clause_present=true',
    HINT    = 'Pre-judgment interest on service charge arrears is only recoverable where the lease expressly provides for it. Capture the lease clause on unit_leases.interest_clause_* or set the block-level default on block_collection_settings.interest_clause_default_*.';
END;
$$;

REVOKE EXECUTE ON FUNCTION enforce_interest_clause_present() FROM PUBLIC;

CREATE TRIGGER dic_enforce_interest_clause_present
  BEFORE INSERT ON demand_interest_charges
  FOR EACH ROW EXECUTE FUNCTION enforce_interest_clause_present();

-- ═════════════════════════════════════════════════════════════════════════════
-- Section I — forfeiture_actions (LPA 1925 s.146)
--   Forfeiture is the most consequential collection outcome: leaseholder may
--   lose the lease entirely. Statutory regime requires:
--     1. Service of a s.146 notice specifying the breach.
--     2. 14-day grace period (most leases — some longer).
--     3. Service of the s.146 notice on any registered mortgagee
--        (interested_parties.party_type='mortgagee').
--     4. Court possession claim only after the grace period AND mortgagee
--        service.
--   Triggers enforce forward-only stage transitions + grace-period + mortgagee
--   gate.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE forfeiture_actions (
  id                                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                            UUID NOT NULL REFERENCES firms(id),
  unit_id                            UUID NOT NULL REFERENCES units(id),
  demand_id                          UUID NOT NULL REFERENCES demands(id) ON DELETE RESTRICT,
  stage                              TEXT NOT NULL DEFAULT 's146_drafted',
  s146_served_date                   DATE,
  s146_grace_period_days             INTEGER NOT NULL DEFAULT 14,
  s146_grace_period_ends             DATE,
  served_on_mortgagee_party_id       UUID REFERENCES interested_parties(id),
  mortgagee_served_date              DATE,
  -- Mortgage-free path: PM asserts (with evidence) that no registered charge
  -- exists on the unit's title. Required when proceeding to possession without
  -- a mortgagee service event. Audit trail (by/at/evidence) is mandatory.
  assert_no_mortgagee                BOOLEAN NOT NULL DEFAULT false,
  assert_no_mortgagee_by             UUID REFERENCES users(id),
  assert_no_mortgagee_at             TIMESTAMPTZ,
  assert_no_mortgagee_evidence       TEXT,
  court_claim_number                 TEXT,
  court_name                         TEXT,
  possession_order_date              DATE,
  possession_executed_date           DATE,
  abandoned_reason                   TEXT,
  solicitor_pa_id                    UUID REFERENCES payment_authorisations(id),
  possession_pa_id                   UUID REFERENCES payment_authorisations(id),
  notes                              TEXT,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                         UUID REFERENCES users(id),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fa_stage_chk
    CHECK (stage IN (
      's146_drafted','s146_served','14_day_period','14_day_expired',
      'mortgagee_served','possession_claim_drafted','possession_claim_issued',
      'possession_order_granted','possession_executed','abandoned'
    )),
  CONSTRAINT fa_grace_period_chk
    CHECK (s146_grace_period_days >= 14),
  -- 14 days is the statutory minimum under LPA 1925 s.146(1); some leases
  -- prescribe longer (28/42 days). Floor enforced; ceiling app-managed.
  CONSTRAINT fa_dates_coherence_chk
    CHECK (
      (s146_served_date IS NULL OR s146_grace_period_ends IS NULL
       OR s146_grace_period_ends = s146_served_date + s146_grace_period_days)
      AND (mortgagee_served_date IS NULL OR s146_served_date IS NULL
           OR mortgagee_served_date >= s146_served_date)
    ),
  CONSTRAINT fa_no_mortgagee_audit_chk
    CHECK (
      assert_no_mortgagee = false
      OR (assert_no_mortgagee_by IS NOT NULL
          AND assert_no_mortgagee_at IS NOT NULL
          AND assert_no_mortgagee_evidence IS NOT NULL)
    )
);

CREATE TRIGGER forfeiture_actions_updated_at
  BEFORE UPDATE ON forfeiture_actions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_fa_firm_id    ON forfeiture_actions(firm_id);
CREATE INDEX idx_fa_unit_id    ON forfeiture_actions(unit_id);
CREATE INDEX idx_fa_demand_id  ON forfeiture_actions(demand_id);
CREATE INDEX idx_fa_stage      ON forfeiture_actions(stage) WHERE stage NOT IN ('possession_executed','abandoned');

CREATE OR REPLACE FUNCTION enforce_forfeiture_stage_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  stage_order TEXT[] := ARRAY[
    's146_drafted','s146_served','14_day_period','14_day_expired',
    'mortgagee_served','possession_claim_drafted','possession_claim_issued',
    'possession_order_granted','possession_executed'
  ];
  old_idx INTEGER;
  new_idx INTEGER;
BEGIN
  IF OLD.stage = NEW.stage THEN
    RETURN NEW;
  END IF;

  -- 'abandoned' allowed from anywhere (PM withdraws action)
  IF NEW.stage = 'abandoned' THEN
    RETURN NEW;
  END IF;

  -- Out of abandoned: admin only
  IF OLD.stage = 'abandoned' THEN
    IF NOT auth_has_role('admin') THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'Reverting a forfeiture action from abandoned requires admin role';
    END IF;
    RETURN NEW;
  END IF;

  old_idx := array_position(stage_order, OLD.stage);
  new_idx := array_position(stage_order, NEW.stage);

  -- Forward-only in main chain
  IF new_idx < old_idx AND NOT auth_has_role('admin') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Reverse forfeiture stage transition not permitted',
      HINT    = format('From %s to %s requires admin role.', OLD.stage, NEW.stage);
  END IF;

  -- Mortgagee service required before possession_claim_issued (LPA 1925 s.146
  -- pre-action protocol). Two valid paths:
  --   Path A — mortgagee served: served_on_mortgagee_party_id + mortgagee_served_date both set.
  --   Path B — no mortgagee asserted: assert_no_mortgagee=true with audit trail
  --             (by/at/evidence enforced by fa_no_mortgagee_audit_chk).
  IF NEW.stage IN ('possession_claim_issued','possession_order_granted','possession_executed') THEN
    IF NEW.assert_no_mortgagee = true THEN
      -- Path B: PM has formally asserted no registered charge with evidence.
      -- The fa_no_mortgagee_audit_chk CHECK already ensures by/at/evidence are
      -- populated; this branch simply permits the stage transition.
      NULL;
    ELSIF NEW.mortgagee_served_date IS NULL OR NEW.served_on_mortgagee_party_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'LPA 1925 s.146 pre-action protocol: mortgagee must be served before possession claim is issued (or assert_no_mortgagee must be set with evidence)',
        HINT    = 'Two valid paths: (A) identify the registered mortgagee in interested_parties (party_type=''mortgagee''), serve the s.146 notice on them, and set forfeiture_actions.served_on_mortgagee_party_id + mortgagee_served_date; OR (B) set assert_no_mortgagee=true with assert_no_mortgagee_evidence (e.g. HMLR official copy of register confirming no registered charges).';
    END IF;
  END IF;

  -- 14-day grace period must have expired before possession claim
  IF NEW.stage IN ('possession_claim_drafted','possession_claim_issued',
                   'possession_order_granted','possession_executed') THEN
    IF NEW.s146_grace_period_ends IS NULL OR NEW.s146_grace_period_ends > CURRENT_DATE THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'LPA 1925 s.146(1): cannot draft or issue possession claim before the s.146 grace period has expired',
        HINT    = 'Wait until forfeiture_actions.s146_grace_period_ends has passed before advancing to possession claim stages.';
    END IF;
  END IF;

  -- possession_claim_issued + onwards require possession_pa_id (RICS dual-auth
  -- on near-irreversible action).
  IF NEW.stage IN ('possession_claim_issued','possession_order_granted','possession_executed')
     AND NEW.possession_pa_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'RICS dual-auth: possession claim requires an accepted payment_authorisation of action_type=commence_possession_proceedings linked via possession_pa_id',
      HINT    = 'Request and approve a Payment Authorisation (two staff), then set forfeiture_actions.possession_pa_id before advancing to possession_claim_issued or later.';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION enforce_forfeiture_stage_transition() FROM PUBLIC;

CREATE TRIGGER forfeiture_stage_transition
  BEFORE UPDATE OF stage ON forfeiture_actions
  FOR EACH ROW EXECUTE FUNCTION enforce_forfeiture_stage_transition();

-- ═════════════════════════════════════════════════════════════════════════════
-- Section J — notice_dispatch_queue (pg_cron → dispatch-engine handoff)
--   pg_cron walks state and INSERTs into this queue. The existing dispatch-engine
--   Edge Function (deployed in Phase 3) adds a handler that polls this queue
--   via SELECT ... FOR UPDATE SKIP LOCKED, renders the letter PDF, INSERTs a
--   notice_letters_sent row, sends via SMTP / MyBlockman, and updates status.
--   The template renderer extension to dispatch-engine is FORWARD-anchored
--   (see header).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE notice_dispatch_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             UUID NOT NULL REFERENCES firms(id),
  demand_id           UUID REFERENCES demands(id) ON DELETE CASCADE,
  unit_id             UUID NOT NULL REFERENCES units(id),
  leaseholder_id      UUID REFERENCES leaseholders(id),
  letter_code         TEXT NOT NULL,
  letter_type         TEXT NOT NULL,
  sent_method         TEXT NOT NULL DEFAULT 'post',
  status              TEXT NOT NULL DEFAULT 'pending',
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_attempt_at     TIMESTAMPTZ,
  last_error          TEXT,
  enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at        TIMESTAMPTZ,
  created_by          UUID REFERENCES users(id),
  -- NULL for pg_cron-enqueued rows.
  resulting_letter_id UUID REFERENCES notice_letters_sent(id),
  CONSTRAINT ndq_letter_code_chk
    CHECK (letter_code IN (
      'STD1','R1','R2','FN1','PA1','SOL1','POSS1','S20B','S146_NTC','GR_DEMAND'
    )),
  CONSTRAINT ndq_status_chk
    CHECK (status IN ('pending','rendering','sent','failed','cancelled'))
);

CREATE INDEX idx_ndq_firm_id    ON notice_dispatch_queue(firm_id);
CREATE INDEX idx_ndq_status     ON notice_dispatch_queue(status) WHERE status IN ('pending','rendering');
CREATE INDEX idx_ndq_demand_id  ON notice_dispatch_queue(demand_id) WHERE demand_id IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- Section K — payment_authorisations.action_type CHECK extension
--   Closes 00028 §10 FORWARD anchor (BSA HRB Accountable Person sign-off).
--   Adds three new action_type values:
--     - solicitor_escalation           — gates pre_action→solicitor_referred
--     - commence_possession_proceedings — gates solicitor_referred→legal_proceedings
--                                          + forfeiture possession_claim_issued
--     - major_works_invoice_ap_signoff  — closes 00028 §10. proposed JSONB shape:
--                                          { invoice_id, accountable_person_id }
--                                          where accountable_person_id resolves
--                                          to principal_accountable_persons.id
--                                          (00034). Approver lane requirement
--                                          enforced application-side; DB shape
--                                          permits the value.
-- ═════════════════════════════════════════════════════════════════════════════

-- Baseline as of 00029 (1i.3 RICS function-split): action_type IN
--   ('payment_release','payment_payee_setup','close_bank_account','toggle_rics_designation').
-- 00029 renamed 'payment' → 'payment_release' and added 'payment_payee_setup'
-- as the segregation-of-duties counterpart. 00035 preserves all four and
-- appends three new collection-workflow values.
ALTER TABLE payment_authorisations
  DROP CONSTRAINT payment_auth_action_type;

ALTER TABLE payment_authorisations
  ADD CONSTRAINT payment_auth_action_type
  CHECK (action_type IN (
    -- Post-00029 baseline (preserved verbatim):
    'payment_release',
    'payment_payee_setup',
    'close_bank_account',
    'toggle_rics_designation',
    -- 00035 collection-workflow additions:
    'solicitor_escalation',
    'commence_possession_proceedings',
    'major_works_invoice_ap_signoff'
  ));

COMMENT ON COLUMN payment_authorisations.action_type IS
  'Discriminator for the kind of action this authorisation gates. payment_release (the actual money-out auth; uses transaction_id post-authorise + ProposedTransaction pre-authorise; was ''payment'' before 1i.3) / payment_payee_setup (1i.3 RICS function-split — establishing or changing a contractor''s bank details; uses ProposedPayeeSetup) / close_bank_account (1g — uses ProposedClosure) / toggle_rics_designation (1g.5 — uses ProposedRicsDesignationToggle, direction-gated to true→false) / solicitor_escalation (00035 — proposed.demand_id; gates demands.notice_stage pre_action→solicitor_referred) / commence_possession_proceedings (00035 — proposed.demand_id; gates solicitor_referred→legal_proceedings AND forfeiture_actions possession claim) / major_works_invoice_ap_signoff (00035 — proposed.{invoice_id, accountable_person_id}; closes 00028 §10 FORWARD anchor; HRB-only AP sign-off lane resolves to principal_accountable_persons.id from 00034). See DECISIONS 2026-05-12 — Phase 4a.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Section L — documents.document_type CHECK extension
--   Adds four letter-PDF values so notice_letters_sent.document_id can FK
--   into documents with type-safety. DROP + recreate per 00032/00034 pattern.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE documents
  DROP CONSTRAINT documents_document_type_chk;

ALTER TABLE documents
  ADD CONSTRAINT documents_document_type_chk
  CHECK (document_type IN (
    -- 00032 baseline (30 values) — preserved verbatim:
    'lease','certificate','insurance','invoice','report','notice','correspondence',
    'minutes','plans','golden_thread','compliance','other','general',
    'gas_safety','electrical_eicr','lift_loler','fra','ews1','asbestos_register',
    'accounts_audited','accounts_draft','budget','insurance_schedule','insurance_summary',
    's20_intent','s20_estimates','s20_award','health_safety','building_safety_case',
    'energy_performance',
    -- 00034 BSA additions (6) — preserved verbatim:
    'resident_engagement_strategy','fire_strategy','structural_strategy',
    'bsa_registration','bsa_compliance_notice','pap_appointment_letter',
    -- 00035 collection letter additions (4):
    'notice_letter_reminder','notice_letter_final','notice_letter_solicitor','notice_letter_s146'
  ));

-- ═════════════════════════════════════════════════════════════════════════════
-- Section M — unit_ledger_history view (Blockman SC History parity)
--   UNION across transactions + notice_letters_sent + administration_charges +
--   demand_interest_charges per unit, ordered by date. Security-invoker view
--   so RLS on underlying tables bubbles up automatically. Gives the Blockman
--   "S/C History" tab column shape: Date, Description, Message (letter code),
--   SN (sequence number), Debit £, Credit £, Balance £.
--
--   Note: Balance £ is NOT computed in the view (running balance requires a
--   window function over per-unit ordering and is expensive; UI layer can
--   compute it client-side after fetch). The view returns the per-event
--   debit/credit pair; UI runs SUM() OVER (ORDER BY date) to materialise
--   the balance column.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE VIEW unit_ledger_history WITH (security_invoker = true) AS
  -- Demands (debit side — charge raised against the leaseholder).
  -- transactions has no unit_id (00005:118), so we join via demand_id to surface
  -- payments against demands on the unit-level ledger.
  SELECT
    d.firm_id,
    d.unit_id,
    d.issued_date                AS event_date,
    d.demand_type
      || COALESCE(': ' || d.period_start::TEXT || '–' || d.period_end::TEXT, '')
                                  AS description,
    CASE
      WHEN d.demand_type = 'ground_rent' THEN 'GR'
      ELSE 'STD1'
    END                          AS message_code,
    NULL::INTEGER                AS sequence_number,
    d.amount                     AS debit_amount,
    NULL::NUMERIC                AS credit_amount,
    d.id                         AS source_id,
    'demand'::TEXT               AS source_type
  FROM demands d
  WHERE d.status IN ('issued','part_paid','paid','overdue','disputed')
    AND d.issued_date IS NOT NULL

  UNION ALL

  -- Payments — transactions with a demand_id and amount > 0 (credit to leaseholder).
  -- Outgoings (amount < 0) belong to the firm's own ledger, not the per-unit view.
  SELECT
    t.firm_id,
    d.unit_id,
    t.transaction_date           AS event_date,
    COALESCE(t.description, t.transaction_type) AS description,
    NULL::TEXT                   AS message_code,
    NULL::INTEGER                AS sequence_number,
    NULL::NUMERIC                AS debit_amount,
    t.amount                     AS credit_amount,
    t.id                         AS source_id,
    'payment'::TEXT              AS source_type
  FROM transactions t
  JOIN demands d ON d.id = t.demand_id
  WHERE t.amount > 0

  UNION ALL

  -- Letter events (zero-amount ledger rows)
  SELECT
    nls.firm_id,
    nls.unit_id,
    nls.sent_at::date            AS event_date,
    CASE nls.letter_code
      WHEN 'STD1' THEN 'Standard Demand Issued'
      WHEN 'R1'   THEN 'Reminder Sent'
      WHEN 'R2'   THEN 'Second Reminder Sent'
      WHEN 'FN1'  THEN 'Final Notice Sent'
      WHEN 'PA1'  THEN 'Pre-Action Letter Sent'
      WHEN 'SOL1' THEN 'Solicitor Referral Notice Sent'
      WHEN 'POSS1' THEN 'Possession Notice Sent'
      WHEN 'S20B' THEN 'LTA 1985 s.20B(2) Notice Sent'
      WHEN 'S146_NTC' THEN 'LPA 1925 s.146 Notice Sent'
      WHEN 'GR_DEMAND' THEN 'Ground Rent Demand Issued'
      ELSE nls.letter_code
    END                          AS description,
    nls.letter_code              AS message_code,
    nls.sequence_number          AS sequence_number,
    NULL::NUMERIC                AS debit_amount,
    NULL::NUMERIC                AS credit_amount,
    nls.id                       AS source_id,
    'letter'::TEXT               AS source_type
  FROM notice_letters_sent nls

  UNION ALL

  -- Administration charges (debit-side)
  SELECT
    ac.firm_id,
    ac.unit_id,
    ac.raised_at::date           AS event_date,
    'Admin Charge: ' || ac.charge_type AS description,
    'ADM'::TEXT                  AS message_code,
    NULL::INTEGER                AS sequence_number,
    ac.amount_gross              AS debit_amount,
    NULL::NUMERIC                AS credit_amount,
    ac.id                        AS source_id,
    'admin_charge'::TEXT         AS source_type
  FROM administration_charges ac
  WHERE ac.status IN ('demanded','paid','disputed')

  UNION ALL

  -- Interest charges (debit-side)
  SELECT
    dic.firm_id,
    dic.unit_id,
    dic.created_at::date         AS event_date,
    'Interest: ' || dic.lease_clause_ref AS description,
    'INT'::TEXT                  AS message_code,
    NULL::INTEGER                AS sequence_number,
    dic.interest_amount          AS debit_amount,
    NULL::NUMERIC                AS credit_amount,
    dic.id                       AS source_id,
    'interest'::TEXT             AS source_type
  FROM demand_interest_charges dic;

COMMENT ON VIEW unit_ledger_history IS
  'Per-unit ledger surface for Blockman S/C History tab parity. UNION of transactions + notice_letters_sent + administration_charges + demand_interest_charges. Security-invoker; RLS bubbles up from underlying tables. UI computes running balance via SUM() OVER (ORDER BY event_date).';

-- ═════════════════════════════════════════════════════════════════════════════
-- Section N — RLS policies for the seven new tables
--   Standard PropOS pattern: firm-scoped SELECT (staff-only), PM-tier INSERT
--   + UPDATE, admin-only DELETE. notice_letters_sent has NO UPDATE policy
--   (immutable audit, mirrors golden_thread_records discipline).
--
--   FORWARD: leaseholder_select policies on these tables — Phase 5 portal
--   commit. Staff-only in 00035 (same posture as 00032 interested_parties).
-- ═════════════════════════════════════════════════════════════════════════════

-- block_collection_settings
ALTER TABLE block_collection_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY bcs_select ON block_collection_settings
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY bcs_insert ON block_collection_settings
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY bcs_update ON block_collection_settings
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY bcs_delete ON block_collection_settings
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_has_role('admin'));

-- notice_letters_sent (INSERT + SELECT only — immutable audit)
ALTER TABLE notice_letters_sent ENABLE ROW LEVEL SECURITY;

CREATE POLICY nls_select ON notice_letters_sent
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY nls_insert ON notice_letters_sent
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

-- Deliberately NO UPDATE policy: letter events are immutable.
-- Deliberately NO DELETE policy: audit must not be erasable.

-- administration_charges
ALTER TABLE administration_charges ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_charges_select ON administration_charges
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY admin_charges_insert ON administration_charges
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY admin_charges_update ON administration_charges
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY admin_charges_delete ON administration_charges
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_has_role('admin'));

-- demand_interest_charges
ALTER TABLE demand_interest_charges ENABLE ROW LEVEL SECURITY;

CREATE POLICY dic_select ON demand_interest_charges
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY dic_insert ON demand_interest_charges
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY dic_update ON demand_interest_charges
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY dic_delete ON demand_interest_charges
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_has_role('admin'));

-- forfeiture_actions
ALTER TABLE forfeiture_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY fa_select ON forfeiture_actions
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY fa_insert ON forfeiture_actions
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY fa_update ON forfeiture_actions
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY fa_delete ON forfeiture_actions
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_has_role('admin'));

-- notice_dispatch_queue
ALTER TABLE notice_dispatch_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY ndq_select ON notice_dispatch_queue
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY ndq_insert ON notice_dispatch_queue
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY ndq_update ON notice_dispatch_queue
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY ndq_delete ON notice_dispatch_queue
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_has_role('admin'));

-- ═════════════════════════════════════════════════════════════════════════════
-- Section O — pg_cron auto-progression job
--   Walks demands by their property's block_collection_settings cadence.
--   Advances stages up to and including pre_action; stops there by design
--   (the next two edges require an accepted PA, gated by trigger Section D).
--   Enqueues notice_dispatch_queue rows for each advanced demand so the
--   dispatch-engine Edge Function can render and send the letter PDFs.
--
--   Runs daily at 06:00 UTC. SECURITY DEFINER so it can bypass RLS to UPDATE
--   demands across firms. Idempotent — safe to re-run.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION progress_demand_notice_stages()
RETURNS TABLE (advanced_count INTEGER, enqueued_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_advanced INTEGER := 0;
  v_enqueued INTEGER := 0;
  rec RECORD;
BEGIN
  -- Stage 1: current → reminder_1
  FOR rec IN
    SELECT d.id, d.firm_id, d.unit_id, d.leaseholder_id
      FROM demands d
      JOIN block_collection_settings bcs ON bcs.property_id = d.property_id
     WHERE d.status IN ('issued','overdue','part_paid')
       AND d.notice_stage = 'current'
       AND d.due_date IS NOT NULL
       AND d.due_date + (bcs.reminder_1_days_after_due * INTERVAL '1 day')::INTERVAL <= now()
       AND bcs.auto_progress_enabled = true
  LOOP
    UPDATE demands SET notice_stage = 'reminder_1' WHERE id = rec.id;
    v_advanced := v_advanced + 1;
    INSERT INTO notice_dispatch_queue (firm_id, demand_id, unit_id, leaseholder_id, letter_code, letter_type)
    VALUES (rec.firm_id, rec.id, rec.unit_id, rec.leaseholder_id, 'R1', 'reminder');
    v_enqueued := v_enqueued + 1;
  END LOOP;

  -- Stage 2: reminder_1 → reminder_2
  FOR rec IN
    SELECT d.id, d.firm_id, d.unit_id, d.leaseholder_id
      FROM demands d
      JOIN block_collection_settings bcs ON bcs.property_id = d.property_id
     WHERE d.status IN ('issued','overdue','part_paid')
       AND d.notice_stage = 'reminder_1'
       AND d.due_date IS NOT NULL
       AND d.due_date + (bcs.reminder_2_days_after_due * INTERVAL '1 day')::INTERVAL <= now()
       AND bcs.auto_progress_enabled = true
  LOOP
    UPDATE demands SET notice_stage = 'reminder_2' WHERE id = rec.id;
    v_advanced := v_advanced + 1;
    INSERT INTO notice_dispatch_queue (firm_id, demand_id, unit_id, leaseholder_id, letter_code, letter_type)
    VALUES (rec.firm_id, rec.id, rec.unit_id, rec.leaseholder_id, 'R2', 'reminder');
    v_enqueued := v_enqueued + 1;
  END LOOP;

  -- Stage 3: reminder_2 → final_notice
  FOR rec IN
    SELECT d.id, d.firm_id, d.unit_id, d.leaseholder_id
      FROM demands d
      JOIN block_collection_settings bcs ON bcs.property_id = d.property_id
     WHERE d.status IN ('issued','overdue','part_paid')
       AND d.notice_stage = 'reminder_2'
       AND d.due_date IS NOT NULL
       AND d.due_date + (bcs.final_notice_days_after_due * INTERVAL '1 day')::INTERVAL <= now()
       AND bcs.auto_progress_enabled = true
  LOOP
    UPDATE demands SET notice_stage = 'final_notice' WHERE id = rec.id;
    v_advanced := v_advanced + 1;
    INSERT INTO notice_dispatch_queue (firm_id, demand_id, unit_id, leaseholder_id, letter_code, letter_type)
    VALUES (rec.firm_id, rec.id, rec.unit_id, rec.leaseholder_id, 'FN1', 'final_notice');
    v_enqueued := v_enqueued + 1;
  END LOOP;

  -- Stage 4: final_notice → pre_action
  -- Auto-progression STOPS at pre_action by design. The next two edges
  -- (pre_action→solicitor_referred, solicitor_referred→legal_proceedings)
  -- require an accepted PA and are PM-driven, not cron-driven.
  FOR rec IN
    SELECT d.id, d.firm_id, d.unit_id, d.leaseholder_id
      FROM demands d
      JOIN block_collection_settings bcs ON bcs.property_id = d.property_id
     WHERE d.status IN ('issued','overdue','part_paid')
       AND d.notice_stage = 'final_notice'
       AND d.due_date IS NOT NULL
       AND d.due_date + (bcs.pre_action_days_after_due * INTERVAL '1 day')::INTERVAL <= now()
       AND bcs.auto_progress_enabled = true
  LOOP
    UPDATE demands SET notice_stage = 'pre_action' WHERE id = rec.id;
    v_advanced := v_advanced + 1;
    INSERT INTO notice_dispatch_queue (firm_id, demand_id, unit_id, leaseholder_id, letter_code, letter_type)
    VALUES (rec.firm_id, rec.id, rec.unit_id, rec.leaseholder_id, 'PA1', 'pre_action');
    v_enqueued := v_enqueued + 1;
  END LOOP;

  RETURN QUERY SELECT v_advanced, v_enqueued;
END;
$$;

REVOKE EXECUTE ON FUNCTION progress_demand_notice_stages() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION progress_demand_notice_stages() TO service_role;

COMMENT ON FUNCTION progress_demand_notice_stages() IS
  'Daily auto-progression of demands.notice_stage. Walks current→reminder_1→reminder_2→final_notice→pre_action per block_collection_settings cadence. STOPS at pre_action by design — the next two edges require accepted payment_authorisations (RICS dual-auth). Enqueues notice_dispatch_queue rows for the dispatch-engine Edge Function. SECURITY DEFINER, service_role-grantable, idempotent.';

-- Schedule the job: daily at 06:00 UTC.
SELECT cron.schedule(
  'progress_demand_notice_stages_daily',
  '0 6 * * *',
  $cron$SELECT public.progress_demand_notice_stages();$cron$
);

-- ═════════════════════════════════════════════════════════════════════════════
-- Section P — Seed block_collection_settings rows for existing demo blocks
--   One row per existing property with defaults. PM can tune via UI later.
-- ═════════════════════════════════════════════════════════════════════════════

INSERT INTO block_collection_settings (property_id, firm_id)
  SELECT p.id, p.firm_id FROM properties p
   WHERE NOT EXISTS (
     SELECT 1 FROM block_collection_settings bcs WHERE bcs.property_id = p.id
   );

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (run individually in Dashboard after apply)
-- ─────────────────────────────────────────────────────────────────────────────

-- Q1: All 7 new tables exist with RLS enabled.
-- SELECT tablename, rowsecurity FROM pg_tables
--  WHERE schemaname = 'public'
--    AND tablename IN ('block_collection_settings','notice_letters_sent',
--                      'administration_charges','demand_interest_charges',
--                      'forfeiture_actions','notice_dispatch_queue')
--  ORDER BY tablename;
-- expect 6 rows (note: 7 listed in header but 7th 'golden_thread_audit_log' is pre-existing — not in this list)
-- all rowsecurity=true

-- Q2: Policy counts per new table.
-- SELECT tablename, COUNT(*) AS policy_count FROM pg_policies
--  WHERE schemaname='public'
--    AND tablename IN ('block_collection_settings','notice_letters_sent',
--                      'administration_charges','demand_interest_charges',
--                      'forfeiture_actions','notice_dispatch_queue')
--  GROUP BY tablename ORDER BY tablename;
-- expect:
--   administration_charges    4   (S/I/U/D)
--   block_collection_settings 4   (S/I/U/D)
--   demand_interest_charges   4   (S/I/U/D)
--   forfeiture_actions        4   (S/I/U/D)
--   notice_dispatch_queue     4   (S/I/U/D)
--   notice_letters_sent       2   (S/I — immutable audit)

-- Q3: demands has 5 new columns.
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='demands'
--    AND column_name IN ('notice_stage','with_solicitor','demand_reference',
--                        's20b_notified_date','earliest_unbilled_cost_date')
--  ORDER BY column_name;
-- expect 5 rows.

-- Q4: unit_leases has 4 new interest_clause_* columns.
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='unit_leases'
--    AND column_name LIKE 'interest_clause%' ORDER BY column_name;
-- expect 4 rows.

-- Q5: payment_authorisations.action_type CHECK includes 3 new values.
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid = 'public.payment_authorisations'::regclass
--    AND conname = 'payment_auth_action_type';
-- expect 1 row; constraint text contains 'solicitor_escalation',
-- 'commence_possession_proceedings', 'major_works_invoice_ap_signoff'.

-- Q6: documents.document_type CHECK includes 4 new letter-PDF values.
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid = 'public.documents'::regclass
--    AND conname = 'documents_document_type_chk';
-- expect 1 row; constraint text contains 'notice_letter_reminder',
-- 'notice_letter_final', 'notice_letter_solicitor', 'notice_letter_s146'.

-- Q7: Triggers present.
-- SELECT tgname FROM pg_trigger
--  WHERE tgrelid IN ('public.demands'::regclass,
--                    'public.administration_charges'::regclass,
--                    'public.demand_interest_charges'::regclass,
--                    'public.forfeiture_actions'::regclass)
--    AND tgname IN ('demands_notice_stage_transition','demands_s20b_18mo_chk',
--                   'admin_charges_enforce_summary_of_rights',
--                   'dic_enforce_interest_clause_present',
--                   'forfeiture_stage_transition')
--  ORDER BY tgname;
-- expect 5 rows.

-- Q8: pg_cron job scheduled.
-- SELECT jobname, schedule, active FROM cron.job
--  WHERE jobname = 'progress_demand_notice_stages_daily';
-- expect 1 row; schedule='0 6 * * *'; active=true.

-- Q9: block_collection_settings seeded for all existing properties.
-- SELECT
--   (SELECT COUNT(*) FROM properties)               AS properties_count,
--   (SELECT COUNT(*) FROM block_collection_settings) AS bcs_count;
-- expect properties_count = bcs_count.

-- Q10: unit_ledger_history view returns rows for Apt 1 / Brockhampton (seed sanity).
-- SELECT event_date, description, message_code, debit_amount, credit_amount, source_type
--   FROM unit_ledger_history
--  WHERE unit_id = (SELECT id FROM units WHERE unit_ref ILIKE '%1B%' LIMIT 1)
--  ORDER BY event_date DESC
--  LIMIT 10;
-- expect: existing transactions surfaced; zero letters/admin-charges/interest in 00035
-- (those land via PM action or 00036 supporting modules).
