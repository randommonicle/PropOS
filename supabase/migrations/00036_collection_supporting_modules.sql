-- Migration: 00036_collection_supporting_modules
-- Purpose: Phase 4a — Collection workflow supporting modules.
--
--   Lands the supporting surfaces around the regulatory backbone from 00035:
--   payment mandates (G18 — schema only, UI Phase 5), ground rent remittance
--   to landlord (G20), charge schedules (G24 — Blockman parity), advance
--   demand scheduling (G24), and the issues tracker (G27).
--
--   Applied second in the Phase 4a PR; 00035 must be live first because:
--     - charge_schedules references demands.demand_type values
--     - demands.scheduled_issue_date augments the demands surface that 00035
--       state-machined
--     - issues.linked_demand_id and issues.linked_works_order_id FK into
--       existing surfaces
--
--   New tables (6):
--     - charge_schedules                — block-level recurring charge generators.
--                                          Blockman "Schedules" parity (Schedule
--                                          1: Service Charge yearly / Schedule 2:
--                                          Fixed Heating Charge quarterly etc.).
--                                          Generates demand rows on materialise.
--     - charge_schedule_apportionments  — per-unit share of each schedule.
--                                          apportionment_pct OR fixed_amount per
--                                          unit, with method selector on parent.
--     - payment_mandates                — G18 DD / SO / online_bank_transfer /
--                                          cheque / cash / card / portal mandates
--                                          per (unit, charge_type). One active
--                                          per pair enforced by partial-unique
--                                          index.
--     - ground_rent_remittances         — G20 transfer-to-landlord of collected
--                                          ground rent. Per-demand remittance
--                                          row + linked transaction.
--     - issue_categories                — G27 firm-level taxonomy (Blockman
--                                          Issues "Cate[gories]" config screen).
--     - issues                          — G27 the issue itself (Blockman Issue
--                                          Manager parity).
--     - issue_actions                   — G27 the per-issue action log
--                                          (immutable; mirrors notice_letters_sent
--                                          discipline from 00035).
--
--   Schema extensions:
--     - demands.scheduled_issue_date    — G24 advance scheduling (e.g. issue
--                                          Q1 demand on Dec 1 for Jan 1 due).
--                                          NULL = issue immediately.
--
--   Triggers (1):
--     - payment_mandates_one_active_per_pair — enforced via partial-unique
--                                          index (no PL/pgSQL trigger needed).
--
-- Statutory anchors:
--   LTA 1985 ss.18-30        — Service charge regime; charge_schedules + their
--                              apportionments materialise as `demands` rows
--                              which carry the existing s.21B / s.47 / s.48 /
--                              s.153 enforceability gates from 00005 + 00032.
--   CLRA 2002 s.166          — Ground rent: formal demand required; small-amount
--                              + landlord-not-given rules. ground_rent_remittances
--                              models the collected→landlord transfer required
--                              when the managing agent receives GR on behalf of
--                              a separate landlord (typical RMC + investor-freeholder
--                              setup).
--   RICS Client money        — Client account segregation: when GR is collected
--     handling (1st ed.)       it is held in trust pending remittance to the
--                              landlord. The remittance must be evidenced + dated.
--                              ground_rent_remittances IS the evidence trail.
--   TPI Consumer Charter     — Issues tracker (G27) supports the consumer-facing
--     Ed.3                     complaint and dispute handling expectations.
--
-- Forward anchors (do not implement here):
--   FORWARD: charge_schedules materialisation pg_cron job — calculates which
--     units owe what for which period and creates demands rows. Complex enough
--     to deserve its own commit when the Phase 4a UX lands. Schema in 00036;
--     materialisation logic FORWARD (charge_schedules.is_active + current_period
--     counter are the anchors).
--   FORWARD: payment_mandates UI — Phase 5 leaseholder portal commit.
--     bank_reference_last4 is anonymised in 00036; full bank-detail capture
--     pairs with encryption-at-rest (data-integrity / auto-protect pass).
--   FORWARD: ground_rent_remittances pg_cron sweep — auto-flag GR demands
--     that have been paid but not yet remitted to landlord. Lands with the
--     Phase 4a UX commit alongside the manual remittance flow.
--   FORWARD: issues leaseholder_select policy — Phase 5 leaseholder portal
--     (G27 issues raised by leaseholders need to be visible to that leaseholder
--     on their own units). Staff-only in 00036.
--   FORWARD: issue_actions append-only enforcement at trigger level — currently
--     enforced by RLS (no UPDATE/DELETE policy). Trigger-based belt-and-braces
--     mirrors notice_letters_sent discipline; FORWARD as opportunistic harden.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════════
-- Section A — charge_schedules + charge_schedule_apportionments (G24)
--   Blockman's "Schedules" surface: per-block, multiple schedules (Schedule 1:
--   Service Charge yearly, Schedule 2: Fixed Heating Charge quarterly, etc.).
--   Each schedule has a frequency, apportionment method, and a running counter
--   for materialised periods. The actual demand-generation logic is FORWARD
--   (pg_cron sweep); 00036 ships the schema and seed-time configuration only.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE charge_schedules (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                     UUID NOT NULL REFERENCES firms(id),
  property_id                 UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  schedule_name               TEXT NOT NULL,
  charge_type                 TEXT NOT NULL,
  -- Matches demands.demand_type values from 00005:90 (free-form but conventional).
  frequency                   TEXT NOT NULL,
  apportionment_method        TEXT NOT NULL,
  period_start                DATE NOT NULL,
  period_end                  DATE NOT NULL,
  total_periods               INTEGER NOT NULL,
  current_period              INTEGER NOT NULL DEFAULT 0,
  total_budget_amount         NUMERIC(14,2) NOT NULL,
  vat_rate_pct                NUMERIC(4,2)  NOT NULL DEFAULT 0.00,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  is_complete                 BOOLEAN NOT NULL DEFAULT false,
  description                 TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                  UUID REFERENCES users(id),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT charge_schedules_frequency_chk
    CHECK (frequency IN ('yearly','half_yearly','quarterly','monthly','one_off')),
  CONSTRAINT charge_schedules_apportionment_method_chk
    CHECK (apportionment_method IN ('percentage','equal','by_floor_area','fixed_per_unit')),
  CONSTRAINT charge_schedules_period_window_chk
    CHECK (period_end > period_start),
  CONSTRAINT charge_schedules_total_periods_chk
    CHECK (total_periods > 0),
  CONSTRAINT charge_schedules_current_period_chk
    CHECK (current_period >= 0 AND current_period <= total_periods),
  CONSTRAINT charge_schedules_budget_non_negative_chk
    CHECK (total_budget_amount >= 0)
);

