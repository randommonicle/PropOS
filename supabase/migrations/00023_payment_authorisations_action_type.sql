-- Migration: 00023_payment_authorisations_action_type
-- Phase 3 commit 1g — extend payment_authorisations to authorise non-payment
-- actions (starting with bank account closure).
--
-- Existing rows backfill to action_type='payment' via the DEFAULT, preserving
-- the 1f payment-authorisation flow unchanged. New action_type values
-- (close_bank_account in 1g; toggle_rics_designation in 1g.5; etc.) are
-- enumerated in the CHECK constraint.
--
-- For non-payment actions, `transaction_id` stays null and `proposed` JSONB
-- carries an action-specific snapshot whose shape is application-validated.
-- The CHECK constraint payment_auth_subject_present (added in 00022) still
-- holds: every row has either transaction_id or proposed populated.
--
-- See DECISIONS 2026-05-10 — Closure dual-auth.

ALTER TABLE payment_authorisations
  ADD COLUMN action_type TEXT NOT NULL DEFAULT 'payment';

ALTER TABLE payment_authorisations
  ADD CONSTRAINT payment_auth_action_type
  CHECK (action_type IN ('payment', 'close_bank_account'));

COMMENT ON COLUMN payment_authorisations.action_type IS
  'Discriminator for the kind of action this authorisation gates. payment (default; uses transaction_id post-authorise + proposed pre-authorise) or close_bank_account (uses proposed.bank_account_id; on authorise the application updates bank_accounts.is_active=false). Extends with toggle_rics_designation in 1g.5. See DECISIONS 2026-05-10.';
