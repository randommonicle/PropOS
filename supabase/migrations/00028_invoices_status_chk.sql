-- Migration: 00028_invoices_status_chk
-- Locks the invoices state machine + AI-extraction audit-stamp coherence
-- + amount-arithmetic coherence at the DB layer. UI already enforces these;
-- this is the data-integrity belt-and-braces pattern from 1i.1 §M-3 / §M-4
-- applied to invoices.
--
-- Anchor: docs/DECISIONS.md 2026-05-10 — Invoices CRUD with AI extraction
-- (1i.2). Closes the Phase 3 §7 deliverable "invoice management with AI
-- extraction".
--
-- Regulatory framing:
--   - RICS Service Charge Residential Management Code, 4th edition, effective
--     7 April 2026 — service-charge accounting + audit-trail framing.
--   - RICS Client money handling (1st ed., Oct 2022 reissue) — dual-auth on
--     all client-account withdrawals, no monetary threshold; segregation of
--     payee-setup vs payment-release functions.
--   - TPI Consumer Charter & Standards Edition 3 (effective 1 Jan 2025) —
--     reinforces the dual-auth and segregation-of-duties requirements.
--
-- Status state-machine values from 00005:204 (CHECK locks the canonical six):
--   received | approved | queued | paid | disputed | rejected
--
-- The role-gated transition graph (which roles can drive which edges) is
-- enforced client-side at PoC; server-side enforcement lands with the
-- financial-rules Edge Function (PROD-GATE manifest item 9).

BEGIN;

-- ── invoices_status_chk ──────────────────────────────────────────────────────
-- Locks the canonical six values from 00005:204. Direct supabase-js writes
-- with any other status value are rejected with PostgreSQL error code 23514.
ALTER TABLE invoices
  ADD CONSTRAINT invoices_status_chk
  CHECK (status IN ('received','approved','queued','paid','disputed','rejected'));

-- ── invoices_extraction_pair_chk ─────────────────────────────────────────────
-- Audit-stamp coherence — same pattern as 1i.1 §M-4 (pa_authorised_pair_chk
-- on payment_authorisations). If AI extracted, confidence MUST be present.
-- If no AI ran, confidence MUST be NULL. Defends against direct-DB tampering
-- where a row claims AI provenance without the confidence stamp, or carries
-- a confidence value without an AI run.
ALTER TABLE invoices
  ADD CONSTRAINT invoices_extraction_pair_chk
  CHECK (
    (extracted_by_ai = true  AND extraction_confidence IS NOT NULL)
    OR
    (extracted_by_ai = false AND extraction_confidence IS NULL)
  );