CREATE TRIGGER charge_schedules_updated_at
  BEFORE UPDATE ON charge_schedules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_charge_schedules_firm_id     ON charge_schedules(firm_id);
CREATE INDEX idx_charge_schedules_property_id ON charge_schedules(property_id);
CREATE INDEX idx_charge_schedules_active      ON charge_schedules(property_id) WHERE is_active = true AND is_complete = false;

COMMENT ON TABLE charge_schedules IS
  'Block-level recurring charge generator (Blockman "Schedules" parity). Each schedule materialises into N demands per period, apportioned across the block''s units per charge_schedule_apportionments. Materialisation logic is FORWARD (pg_cron sweep with the Phase 4a UX commit). Schema-only in 00036.';

CREATE TABLE charge_schedule_apportionments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               UUID NOT NULL REFERENCES firms(id),
  schedule_id           UUID NOT NULL REFERENCES charge_schedules(id) ON DELETE CASCADE,
  unit_id               UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  -- Apportionment encoding: when method='percentage', apportionment_pct populated;
  -- when method='fixed_per_unit', fixed_amount populated; when method='equal' or
  -- 'by_floor_area', neither — computed at materialise time. The coherence
  -- CHECK is permissive; app-layer validates per parent's apportionment_method.
  apportionment_pct     NUMERIC(7,4),
  -- 0.0000 to 100.0000; e.g. 4.7619 for 1/21 units.
  fixed_amount          NUMERIC(12,2),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT csa_apportionment_pct_chk
    CHECK (apportionment_pct IS NULL OR (apportionment_pct >= 0 AND apportionment_pct <= 100)),
  CONSTRAINT csa_fixed_amount_chk
    CHECK (fixed_amount IS NULL OR fixed_amount >= 0)
);

