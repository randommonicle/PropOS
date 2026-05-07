-- Migration: 00003_identity_and_firm
-- Purpose: Section 4.1 — Identity and Firm tables (firms, users).
-- These are the root tables; all others have firm_id FK pointing here.

-- ── firms ──────────────────────────────────────────────────────────────────────
CREATE TABLE firms (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      TEXT NOT NULL,
  slug                      TEXT UNIQUE NOT NULL,
  subscription_tier         TEXT NOT NULL DEFAULT 'trial', -- trial | starter | pro | enterprise
  rics_regulated            BOOLEAN NOT NULL DEFAULT false,
  rics_firm_number          TEXT,
  address_line1             TEXT,
  address_line2             TEXT,
  town                      TEXT,
  postcode                  TEXT,
  phone                     TEXT,
  email                     TEXT,
  website                   TEXT,
  logo_storage_path         TEXT,
  client_money_account_bank TEXT,
  deployment_mode           TEXT DEFAULT 'saas', -- saas | self_hosted | licensed
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER firms_updated_at
  BEFORE UPDATE ON firms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── users ──────────────────────────────────────────────────────────────────────
-- Extends Supabase auth.users. One row per auth user.
CREATE TABLE users (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  firm_id      UUID NOT NULL REFERENCES firms(id),
  full_name    TEXT NOT NULL,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'read_only',
  -- admin | property_manager | director | leaseholder | contractor | read_only
  phone        TEXT,
  active       BOOLEAN NOT NULL DEFAULT true,
  last_login   TIMESTAMPTZ,
  portal_access BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Index for firm_id lookups (used in every RLS policy)
CREATE INDEX idx_users_firm_id ON users(firm_id);
