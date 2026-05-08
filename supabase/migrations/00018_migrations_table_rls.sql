-- ============================================================
-- Migration 00018: Enable RLS on _migrations tracking table
--
-- The _migrations table is used only by run_migrations.mjs via a
-- direct Postgres superuser connection, which bypasses RLS entirely.
-- Enabling RLS with no policies blocks all PostgREST (API) access
-- from anon/authenticated roles — preventing any user from reading
-- schema history or tampering with migration tracking records.
-- ============================================================

ALTER TABLE public._migrations ENABLE ROW LEVEL SECURITY;