CREATE INDEX idx_csa_firm_id      ON charge_schedule_apportionments(firm_id);
CREATE INDEX idx_csa_schedule_id  ON charge_schedule_apportionments(schedule_id);
CREATE INDEX idx_csa_unit_id      ON charge_schedule_apportionments(unit_id);
CREATE UNIQUE INDEX uq_csa_one_per_schedule_unit
  ON charge_schedule_apportionments(schedule_id, unit_id);

COMMENT ON TABLE charge_schedule_apportionments IS
  'Per-unit share of a charge_schedule. Encoding depends on parent''s apportionment_method: percentage→apportionment_pct, fixed_per_unit→fixed_amount, equal/by_floor_area→computed at materialise time. Unique on (schedule_id, unit_id). Method coherence enforced via csa_enforce_method_coherence trigger.';

-- Method-coherence trigger: ensures the apportionment row matches the parent
-- schedule's apportionment_method. CHECK constraints cannot reference a parent
-- row in another table, so this is the closest DB-level invariant.
CREATE OR REPLACE FUNCTION enforce_csa_method_coherence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_method TEXT;
BEGIN
  SELECT apportionment_method INTO v_method
    FROM charge_schedules WHERE id = NEW.schedule_id;

  IF v_method = 'percentage' THEN
    IF NEW.apportionment_pct IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'charge_schedules.apportionment_method=percentage requires apportionment_pct NOT NULL on each charge_schedule_apportionments row',
        HINT    = 'Set apportionment_pct (0.0000 to 100.0000) for this unit''s share of the schedule.';
    END IF;
  ELSIF v_method = 'fixed_per_unit' THEN
    IF NEW.fixed_amount IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'charge_schedules.apportionment_method=fixed_per_unit requires fixed_amount NOT NULL on each charge_schedule_apportionments row',
        HINT    = 'Set fixed_amount (NUMERIC(12,2)) for this unit''s fixed share.';
    END IF;
  END IF;
  -- For 'equal' and 'by_floor_area', no row-level requirement (computed at
  -- materialise time from charge_schedules.total_budget_amount + the unit count
  -- or units.floor_area respectively).
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION enforce_csa_method_coherence() FROM PUBLIC;

CREATE TRIGGER csa_enforce_method_coherence
  BEFORE INSERT OR UPDATE OF apportionment_pct, fixed_amount, schedule_id ON charge_schedule_apportionments
  FOR EACH ROW EXECUTE FUNCTION enforce_csa_method_coherence();

-- ═════════════════════════════════════════════════════════════════════════════
-- Section B — demands.scheduled_issue_date (G24 advance scheduling)
--   When set, the pg_cron materialisation sweep (FORWARD) holds the demand in
--   status='draft' until scheduled_issue_date <= today, then transitions to
--   status='issued'. Blockman supports this via the "Demand Notices in Advance"
--   Unit Manager menu item — issue a Q1 demand on Dec 1 to be due Jan 1.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE demands
  ADD COLUMN scheduled_issue_date DATE;

CREATE INDEX idx_demands_scheduled_issue_date ON demands(scheduled_issue_date)
  WHERE scheduled_issue_date IS NOT NULL AND status = 'draft';

COMMENT ON COLUMN demands.scheduled_issue_date IS
  'G24 advance demand scheduling: when set, a future pg_cron sweep transitions status=draft→issued on scheduled_issue_date. NULL = issue immediately on insert. Blockman parity: "Demand Notices in Advance" Unit Manager menu.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Section C — payment_mandates (G18)
