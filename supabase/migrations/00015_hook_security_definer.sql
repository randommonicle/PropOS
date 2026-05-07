-- Migration: 00015_hook_security_definer
-- Purpose: Add SECURITY DEFINER to the JWT claims hook.
--
-- Without SECURITY DEFINER, the hook runs as supabase_auth_admin and is subject
-- to RLS on public.users. The users table RLS requires firm_id in the JWT —
-- but the JWT is being created right now, so auth_firm_id() returns NULL,
-- the SELECT finds no rows, and no claims are injected (silent failure).
--
-- SECURITY DEFINER makes the function run as its owner (postgres), which
-- bypasses RLS. SET search_path = public is a security hardening measure
-- required whenever SECURITY DEFINER is used.

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
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

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM PUBLIC;
