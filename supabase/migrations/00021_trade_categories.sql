-- Migration 00021: trade_categories lookup table
-- ─────────────────────────────────────────────────────────────────────────────
-- Replaces freeform comma-separated trade_categories on contractors with a
-- managed per-firm list. Admins/PMs can add new categories; contractors
-- tick from the list rather than typing freeform.
--
-- contractors.trade_categories (TEXT[]) remains unchanged — values are now
-- the display names from this table rather than normalised slugs.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.trade_categories (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     UUID        NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  sort_order  INTEGER     NOT NULL DEFAULT 99,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, name)
);

ALTER TABLE public.trade_categories ENABLE ROW LEVEL SECURITY;

-- All authenticated firm members can read
CREATE POLICY tc_select ON public.trade_categories
  FOR SELECT USING (firm_id = auth_firm_id());

-- PM or admin can add new categories
CREATE POLICY tc_insert ON public.trade_categories
  FOR INSERT WITH CHECK (firm_id = auth_firm_id() AND is_pm_or_admin());

-- PM or admin can toggle active / rename
CREATE POLICY tc_update ON public.trade_categories
  FOR UPDATE USING (firm_id = auth_firm_id() AND is_pm_or_admin());

-- Only admin / director can hard-delete a category
CREATE POLICY tc_delete ON public.trade_categories
  FOR DELETE USING (firm_id = auth_firm_id() AND auth_user_role() IN ('admin', 'director'));

-- ── Seed helper ───────────────────────────────────────────────────────────────
-- Call this when provisioning a new firm. Idempotent (ON CONFLICT DO NOTHING).
CREATE OR REPLACE FUNCTION public.seed_trade_categories(p_firm_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.trade_categories (firm_id, name, sort_order) VALUES
    (p_firm_id, 'Plumbing',               1),
    (p_firm_id, 'Electrical',             2),
    (p_firm_id, 'Gas / Heating',          3),
    (p_firm_id, 'Carpentry & Joinery',    4),
    (p_firm_id, 'Painting & Decorating',  5),
    (p_firm_id, 'Roofing',                6),
    (p_firm_id, 'Plastering',             7),
    (p_firm_id, 'Glazing',                8),
    (p_firm_id, 'Locksmith',              9),
    (p_firm_id, 'HVAC / Ventilation',    10),
    (p_firm_id, 'Drainage',              11),
    (p_firm_id, 'Flooring',              12),
    (p_firm_id, 'Tiling',               13),
    (p_firm_id, 'Bricklaying',           14),
    (p_firm_id, 'Scaffolding',           15),
    (p_firm_id, 'Groundworks',           16),
    (p_firm_id, 'Landscaping',           17),
    (p_firm_id, 'Cleaning',              18),
    (p_firm_id, 'Pest Control',          19),
    (p_firm_id, 'Fire Safety',           20),
    (p_firm_id, 'Asbestos',             21),
    (p_firm_id, 'Lift / Elevator',       22),
    (p_firm_id, 'General Building',      23),
    (p_firm_id, 'Structural',            24)
  ON CONFLICT (firm_id, name) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_trade_categories(UUID) TO service_role;

-- Seed the demo firm
SELECT public.seed_trade_categories('69ff568e-8849-4177-8b83-43240686c577');