--   Schema only — UI Phase 5. Per-leaseholder + per-unit + per-charge-type
--   mandate. One ACTIVE mandate per (unit_id, charge_type) at a time, enforced
--   via partial-unique index. bank_reference_last4 is the anonymised last 4
--   digits; full bank-detail capture pairs with encryption-at-rest (data-
--   integrity pass, FORWARD).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE payment_mandates (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                  UUID NOT NULL REFERENCES firms(id),
  unit_id                  UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  leaseholder_id           UUID NOT NULL REFERENCES leaseholders(id) ON DELETE RESTRICT,
  charge_type              TEXT NOT NULL,
  mandate_type             TEXT NOT NULL,
  bank_reference_last4     TEXT,
  -- Anonymised — last 4 digits of the source account number.
  -- Full bank-detail capture FORWARD-anchored to encryption-at-rest commit.
  payer_name_snapshot      TEXT,
  effective_from           DATE NOT NULL,
  effective_to             DATE,
  -- NULL = currently active.
  cancelled_reason         TEXT,
  cancelled_at             TIMESTAMPTZ,
  cancelled_by             UUID REFERENCES users(id),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by               UUID REFERENCES users(id),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pm_mandate_type_chk
    CHECK (mandate_type IN (
      'direct_debit','standing_order','online_bank_transfer',
      'cheque','cash','card','myblockman_portal'
    )),
  CONSTRAINT pm_effective_window_chk
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT pm_bank_ref_chk
    CHECK (bank_reference_last4 IS NULL OR bank_reference_last4 ~ '^[0-9]{4}$'),
  CONSTRAINT pm_cancelled_coherence_chk
    CHECK (
      (cancelled_at IS NULL AND cancelled_by IS NULL AND cancelled_reason IS NULL)
      OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    )
);

CREATE TRIGGER payment_mandates_updated_at
  BEFORE UPDATE ON payment_mandates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_pm_firm_id          ON payment_mandates(firm_id);
CREATE INDEX idx_pm_unit_id          ON payment_mandates(unit_id);
CREATE INDEX idx_pm_leaseholder_id   ON payment_mandates(leaseholder_id);
CREATE INDEX idx_pm_mandate_type     ON payment_mandates(mandate_type);

-- One ACTIVE mandate per (unit_id, charge_type) at a time.
CREATE UNIQUE INDEX uq_pm_one_active_per_unit_charge_type
  ON payment_mandates(unit_id, charge_type)
  WHERE effective_to IS NULL;

COMMENT ON TABLE payment_mandates IS
  'G18 payment mandate (DD / SO / online_bank_transfer / cheque / cash / card / portal). One active mandate per (unit_id, charge_type) — partial-unique index on rows where effective_to IS NULL. bank_reference_last4 anonymised; full bank-detail capture FORWARD-anchored to encryption-at-rest commit. Schema only in 00036; UI Phase 5 leaseholder portal.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Section D — ground_rent_remittances (G20)
--   When a managing agent collects ground rent on behalf of a separate landlord
--   (typical RMC / investor-freeholder setup), the GR is held in trust pending
--   remittance to the landlord. Each remittance event captures the GR demand
--   being satisfied, the landlord receiving the funds, the amount remitted, and
--   the linked transaction (the actual bank transfer out of client account).
--
--   RICS Client money handling requires segregation of client money — this is
--   the evidence trail for the landlord-side of that segregation.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE ground_rent_remittances (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                     UUID NOT NULL REFERENCES firms(id),
  demand_id                   UUID NOT NULL REFERENCES demands(id) ON DELETE RESTRICT,
  landlord_id                 UUID NOT NULL REFERENCES landlords(id),
  amount_remitted             NUMERIC(12,2) NOT NULL,
  remittance_method           TEXT NOT NULL DEFAULT 'bank_transfer',
  remittance_reference        TEXT,
  -- Bank-side reference for the outbound payment (BACS reference, etc.).
  remitted_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  remitted_by                 UUID REFERENCES users(id),
  remittance_transaction_id   UUID REFERENCES transactions(id),
  -- Links to the transactions row that recorded the outbound payment from
  -- client account. NULL is permitted at INSERT (the transaction may be
  -- created later in the same workflow); app-layer reconciles.
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT grr_method_chk
    CHECK (remittance_method IN ('bank_transfer','cheque','other')),
  CONSTRAINT grr_amount_positive_chk
    CHECK (amount_remitted > 0)
);

CREATE INDEX idx_grr_firm_id      ON ground_rent_remittances(firm_id);
CREATE INDEX idx_grr_demand_id    ON ground_rent_remittances(demand_id);
CREATE INDEX idx_grr_landlord_id  ON ground_rent_remittances(landlord_id);
CREATE INDEX idx_grr_remitted_at  ON ground_rent_remittances(remitted_at);

