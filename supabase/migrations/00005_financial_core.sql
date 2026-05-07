-- Migration: 00005_financial_core
-- Purpose: Section 4.3 — Financial core tables.
-- bank_accounts, service_charge_accounts, budget_line_items, demands,
-- transactions, payment_authorisations, invoices, bank_statement_imports.

-- ── bank_accounts ─────────────────────────────────────────────────────────────
CREATE TABLE bank_accounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               UUID NOT NULL REFERENCES firms(id),
  property_id           UUID NOT NULL REFERENCES properties(id),
  account_name          TEXT NOT NULL,
  account_type          TEXT NOT NULL,
  -- service_charge | reserve_fund | major_works | insurance | client_holding | other
  bank_name             TEXT,
  -- Only last 4 digits stored — never the full sort code or account number
  sort_code_last4       TEXT,
  account_number_last4  TEXT,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  opened_date           DATE,
  closed_date           DATE,
  requires_dual_auth    BOOLEAN NOT NULL DEFAULT true,
  dual_auth_threshold   NUMERIC(12,2) DEFAULT 0,
  current_balance       NUMERIC(14,2) NOT NULL DEFAULT 0,
  last_reconciled_at    TIMESTAMPTZ,
  rics_designated       BOOLEAN NOT NULL DEFAULT false,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER bank_accounts_updated_at
  BEFORE UPDATE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_bank_accounts_property ON bank_accounts(property_id);
CREATE INDEX idx_bank_accounts_firm ON bank_accounts(firm_id);

-- ── service_charge_accounts ───────────────────────────────────────────────────
CREATE TABLE service_charge_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           UUID NOT NULL REFERENCES firms(id),
  property_id       UUID NOT NULL REFERENCES properties(id),
  account_year_start DATE NOT NULL,
  account_year_end  DATE NOT NULL,
  budget_total      NUMERIC(14,2),
  status            TEXT NOT NULL DEFAULT 'draft',
  -- draft | active | reconciling | finalised
  finalised_at      TIMESTAMPTZ,
  finalised_by      UUID REFERENCES users(id),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER service_charge_accounts_updated_at
  BEFORE UPDATE ON service_charge_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_sca_property ON service_charge_accounts(property_id);

-- ── budget_line_items ─────────────────────────────────────────────────────────
CREATE TABLE budget_line_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           UUID NOT NULL REFERENCES firms(id),
  account_id        UUID NOT NULL REFERENCES service_charge_accounts(id),
  category          TEXT NOT NULL,
  description       TEXT,
  budgeted_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  actual_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  variance          NUMERIC(14,2) GENERATED ALWAYS AS (actual_amount - budgeted_amount) STORED,
  reserve_contribution BOOLEAN NOT NULL DEFAULT false,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_budget_line_items_account ON budget_line_items(account_id);

