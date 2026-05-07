-- Migration: 00002_updated_at_trigger
-- Purpose: Shared trigger function to auto-maintain updated_at timestamps.
-- Applied to all tables that have an updated_at column.

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