COMMENT ON TABLE ground_rent_remittances IS
  'G20 transfer-to-landlord of collected ground rent. Per-demand remittance event with linked transactions row for the outbound payment from client account. RICS Client money handling — evidence trail for the landlord-side of client money segregation. FORWARD: pg_cron sweep auto-flagging unpaid remittances lands with Phase 4a UX commit.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Section E — issue_categories + issues + issue_actions (G27)
--   Blockman parity: top-level Issues & Works menu → Issue Manager.
--   Three tables:
--     - issue_categories  — firm-level taxonomy (PM-tier editable). Blockman has
--                            a separate Cate[gories] config screen accessed from
--                            Issue Manager top-right link.
--     - issues            — the issue itself. Columns map to Blockman's Issue
--                            Manager: ID#, Block, Unit, From, Category, Brief
--                            Description, Attachment, Actions, Last Action.
--     - issue_actions     — append-only action log. Powers Blockman's "Actions"
--                            and "Last Action" columns. RLS enforces append-only
--                            (no UPDATE/DELETE policies; mirrors the
--                            notice_letters_sent immutable-audit discipline from
--                            00035). Trigger-level enforcement FORWARD.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE issue_categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firms(id),
  name            TEXT NOT NULL,
  colour_hex      TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT issue_categories_colour_chk
    CHECK (colour_hex IS NULL OR colour_hex ~ '^#[0-9A-Fa-f]{6}$')
);

CREATE TRIGGER issue_categories_updated_at
  BEFORE UPDATE ON issue_categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_issue_categories_firm_id ON issue_categories(firm_id);
CREATE UNIQUE INDEX uq_issue_categories_name_per_firm
  ON issue_categories(firm_id, lower(name));

CREATE TABLE issues (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                  UUID NOT NULL REFERENCES firms(id),
  property_id              UUID NOT NULL REFERENCES properties(id),
  unit_id                  UUID REFERENCES units(id),
  -- NULL = block-wide issue (not tied to a specific unit).
  category_id              UUID REFERENCES issue_categories(id),
  from_party               TEXT NOT NULL,
  from_user_id             UUID REFERENCES users(id),
  from_text                TEXT,
  -- When the raising party is not a system user (e.g. external contractor),
  -- from_user_id is NULL and from_text carries their name / contact.
  brief_description        TEXT NOT NULL,
  attachment_document_id   UUID REFERENCES documents(id),
  status                   TEXT NOT NULL DEFAULT 'open',
  priority                 TEXT,
  assigned_to_user_id      UUID REFERENCES users(id),
  linked_demand_id         UUID REFERENCES demands(id),
  -- For collection-related disputes / queries on a demand.
  linked_works_order_id    UUID,
  -- forward ref to existing works_orders (00008); FK omitted to avoid
  -- circular dependency in the migration order, and works_orders may
  -- be in a different schema state on demo seed.
  raised_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at                TIMESTAMPTZ,
  closed_reason            TEXT,
  closed_by                UUID REFERENCES users(id),
  notes                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by               UUID REFERENCES users(id),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT issues_from_party_chk
    CHECK (from_party IN ('leaseholder','director','pm','contractor','external','other')),
  CONSTRAINT issues_from_identity_chk
    CHECK (
      from_user_id IS NOT NULL
      OR from_text IS NOT NULL
    ),
  -- App-layer discipline: when from_user_id IS NOT NULL, ALSO populate
  -- from_text with a snapshot of the user's display name at the time the
  -- issue is raised. This preserves the audit trail across user deletion
  -- (FK is ON DELETE SET NULL via PropOS user-removal pattern).
  CONSTRAINT issues_unit_required_for_lh_chk
    CHECK (NOT (from_party = 'leaseholder' AND unit_id IS NULL)),
  -- Leaseholders are necessarily tied to a unit; a block-wide issue
  -- (unit_id IS NULL) cannot be from a leaseholder.
  CONSTRAINT issues_status_chk
    CHECK (status IN ('open','in_progress','awaiting_response','closed','cancelled')),
  CONSTRAINT issues_priority_chk
    CHECK (priority IS NULL OR priority IN ('low','medium','high','urgent')),
  CONSTRAINT issues_closed_coherence_chk
    CHECK (
      (status NOT IN ('closed','cancelled') AND closed_at IS NULL AND closed_by IS NULL)
      OR (status IN ('closed','cancelled') AND closed_at IS NOT NULL)
    )
);

