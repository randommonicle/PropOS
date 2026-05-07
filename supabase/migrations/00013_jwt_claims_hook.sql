-- Migration: 00013_jwt_claims_hook
-- Purpose: Supabase auth hook that injects firm_id and role into the JWT claims.
-- This is required for all RLS policies that call auth_firm_id() and auth_user_role().
--
-- Registered in Supabase Dashboard: Authentication > Hooks > Custom Access Token.
-- The function signature must match Supabase's hook spec exactly.

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_user_id   UUID;
  v_firm_id   UUID;
  v_role      TEXT;
  claims      JSONB;
BEGIN
  v_user_id := (event ->> 'user_id')::UUID;

  SELECT firm_id, role
  INTO v_firm_id, v_role
  FROM public.users
  WHERE id = v_user_id AND active = true;

  claims := event -> 'claims';

  IF v_firm_id IS NOT NULL THEN
    claims := jsonb_set(claims, '{firm_id}', to_jsonb(v_firm_id::TEXT));
    claims := jsonb_set(claims, '{role}', to_jsonb(v_role));
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

-- Grant execute permission to supabase_auth_admin
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM PUBLIC;

-- IMPORTANT: After running this migration, go to:
-- Supabase Dashboard > Authentication > Hooks > Custom Access Token Hook
-- and set it to: public.custom_access_token_hook
-- See docs/DECISIONS.md for rationale.
