-- Migration 00020: Dispatch engine — timeout function + pg_cron schedule
-- ─────────────────────────────────────────────────────────────────────────────
-- dispatch_timeout_check():
--   Marks all un-answered dispatches past their deadline as 'no_response'
--   and resets the corresponding works order back to 'draft' so it can be
--   re-dispatched. Runs every 15 minutes via pg_cron.
--
-- Using a plain PL/pgSQL function avoids the need for pg_net / HTTP calls.
-- The Edge Function `dispatch-timeout` is a manual-trigger wrapper for the same logic.
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable pg_cron (available by default on Supabase; safe to re-run if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA cron TO postgres;

-- ── Core timeout function ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.dispatch_timeout_check()
RETURNS INTEGER        -- number of dispatches timed out this run
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  -- Step 1: mark expired, un-answered dispatches as no_response
  WITH expired AS (
    UPDATE dispatch_log
    SET response              = 'no_response',
        response_received_at  = now()
    WHERE response IS NULL
      AND response_deadline < now()
    RETURNING works_order_id
  ),
  -- Step 2: reset the works order only if it is still in 'dispatching'
  -- (guards against a race where the contractor accepted just before cron ran)
  reset AS (
    UPDATE works_orders
    SET status = 'draft'
    WHERE id IN (SELECT works_order_id FROM expired)
      AND status = 'dispatching'
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM reset;

  RETURN v_count;
END;
$$;

-- Only service_role needs to call this (cron runs as postgres, which is superuser)
GRANT EXECUTE ON FUNCTION public.dispatch_timeout_check() TO service_role;

-- ── pg_cron schedule ────────────────────────────────────────────────────────
-- Runs every 15 minutes.
-- Safe to re-run: unschedule first in case migration is re-applied.
SELECT cron.unschedule('dispatch-timeout-check') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'dispatch-timeout-check'
);

SELECT cron.schedule(
  'dispatch-timeout-check',   -- job name
  '*/15 * * * *',             -- every 15 minutes
  'SELECT public.dispatch_timeout_check()'
);