-- ── demands ───────────────────────────────────────────────────────────────────
-- LTA 1985 s.21B: s21b_attached must be true before status can be 'issued'.
-- LTA 1985 s.20B: issued_date tracked for the 18-month rule.
-- Enforcement is in Edge Function financial-rules, not the database.
CREATE TABLE demands (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           UUID NOT NULL REFERENCES firms(id),
  property_id       UUID NOT NULL REFERENCES properties(id),
  unit_id           UUID NOT NULL REFERENCES units(id),
  leaseholder_id    UUID NOT NULL REFERENCES leaseholders(id),
  account_id        UUID REFERENCES service_charge_accounts(id),
  demand_type       TEXT NOT NULL,
  -- service_charge | ground_rent | reserve_fund | admin_charge | ad_hoc
  period_start      DATE,
  period_end        DATE,
  amount            NUMERIC(14,2) NOT NULL,
  draft_date        DATE,
  issued_date       DATE,
  due_date          DATE,
  s21b_attached     BOOLEAN NOT NULL DEFAULT false,
  status            TEXT NOT NULL DEFAULT 'draft',
  -- draft | issued | part_paid | paid | overdue | disputed | withdrawn
  document_id       UUID,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER demands_updated_at
  BEFORE UPDATE ON demands
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_demands_firm ON demands(firm_id);
CREATE INDEX idx_demands_property ON demands(property_id);
CREATE INDEX idx_demands_unit ON demands(unit_id);
CREATE INDEX idx_demands_status ON demands(status);

-- ── transactions ──────────────────────────────────────────────────────────────
-- Bank account balance is updated by trigger on insert/update/delete.
-- The balance is the sum of all transactions, never a manually set figure.
CREATE TABLE transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             UUID NOT NULL REFERENCES firms(id),
  property_id         UUID NOT NULL REFERENCES properties(id),
  bank_account_id     UUID NOT NULL REFERENCES bank_accounts(id),
  transaction_type    TEXT NOT NULL,
  -- receipt | payment | journal | inter_account_transfer
  transaction_date    DATE NOT NULL,
  amount              NUMERIC(14,2) NOT NULL, -- positive = in, negative = out
  description         TEXT NOT NULL,
  payee_payer         TEXT,
  reference           TEXT,
  demand_id           UUID REFERENCES demands(id),
  invoice_id          UUID,                   -- forward ref; FK added in invoices migration
  reconciled          BOOLEAN NOT NULL DEFAULT false,
  reconciled_at       TIMESTAMPTZ,
  reconciled_by       UUID REFERENCES users(id),
  statement_import_id UUID,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transactions_firm ON transactions(firm_id);
CREATE INDEX idx_transactions_bank_account ON transactions(bank_account_id);
CREATE INDEX idx_transactions_date ON transactions(transaction_date);

-- Trigger to maintain bank_account.current_balance on transaction changes
CREATE OR REPLACE FUNCTION sync_bank_account_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_account_id UUID;
BEGIN
  v_account_id := COALESCE(NEW.bank_account_id, OLD.bank_account_id);
  UPDATE bank_accounts
  SET current_balance = (
    SELECT COALESCE(SUM(amount), 0)
    FROM transactions
    WHERE bank_account_id = v_account_id
  ),
  updated_at = NOW()
  WHERE id = v_account_id;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_balance_sync
  AFTER INSERT OR UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION sync_bank_account_balance();

-- ── payment_authorisations ────────────────────────────────────────────────────
-- Required for payments above bank_account.dual_auth_threshold.
-- The authorising user cannot be the same as the requesting user (enforced in Edge Function).
CREATE TABLE payment_authorisations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firms(id),
  transaction_id  UUID NOT NULL REFERENCES transactions(id),
  requested_by    UUID NOT NULL REFERENCES users(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  authorised_by   UUID REFERENCES users(id),
  authorised_at   TIMESTAMPTZ,
  rejected_by     UUID REFERENCES users(id),
  rejected_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending | authorised | rejected
  authority_limit NUMERIC(14,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_auth_transaction ON payment_authorisations(transaction_id);
CREATE INDEX idx_payment_auth_status ON payment_authorisations(status);

-- ── invoices ──────────────────────────────────────────────────────────────────
CREATE TABLE invoices (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               UUID NOT NULL REFERENCES firms(id),
  property_id           UUID NOT NULL REFERENCES properties(id),
  contractor_id         UUID,                 -- forward ref to contractors
  invoice_number        TEXT,
  invoice_date          DATE,
  due_date              DATE,
  amount_net            NUMERIC(14,2),
  vat_amount            NUMERIC(14,2),
  amount_gross          NUMERIC(14,2),
  description           TEXT,
  status                TEXT NOT NULL DEFAULT 'received',
  -- received | approved | queued | paid | disputed | rejected
  extracted_by_ai       BOOLEAN NOT NULL DEFAULT false,
  extraction_confidence NUMERIC(4,3),        -- 0.000 to 1.000
  extraction_notes      TEXT,
  document_id           UUID,
  approved_by           UUID REFERENCES users(id),
  approved_at           TIMESTAMPTZ,
  transaction_id        UUID REFERENCES transactions(id),
  section20_id          UUID,                -- forward ref
  works_order_id        UUID,               -- forward ref
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_invoices_firm ON invoices(firm_id);
CREATE INDEX idx_invoices_property ON invoices(property_id);
CREATE INDEX idx_invoices_status ON invoices(status);

-- Now that invoices table exists, add the FK from transactions
ALTER TABLE transactions
  ADD CONSTRAINT fk_transactions_invoice
  FOREIGN KEY (invoice_id) REFERENCES invoices(id);

-- ── bank_statement_imports ────────────────────────────────────────────────────
CREATE TABLE bank_statement_imports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         UUID NOT NULL REFERENCES firms(id),
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  import_date     TIMESTAMPTZ NOT NULL DEFAULT now(),
  filename        TEXT,
  row_count       INTEGER,
  matched_count   INTEGER DEFAULT 0,
  unmatched_count INTEGER DEFAULT 0,
  raw_data        JSONB,
  status          TEXT NOT NULL DEFAULT 'pending',
  -- pending | processing | matched | complete | error
  imported_by     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bsi_bank_account ON bank_statement_imports(bank_account_id);