-- ── invoices_amount_coherence_chk ────────────────────────────────────────────
-- Spec §6.4 (integer-pence arithmetic) locked at the DB layer. Only enforced
-- when all three values are present; partial fills are allowed during the AI
-- review window when Claude returned only some fields with confidence.
-- The UI already validates this on save; the constraint is belt-and-braces
-- against direct-DB writes.
ALTER TABLE invoices
  ADD CONSTRAINT invoices_amount_coherence_chk
  CHECK (
    amount_net IS NULL
    OR amount_gross IS NULL
    OR amount_gross = amount_net + COALESCE(vat_amount, 0)
  );

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- FORWARD: PROD-GATE flags
--
-- The following items are deliberately NOT in this migration. Each is paired
-- with a code anchor (this file + the relevant component) and recorded in
-- the Production-grade gate manifest (DECISIONS 2026-05-10). The exit-demo
-- pre-flight will scan for these before flipping firms.is_demo = false.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. FORWARD: PROD-GATE — Per-property invoice spend cap.
--    Reason: properties.invoice_approval_threshold column + UI block when an
--    invoice's amount_gross exceeds the cap. Out of scope this commit; landing
--    pairs with item 2 below.
--    Anchor: docs/DECISIONS.md 2026-05-10 — Per-property invoice spend cap
--    (forward-looking requirement).
--
-- 2. FORWARD: PROD-GATE — Director-approval queue for over-cap invoices.
--    Reason: extends payment_authorisations.action_type CHECK constraint to
--    include 'invoice_over_cap_approval'. Reuses the 1g/1g.5 dual-auth
--    machinery; pairs with item 1.
--    Anchor: app/src/components/modules/financial/PaymentAuthorisationsTab.tsx
--    discriminator block.
--
-- 3. FORWARD: PROD-GATE — INSERT trigger on documents row firing the
--    document_processing.ts Edge Function automatically.
--    Reason: spec §5.7 says "Insert trigger fires document_processing.ts
--    Edge Function asynchronously". PoC client-invokes the Edge Function via
--    supabase.functions.invoke after upload. Server-side trigger is a
--    Production-grade gate manifest item.
--    Anchor: supabase/functions/document_processing/index.ts header.
--
-- 4. FORWARD: PROD-GATE — DAILY_AI_COST_CAP_GBP per-firm enforcement.
--    Reason: spec §5.7 AI COST CONTROL requires per-firm cumulative-spend
--    tracking + queueing past the cap. Requires firm-cost-tracking table
--    (not yet built). Phase 5+ candidate.
--    Anchor: supabase/functions/document_processing/index.ts header.
--
-- 5. FORWARD: PROD-GATE — invoices_status_transition_chk trigger.
--    Reason: rejects illegal status edges at the DB layer (e.g. received →
--    paid skipping approved). Today the transition graph is enforced client-
--    side only. Server-side enforcement lands with the financial-rules
--    Edge Function commit.
--    Anchor: this file + app/src/lib/invoices/statusTransitions.ts.
--
-- 6. FORWARD: PROD-GATE — INSERT-only invoices_audit_log for status
--    transitions (RICS Client money handling §X.X dual-auth evidence trail).
--    Reason: append-only audit table mirroring reconciliation_audit_log
--    (00025). Every status transition writes a row with actor_id, before/
--    after state, statutory citation. Lands with the data-integrity / auto-
--    protect pass commit.
--    Anchor: docs/DECISIONS.md 2026-05-10 — Data-integrity / auto-protect pass.
--
-- 7. FORWARD: PROD-GATE — invoices.contractor_id FK constraint.
--    Reason: column is currently a forward UUID (00005:195) with no FK.
--    Closing the FK + CASCADE rules pairs with the contractor-onboarding
--    revisit (item 9 below) where contractors gain approved_by + approved_at.
--    Anchor: this file + supabase/migrations/00008_contractors_and_works.sql.
--
-- 8. FORWARD: PROD-GATE — Function-split discriminator on
--    payment_authorisations.action_type.
--    Reason: RICS Client money handling requires segregation between staff
--    who set up payee bank details and staff who release payments — two
--    distinct functions, not just two distinct people. Today's action_type
--    has 'payment' as a single value; the regulatory shape wants it split
--    into 'payment_payee_setup' + 'payment_release'. Lands in 1i.3 alongside
--    the role architecture rework.
--    Anchor: docs/DECISIONS.md 2026-05-10 — Invoices CRUD with AI extraction
--    (1i.2) §F5.
--
-- 9. FORWARD: PROD-GATE — Contractor-onboarding approved_by / approved_at
--    stamps + payee-setter-not-equal-to-authoriser gate.
--    Reason: stronger gate than user_id != requester_id. Authoriser must not
--    be the same staff member who set up the contractor as a payee. Pairs
--    with item 8 to give the regulatory function-split semantic at runtime.
--    Anchor: supabase/migrations/00008_contractors_and_works.sql header.
--
-- 10. FORWARD: PROD-GATE — BSA HRB Accountable Person sign-off lane on
--     major-works invoices for Higher-Risk Buildings.
--     Reason: RICS Code 4th ed. centres BSA compliance for HRBs; major-works
--     payment flows on HRBs may need an additional approval lane (Accountable
--     Person sign-off) on top of the standard dual-auth. Phase 4 BSA module
--     anchor.
--     Anchor: docs/DECISIONS.md 2026-05-10 §F4 + Phase 4 BSA module.
--
-- 11. FORWARD: PROD-GATE — Bank-side dual-auth mandate.
--     Reason: RICS expects dual-auth at the BANK (online banking dual-release
--     on the client account mandate). The in-app gate is a control layer
--     above that. The bank mandate must independently enforce two staff
--     signatories. Operational doc, not code — anchor in setup runbook.
--     Anchor: docs/SETUP_CLIENT_BANK_ACCOUNT.md (forward — Phase 8 self-host
--     package).
--
-- ─────────────────────────────────────────────────────────────────────────────
