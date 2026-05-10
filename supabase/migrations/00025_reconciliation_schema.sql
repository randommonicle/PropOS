-- Migration: 00025_reconciliation_schema
-- Phase 3 commits 1h.1 / 1h.2 / 1h.3 — Bank Reconciliation Engine.
--
-- Spec §5.3 (Bank Reconciliation Engine) — see PropOS_Handoff_Document_v1_6_1.docx.
-- DECISIONS 2026-05-10 — Reconciliation 1h plan + Production-grade gate.
--
-- Adds:
--   - firms.is_demo                BOOLEAN — Production-grade gate (sibling to
--                                    the existing "Demo mode toggle" entry).
--   - bank_accounts.csv_column_map JSONB  — Per-firm CSV column mapping (PoC).
--   - suspense_items               TABLE  — Statement rows held pending
--                                    investigation (§5.3 "Suspense and
--                                    Investigation Items"). Was forward-declared
--                                    by spec for "v1.7 migration".
--   - reconciliation_periods       TABLE  — Period entity carrying the
--                                    suspense_carried_forward flag and the
--                                    closing-balance snapshot. Spec §5.3
--                                    "Reconciliation Completion Rules".
--   - reconciliation_audit_log     TABLE  — RICS Rule 3.7 evidence trail.
--                                    6-year retention minimum per §5.3.
--   - Partial unique index on reconciliation_periods enforcing
--     one-open-period-per-bank-account at any time.
--
-- ────────────────────────────────────────────────────────────────────────────
-- Production-grade gate convention
-- ────────────────────────────────────────────────────────────────────────────
-- Every PoC-only enforcement point carries a `FORWARD: PROD-GATE` flag.
-- Grep manifest: `grep -r "FORWARD: PROD-GATE"` returns the full list of
-- replacements required before any firm flips firms.is_demo = false.
--
-- ════════════════════════════════════════════════════════════════════════════

-- ── firms.is_demo ───────────────────────────────────────────────────────────
-- Default true => every existing firm row is correctly classified as a demo
-- tenant. Production deployment flips this to false on the exit-demo flow
-- (Phase 6/7 candidate per DECISIONS 2026-05-10 — Demo mode toggle).
ALTER TABLE firms
  ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN firms.is_demo IS
  'Demo-mode flag. True for every firm at PoC time. The exit-demo flow flips this to false; from that point any code path tagged FORWARD: PROD-GATE must either branch to its production replacement or refuse to run with a "contact support" banner. See DECISIONS 2026-05-10 — Demo mode toggle + Production-grade gate.';

-- FORWARD: PROD-GATE — exit-demo flow must scan for unaddressed PROD-GATE
-- code paths and refuse to flip is_demo=false until each has a production
-- replacement deployed. Anchor: DECISIONS 2026-05-10 — Production-grade gate.

-- ── bank_accounts.csv_column_map ────────────────────────────────────────────
-- PoC-grade: PMs map their own bank's CSV columns on first import; mapping
-- cached here for re-use. Shape (application-validated):
--   { date: string, description: string, amount: string,
--     reference?: string, payee?: string, debit?: string, credit?: string }
-- where each value is the CSV column header name for that field.
ALTER TABLE bank_accounts
  ADD COLUMN csv_column_map JSONB;

COMMENT ON COLUMN bank_accounts.csv_column_map IS
  'PoC-grade: per-firm CSV column mapping cached for re-use after first import. Production must ship curated bank-template presets (Lloyds / Barclays / NatWest / HSBC / Monzo / Starling) — JSONB stays as override for outliers. Application-validated, not DB-enforced.';

-- FORWARD: PROD-GATE — replace per-firm self-mapping with curated bank
-- templates before any firm exits demo mode. Anchor: plan 1h §Demo-grade ↔
-- Production-grade gate item 2.

-- ════════════════════════════════════════════════════════════════════════════
-- suspense_items
-- ════════════════════════════════════════════════════════════════════════════
-- Spec §5.3: statement rows received but not yet allocatable. Each requires
-- a note explaining why it's in suspense and a target_resolution_date.
-- Status lifecycle: open → resolved (with resolved_to_transaction_id) |
--                          written_off (with resolution_notes only).
CREATE TABLE suspense_items (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                     UUID NOT NULL REFERENCES firms(id),
  bank_statement_import_id    UUID NOT NULL REFERENCES bank_statement_imports(id),
  statement_row_index         INTEGER NOT NULL,
  amount                      NUMERIC(14,2) NOT NULL,
  statement_date              DATE NOT NULL,
  description                 TEXT NOT NULL,
  target_resolution_date      DATE,
  status                      TEXT NOT NULL DEFAULT 'open',
  resolved_to_transaction_id  UUID REFERENCES transactions(id),
  resolution_notes            TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT suspense_status_chk
    CHECK (status IN ('open', 'resolved', 'written_off')),
  CONSTRAINT suspense_resolved_link_chk
    CHECK ((status = 'resolved') = (resolved_to_transaction_id IS NOT NULL))
);

CREATE INDEX idx_suspense_firm   ON suspense_items(firm_id);
CREATE INDEX idx_suspense_import ON suspense_items(bank_statement_import_id);
CREATE INDEX idx_suspense_status ON suspense_items(status);

ALTER TABLE suspense_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY suspense_pm ON suspense_items
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

-- FORWARD: PROD-GATE — UI-only immutability after resolution. Production
-- needs a BEFORE-UPDATE trigger preventing mutation of resolved / written_off
-- rows (defence in depth against direct-DB tampering). Anchor:
-- data-integrity / auto-protect pass (DECISIONS 2026-05-10, item 3 has the
-- same shape as the proposed-JSONB immutability requirement).

-- ════════════════════════════════════════════════════════════════════════════
-- reconciliation_periods
-- ════════════════════════════════════════════════════════════════════════════
-- Spec §5.3 "Reconciliation Completion Rules". One row per period per bank
-- account. Lifecycle: open → completed.
--
-- Completion pre-flight (UI-enforced today; PROD-GATE replacement in the
-- financial-rules Edge Function):
--   1. Every transactions row in [period_start, period_end] for this
--      bank_account_id has reconciled = true.
--   2. There are no open suspense_items dated within [period_start, period_end]
--      UNLESS suspense_carried_forward = true and completion_notes is set.
--   3. bank_accounts.current_balance = SUM(transactions.amount) within £0.01
--      for this bank_account_id (§5.3 "If they differ by more than £0.01 the
--      system blocks completion and surfaces the discrepancy").
CREATE TABLE reconciliation_periods (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                     UUID NOT NULL REFERENCES firms(id),
  bank_account_id             UUID NOT NULL REFERENCES bank_accounts(id),
  period_start                DATE NOT NULL,
  period_end                  DATE NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'open',
  completed_at                TIMESTAMPTZ,
  completed_by                UUID REFERENCES users(id),
  closing_balance_snapshot    NUMERIC(14,2),
  suspense_carried_forward    BOOLEAN NOT NULL DEFAULT false,
  completion_notes            TEXT,
  bank_statement_import_id    UUID REFERENCES bank_statement_imports(id),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recperiod_status_chk
    CHECK (status IN ('open', 'completed')),
  CONSTRAINT recperiod_dates_chk
    CHECK (period_end >= period_start),
  CONSTRAINT recperiod_completed_at_chk
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT recperiod_completed_by_chk
    CHECK ((status = 'completed') = (completed_by IS NOT NULL)),
  CONSTRAINT recperiod_carryforward_notes_chk
    CHECK (NOT suspense_carried_forward OR completion_notes IS NOT NULL)
);

CREATE INDEX idx_recperiod_firm    ON reconciliation_periods(firm_id);
CREATE INDEX idx_recperiod_account ON reconciliation_periods(bank_account_id);
CREATE INDEX idx_recperiod_status  ON reconciliation_periods(status);

-- One open period per bank account at any time. Partial unique index — only
-- enforced for status='open'. Completed periods may overlap historically (the
-- typical pattern: period N completes, period N+1 opens for the next month
-- and the date ranges adjoin or overlap by a day for boundary transactions).
CREATE UNIQUE INDEX uq_recperiod_one_open_per_account
  ON reconciliation_periods(bank_account_id)
  WHERE status = 'open';

ALTER TABLE reconciliation_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY recperiod_pm ON reconciliation_periods
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

COMMENT ON TABLE reconciliation_periods IS
  'One row per reconciliation period per bank account. UI lifecycle managed by ReconciliationTab + ReconciliationCompleteModal. Period immutability post-completion is UI-enforced today (PROD-GATE deferred to financial-rules Edge Function + data-integrity pass).';

-- FORWARD: PROD-GATE — UI-only post-completion immutability. Production
-- needs a BEFORE-UPDATE trigger rejecting any mutation when
-- OLD.status = 'completed' (mirrors the proposed-JSONB immutability pattern
-- from DECISIONS 2026-05-10 item 3 in the data-integrity / auto-protect pass).

-- FORWARD: PROD-GATE — atomic completion. The two-write completion path
-- (mark all txns reconciled + close period + insert audit row) is non-atomic
-- in the UI today. Production must wrap in a single Edge Function call inside
-- BEGIN…COMMIT. Anchor: ReconciliationCompleteModal handle function.

-- ════════════════════════════════════════════════════════════════════════════
-- reconciliation_audit_log
-- ════════════════════════════════════════════════════════════════════════════
-- Spec §5.3 "Audit Requirements". Every reconciliation action writes a row
-- with: who, when, what action, before-state, after-state.
--
-- RICS Rule 3.7 evidence trail. Spec mandates 6-year retention minimum
-- post-period — production needs a retention_until column + nightly
-- cold-storage cron (mirrors documents §5.7 pattern). PoC: rows simply
-- accumulate; no archival.
--
-- action vocabulary mirrors the spec list verbatim plus suspense_resolve
-- (added forward, used by the deferred suspense-resolution UI).
CREATE TABLE reconciliation_audit_log (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id                     UUID NOT NULL REFERENCES firms(id),
  bank_account_id             UUID NOT NULL REFERENCES bank_accounts(id),
  reconciliation_period_id    UUID REFERENCES reconciliation_periods(id),
  bank_statement_import_id    UUID REFERENCES bank_statement_imports(id),
  action                      TEXT NOT NULL,
  actor_id                    UUID NOT NULL REFERENCES users(id),
  acted_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  before_state                JSONB,
  after_state                 JSONB,
  notes                       TEXT,
  CONSTRAINT recaudit_action_chk
    CHECK (action IN ('auto_match', 'manual_match', 'suspense', 'reject',
                      'completion', 'suspense_resolve'))
);

CREATE INDEX idx_recaudit_firm    ON reconciliation_audit_log(firm_id);
CREATE INDEX idx_recaudit_account ON reconciliation_audit_log(bank_account_id);
CREATE INDEX idx_recaudit_period  ON reconciliation_audit_log(reconciliation_period_id);
CREATE INDEX idx_recaudit_action  ON reconciliation_audit_log(action);

ALTER TABLE reconciliation_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY recaudit_pm ON reconciliation_audit_log
  FOR ALL USING (firm_id = auth_firm_id() AND is_pm_or_admin());

COMMENT ON TABLE reconciliation_audit_log IS
  'RICS Rule 3.7 evidence trail. Spec §5.3 requires 6-year retention minimum post-period. PoC: append-only by convention only. PROD-GATE: append-only by RLS for every role including service_role + retention_until column + nightly archival cron.';

-- FORWARD: PROD-GATE — INSERT-only enforcement missing. Production needs:
--   1. RLS policies forbidding UPDATE / DELETE for every role including
--      service_role (append-only in fact, not just by convention).
--   2. retention_until column + nightly cold-storage cron mirroring the
--      documents §5.7 retention pattern (6 years post-period minimum).
--   3. Edge Function as the only INSERT path so actor_id is stamped from
--      the auth context, not from the client payload (prevents user-spoofing
--      via direct supabase-js writes with a leaked publishable key).
-- Anchors: DECISIONS 2026-05-10 — Security-smoke pass (item 2) +
-- Data-integrity / auto-protect pass (items 7 + 8).
