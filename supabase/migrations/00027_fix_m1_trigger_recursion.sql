-- Migration: 00027_fix_m1_trigger_recursion
-- Fix-up for 00026_security_hardening.sql §M-1.
--
-- The block_balance_writes() trigger as written in 00026 fires on EVERY
-- UPDATE on bank_accounts that changes current_balance — including the
-- legitimate UPDATE issued by sync_bank_account_balance() (00005:145), which
-- recomputes current_balance on every transactions INSERT/UPDATE/DELETE.
--
-- Result of the bug: ALL transactions writes fail with the M-1 exception,
-- breaking every financial flow. Caught by the smoke suite (108 - 1 + 12 = 119
-- expected vs 96 passing on the post-00026 first run).
--
-- Fix: gate the rejection on pg_trigger_depth() = 1. When the BEFORE-UPDATE
-- trigger fires from a top-level user UPDATE, depth is 1 — we reject. When
-- it fires from inside another trigger's UPDATE (sync_bank_account_balance
-- doing its job), depth is 2+ — we allow. This preserves the M-1 contract
-- for user-reachable paths while not breaking the trigger-maintained sync.
--
-- The intended threat model is unchanged: a PM calling supabase-js .update()
-- on bank_accounts.current_balance still triggers the rejection (depth = 1).
-- Service-role-key writes from outside any trigger context are also still
-- rejected (depth = 1 in those cases too — no AFTER trigger has called us).

CREATE OR REPLACE FUNCTION block_balance_writes() RETURNS TRIGGER
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_balance IS DISTINCT FROM OLD.current_balance
     AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'bank_accounts.current_balance is trigger-maintained; do not write directly. Use a transactions row to adjust the balance.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
