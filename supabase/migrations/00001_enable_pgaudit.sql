-- Migration: 00001_enable_pgaudit
-- Purpose: Enable pgAudit extension for database-level audit trail.
-- MUST run before any schema creation per Section 4 of the PropOS spec.
-- Required for RICS client money inspection and BSA Golden Thread immutability.
--
-- Note: ALTER SYSTEM (for pgaudit.log settings) must be run outside a transaction
-- and requires superuser access. On Supabase hosted, pgAudit config is managed
-- via the Supabase dashboard Extensions panel. The CREATE EXTENSION below is
-- what's needed for the migration runner.
-- See DECISIONS.md: 2026-05-07 pgAudit enablement approach.

CREATE EXTENSION IF NOT EXISTS pgaudit;
