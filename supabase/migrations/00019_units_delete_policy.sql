-- Migration 00019: Add missing DELETE policy for units table
-- The units RLS setup in 00012 only had SELECT, INSERT, UPDATE.
-- Without a DELETE policy PostgREST silently blocks deletes (0 rows, no error).

CREATE POLICY units_delete ON units
  FOR DELETE USING (firm_id = auth_firm_id() AND is_pm_or_admin());
