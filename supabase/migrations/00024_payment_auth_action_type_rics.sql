-- Migration: 00024_payment_auth_action_type_rics
-- Phase 3 commit 1g.5 — extend payment_authorisations to authorise removal of
-- the RICS-designated client-account flag on a bank account.
--
-- Direction-gated: only the dangerous direction (rics_designated true → false)
-- is gated by this flow. The protective direction (false → true) stays a
-- direct edit, no request needed. See DECISIONS 2026-05-10 1g §8 and the
-- 1g.5 entry added in this commit.
--
-- Existing rows are unaffected — only the CHECK constraint is widened. The
-- new action_type value 'toggle_rics_designation' uses the same proposed JSONB
-- column with shape { bank_account_id, new_value: boolean }, validated at the
-- application layer (TypeScript ProposedRicsDesignationToggle).
--
-- FORWARD: when financial-rules Edge Function lands (deferred), it must
-- enforce the same direction-gating, role guard, and self-auth guard that the
-- UI enforces today. See DECISIONS 2026-05-10 — Closure dual-auth + 1g.5.

ALTER TABLE payment_authorisations
  DROP CONSTRAINT payment_auth_action_type;

ALTER TABLE payment_authorisations
  ADD CONSTRAINT payment_auth_action_type
  CHECK (action_type IN ('payment', 'close_bank_account', 'toggle_rics_designation'));

COMMENT ON COLUMN payment_authorisations.action_type IS
  'Discriminator for the kind of action this authorisation gates. payment (default; uses transaction_id post-authorise + proposed ProposedTransaction pre-authorise), close_bank_account (uses proposed ProposedClosure; on authorise the application updates bank_accounts.is_active=false + closed_date), toggle_rics_designation (1g.5; uses proposed ProposedRicsDesignationToggle; on authorise the application updates bank_accounts.rics_designated=new_value — direction-gated to true→false). See DECISIONS 2026-05-10.';
