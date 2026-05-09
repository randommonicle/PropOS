-- Migration: 00022_payment_authorisations_proposed
-- Phase 3 commit 1f — Payment Authorisations gate.
--
-- Allows a `payment_authorisations` row to exist BEFORE its transaction is
-- created, by storing the proposed transaction's snapshot in a JSONB column.
-- On authorise, the application inserts the actual `transactions` row and
-- links it via `transaction_id`. On reject / cancel, the proposed transaction
-- is never created.
--
-- Without this change the existing NOT NULL on `transaction_id` made the
-- natural authorisation flow (request → review → approve) impossible: the
-- transaction had to exist before the authorisation request, which meant the
-- balance trigger would falsify `bank_accounts.current_balance` while the
-- request was pending.
--
-- Inner shape of `proposed` JSONB (application-validated, not enforced by
-- Postgres at this stage):
--   {
--     bank_account_id:   uuid,
--     amount:            number (signed; payment is negative),
--     transaction_date:  string ('YYYY-MM-DD'),
--     description:       string,
--     payee_payer:       string | null,
--     reference:         string | null,
--     demand_id:         uuid | null
--   }
--
-- See DECISIONS 2026-05-10 — Payment Authorisations.

ALTER TABLE payment_authorisations
  ALTER COLUMN transaction_id DROP NOT NULL;

ALTER TABLE payment_authorisations
  ADD COLUMN proposed JSONB;

ALTER TABLE payment_authorisations
  ADD CONSTRAINT payment_auth_subject_present
  CHECK ((transaction_id IS NOT NULL) OR (proposed IS NOT NULL));

COMMENT ON COLUMN payment_authorisations.proposed IS
  'Snapshot of the proposed transaction when this authorisation is pending. On authorise the application inserts a transactions row and sets transaction_id; on reject the proposed transaction is never created. Inner shape is application-validated. See DECISIONS 2026-05-10 — Payment Authorisations.';