CREATE TRIGGER issues_updated_at
  BEFORE UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_issues_firm_id           ON issues(firm_id);
CREATE INDEX idx_issues_property_id       ON issues(property_id);
CREATE INDEX idx_issues_unit_id           ON issues(unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX idx_issues_status            ON issues(status) WHERE status NOT IN ('closed','cancelled');
CREATE INDEX idx_issues_assigned          ON issues(assigned_to_user_id) WHERE assigned_to_user_id IS NOT NULL;
CREATE INDEX idx_issues_linked_demand_id  ON issues(linked_demand_id) WHERE linked_demand_id IS NOT NULL;

COMMENT ON TABLE issues IS
  'G27 issues tracker (Blockman Issue Manager parity). One row per raised issue; from_party + from_user_id/from_text identifies the raiser. linked_demand_id supports collection-related disputes. Status state machine: open → in_progress → awaiting_response → closed | cancelled. closed_at coherence with terminal statuses enforced by CHECK.';

CREATE TABLE issue_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firms(id),
  issue_id        UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  action_type     TEXT NOT NULL DEFAULT 'note',
  action_text     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users(id),
  CONSTRAINT issue_actions_type_chk
    CHECK (action_type IN ('note','status_change','assignment','escalation','resolution','communication'))
);

CREATE INDEX idx_issue_actions_firm_id    ON issue_actions(firm_id);
CREATE INDEX idx_issue_actions_issue_id   ON issue_actions(issue_id);
CREATE INDEX idx_issue_actions_created_at ON issue_actions(created_at);

COMMENT ON TABLE issue_actions IS
  'Append-only action log per issue. Powers Blockman Issue Manager "Actions" + "Last Action" columns. RLS enforces append-only (no UPDATE/DELETE policies); trigger-level enforcement is FORWARD (opportunistic harden mirroring notice_letters_sent discipline from 00035).';

-- ═════════════════════════════════════════════════════════════════════════════
-- Section F — RLS policies for all 7 new tables
--   Standard PropOS pattern: firm-scoped SELECT (staff-only), PM-tier INSERT
--   + UPDATE, admin-only DELETE. issue_actions has NO UPDATE/DELETE policy
--   (append-only audit, mirrors notice_letters_sent / golden_thread_records).
--
--   FORWARD: leaseholder_select on issues + payment_mandates — Phase 5 portal.
-- ═════════════════════════════════════════════════════════════════════════════

-- charge_schedules
ALTER TABLE charge_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY charge_schedules_select ON charge_schedules
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY charge_schedules_insert ON charge_schedules
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY charge_schedules_update ON charge_schedules
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY charge_schedules_delete ON charge_schedules
  FOR DELETE USING (
    firm_id = auth_firm_id()
    AND auth_has_role('admin')
    AND current_period = 0
  );
-- Admin can only DELETE a schedule that has not yet materialised any periods.
-- Once current_period > 0, the schedule has generated demand rows downstream;
-- deletion would leave ghost references. Set is_active=false instead to retire.

-- charge_schedule_apportionments
ALTER TABLE charge_schedule_apportionments ENABLE ROW LEVEL SECURITY;

CREATE POLICY csa_select ON charge_schedule_apportionments
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY csa_insert ON charge_schedule_apportionments
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY csa_update ON charge_schedule_apportionments
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY csa_delete ON charge_schedule_apportionments
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_has_role('admin'));

-- payment_mandates
ALTER TABLE payment_mandates ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_mandates_select ON payment_mandates
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY payment_mandates_insert ON payment_mandates
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY payment_mandates_update ON payment_mandates
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY payment_mandates_delete ON payment_mandates
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_has_role('admin'));

-- ground_rent_remittances
ALTER TABLE ground_rent_remittances ENABLE ROW LEVEL SECURITY;

CREATE POLICY grr_select ON ground_rent_remittances
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY grr_insert ON ground_rent_remittances
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY grr_update ON ground_rent_remittances
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY grr_delete ON ground_rent_remittances
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_has_role('admin'));

-- issue_categories
ALTER TABLE issue_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY issue_categories_select ON issue_categories
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY issue_categories_insert ON issue_categories
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY issue_categories_update ON issue_categories
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY issue_categories_delete ON issue_categories
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_has_role('admin'));

