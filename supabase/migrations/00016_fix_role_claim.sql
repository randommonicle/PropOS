-- Migration: 00016_fix_role_claim
-- Purpose: Rename JWT claim from 'role' to 'user_role'.
--
-- The Postgres JWT 'role' claim is reserved by PostgREST — it specifies which
-- Postgres database role to use for the request (must be 'authenticated', 'anon',
-- or 'service_role'). Overwriting it with our PropOS role name ('admin',
-- 'property_manager', etc.) caused PostgREST to reject all API requests with 401
-- because no matching Postgres role exists.
--
-- Fix: store PropOS role as 'user_role' claim. Update auth_user_role() helper
-- to read from the new claim name. All RLS policies that call auth_user_role()
-- continue to work unchanged.

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
    claims := jsonb_set(claims, '{user_role}', to_jsonb(v_role));
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM PUBLIC;

CREATE OR REPLACE FUNCTION auth_user_role() RETURNS TEXT AS $$
  SELECT auth.jwt() ->> 'user_role';
$$ LANGUAGE SQL STABLE;
