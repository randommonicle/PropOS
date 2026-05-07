-- Migration: 00014_fix_hook_permissions
-- Purpose: Grant supabase_auth_admin the table access it needs to execute
-- the custom_access_token_hook. EXECUTE on the function was granted in 00013
-- but the function body does SELECT on public.users — that also needs granting.

GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT SELECT ON public.users TO supabase_auth_admin;