-- issues
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;

CREATE POLICY issues_select ON issues
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY issues_insert ON issues
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY issues_update ON issues
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

CREATE POLICY issues_delete ON issues
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_has_role('admin'));

-- issue_actions (append-only — no UPDATE / DELETE policies)
ALTER TABLE issue_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY issue_actions_select ON issue_actions
  FOR SELECT USING (firm_id = auth_firm_id());

CREATE POLICY issue_actions_insert ON issue_actions
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

-- Deliberately NO UPDATE policy — actions are immutable audit trail.
-- Deliberately NO DELETE policy — actions must not be erasable.

-- ═════════════════════════════════════════════════════════════════════════════
-- Section G — Seed: minimal demo categories
--   Seed three default issue_categories per firm so the Issue Manager has
--   something to pick from on first use. PM can extend / reorder via UI later.
-- ═════════════════════════════════════════════════════════════════════════════

INSERT INTO issue_categories (firm_id, name, sort_order, description)
  SELECT f.id, c.name, c.sort_order, c.description
    FROM firms f
   CROSS JOIN (VALUES
     ('Maintenance'::TEXT,    10, 'Reactive maintenance issues raised by leaseholders / directors / PMs'),
     ('Complaint'::TEXT,      20, 'Formal complaints (TPI Consumer Charter Ed.3 evidence trail)'),
     ('Charge Query'::TEXT,   30, 'Service charge / ground rent / admin charge queries and disputes')
   ) AS c(name, sort_order, description)
   WHERE NOT EXISTS (
     SELECT 1 FROM issue_categories ic
      WHERE ic.firm_id = f.id AND lower(ic.name) = lower(c.name)
   );

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (run individually in Dashboard after apply)
-- ─────────────────────────────────────────────────────────────────────────────

-- Q1: All 7 new tables exist with RLS enabled.
-- SELECT tablename, rowsecurity FROM pg_tables
--  WHERE schemaname = 'public'
--    AND tablename IN ('charge_schedules','charge_schedule_apportionments',
--                      'payment_mandates','ground_rent_remittances',
--                      'issue_categories','issues','issue_actions')
--  ORDER BY tablename;
-- expect 7 rows, all rowsecurity=true.

-- Q2: Policy counts per new table.
-- SELECT tablename, COUNT(*) AS policy_count FROM pg_policies
--  WHERE schemaname='public'
--    AND tablename IN ('charge_schedules','charge_schedule_apportionments',
--                      'payment_mandates','ground_rent_remittances',
--                      'issue_categories','issues','issue_actions')
--  GROUP BY tablename ORDER BY tablename;
-- expect:
--   charge_schedule_apportionments 4
--   charge_schedules               4
--   ground_rent_remittances        4
--   issue_actions                  2  (S/I only — append-only audit)
--   issue_categories               4
--   issues                         4
--   payment_mandates               4

-- Q3: demands.scheduled_issue_date column added.
-- SELECT column_name, is_nullable FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='demands'
--    AND column_name = 'scheduled_issue_date';
-- expect 1 row; is_nullable='YES'.

-- Q4: Issue categories seeded for every firm (3 per firm).
-- SELECT
--   (SELECT COUNT(*) FROM firms)                          AS firm_count,
--   (SELECT COUNT(*) FROM issue_categories)               AS category_count,
--   (SELECT COUNT(*) FROM firms) * 3                      AS expected_category_count;
-- expect category_count = expected_category_count.

-- Q5: payment_mandates partial-unique index present.
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE schemaname='public' AND tablename='payment_mandates'
--    AND indexname='uq_pm_one_active_per_unit_charge_type';
-- expect 1 row; indexdef contains 'WHERE (effective_to IS NULL)'.

-- Q6: charge_schedule_apportionments unique-per-(schedule,unit) index present.
-- SELECT indexname FROM pg_indexes
--  WHERE schemaname='public' AND tablename='charge_schedule_apportionments'
--    AND indexname='uq_csa_one_per_schedule_unit';
-- expect 1 row.

-- Q7: All 7 tables + the demands extension are healthy via a single diagnostic.
-- (Use the same UNION pattern Ben pasted for 00035 Q1-Q10.)
