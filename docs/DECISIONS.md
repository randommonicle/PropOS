# PropOS — Architectural Decision Log

All significant decisions are recorded here with date, context, options considered, decision made, and rationale.
Spec reference: PropOS Handoff Document v1.1 — Section 6.2.

---

## 2026-05-07 — Supabase key format

**Context:** The Supabase project uses the new `sb_publishable_*` / `sb_secret_*` key format introduced in 2025.
**Decision:** Map `sb_publishable_*` to `VITE_SUPABASE_ANON_KEY` and `sb_secret_*` to `SUPABASE_SERVICE_ROLE_KEY`. Both are equivalent to the legacy `anon` and `service_role` JWT keys respectively.
**Rationale:** Supabase migrated key prefixes in late 2025; behaviour is identical.

---

## 2026-05-07 — Monorepo structure: no workspace tooling in Phase 1

**Context:** Section 9 defines a monorepo with `/app`, `/supabase`, `/docker`, `/docs`. The spec does not mandate a workspace manager (Turborepo, pnpm workspaces, etc.).
**Decision:** Phase 1 uses a flat monorepo with a single `package.json` at `/app`. Workspace tooling is deferred to Phase 8 (self-host package) when the Docker build pipeline requires it.
**Rationale:** Adding workspace tooling adds friction to a solo PoC build. The spec does not require it. This can be introduced cleanly later.

---

## 2026-05-07 — Financial amounts: integer pence internally, formatted for display

**Context:** Section 6.4 mandates all financial amounts are stored and calculated as integers (pence) internally, formatted only at the display layer.
**Decision:** All financial utilities in `/app/src/lib/money.ts` operate on integers. The database stores `NUMERIC(14,2)` per the schema (the spec-defined schema cannot be changed to integers at the DB layer without breaking the stated schema). The conversion layer is in the frontend — database values are multiplied ×100 on read and divided ÷100 on write.
**Rationale:** The spec's schema uses NUMERIC for SQL compatibility, but the TypeScript layer enforces integer pence as the canonical in-memory representation.

---

## 2026-05-07 — shadcn/ui abstraction layer strategy

**Context:** Section 2 SHADCN RISK NOTE requires all shadcn components to be wrapped in `/components/ui` so the underlying primitive library can be swapped.
**Decision:** Every shadcn component is installed into `/app/src/components/ui/` and re-exported from an index file. Consumer components import from `@/components/ui/[component]`, never directly from `shadcn/ui` or `@radix-ui`. The index file is the swap point.
**Rationale:** One-file change to the index swaps the primitive library across all consumers.

---

## 2026-05-07 — JWT `role` claim must not be overwritten

**Context:** The JWT custom access token hook originally set `{role}` to the PropOS application role (e.g. 'admin'). All REST API requests returned HTTP 401.
**Decision:** PropOS application role is stored as `{user_role}` in the JWT. The `{role}` claim is left as Supabase sets it (`authenticated`). `auth_user_role()` reads from `user_role`.
**Rationale:** PostgREST uses the `role` JWT claim to determine the Postgres database role for the request. Setting it to an application role name that doesn't exist as a Postgres role causes PostgREST to reject all requests with 401. This is a PostgREST constraint, not configurable.

---

## 2026-05-07 — JWT hook function must be SECURITY DEFINER

**Context:** The hook function queries `public.users` to get firm_id and role. `public.users` has RLS that requires `firm_id` in the JWT claims. The hook is building those claims, so `firm_id` doesn't exist yet — causing RLS to block the query (silent failure, no error).
**Decision:** The hook function uses `SECURITY DEFINER` and `SET search_path = public`. This makes it run as its owner (`postgres`), which bypasses RLS.
**Rationale:** SECURITY DEFINER is the standard Supabase-recommended approach for hook functions that read from RLS-protected tables. `supabase_auth_admin` also needs explicit `GRANT USAGE ON SCHEMA public` and `GRANT SELECT ON public.users`.

---

## 2026-05-07 — Smoke tests: Node.js Playwright (Python flagged)

**Context:** The project requires real E2E smoke tests run against live Supabase after every significant change.
**Decision:** Playwright with Node.js/TypeScript is the primary test runner (`app/tests/smoke/`). Python is not installed on the dev machine. pytest + playwright (Python) is flagged for addition once Python is installed — full setup instructions in `tests/TESTING.md`.
**Rationale:** Node.js Playwright is a natural fit for a TypeScript project and requires no additional runtime. Python adds a useful fallback and is better suited for DB-level integrity tests (via psycopg2). Both can run in parallel against the same dev server.

---

## 2026-05-09 — Trade categories stored as display names, not slugs

**Context:** `contractors.trade_categories` previously stored normalised slugs (e.g. `general_maintenance`). With the introduction of the `trade_categories` lookup table (migration 00021), categories are now managed as display names (e.g. `General Building`).
**Decision:** Store display names directly in `contractors.trade_categories`. A legacy fallback map (`LEGACY_LABELS`) in `ContractorsPage.tsx` handles old slug-based records during the transition without a data migration.
**Rationale:** Display names are the canonical value in the lookup table. Storing slugs would require a join or lookup every time the categories are rendered. Display names are human-readable, self-documenting, and consistent across the UI. The legacy fallback handles backward compatibility cleanly.

---

## 2026-05-09 — contractor-response uses 302 redirect, not inline HTML

**Context:** The `contractor-response` Edge Function originally returned a styled HTML page directly. In production, contractors were seeing raw HTML source code in their browser.
**Decision:** The function returns `302 Location: ${APP_URL}/contractor-response?status=<status>`. The React app renders the confirmation page.
**Rationale:** The Supabase gateway adds `x-content-type-options: nosniff` and overrides custom `Content-Type` response headers. Even setting `Content-Type: text/html` explicitly (via plain object or `new Headers()`) does not survive the gateway — the browser receives `application/json` or similar, causing the raw source to be displayed. Redirecting to a Vercel-served React route bypasses the gateway entirely. `APP_URL` is set as an Edge Function secret.

---

## 2026-05-09 — --no-verify-jwt is the only reliable JWT bypass for public Edge Functions

**Context:** `contractor-response` is a public endpoint (contractors are not authenticated). Multiple approaches to disable JWT verification were attempted.
**Decision:** Always deploy `contractor-response` with `npx supabase functions deploy contractor-response --no-verify-jwt`. This is baked into `scripts/deploy-functions.bat`.
**Rationale:** `config.toml verify_jwt = false` is not reliably picked up by the Supabase CLI. The Supabase Dashboard "Verify JWT" toggle resets to `true` on every CLI redeploy. The `--no-verify-jwt` CLI flag is the only method that persistently disables JWT verification for a function. Documented as a critical gotcha in README.md.

---

## 2026-05-09 — Email domain: proposdigital.uk on Cloudflare + Resend Pro

**Context:** The dispatch engine needs a custom sender domain for Resend (e.g. `works@proposdigital.uk`). Personal domain `bengraham.uk` was not suitable for a product.
**Decision:** Registered `proposdigital.uk` on Cloudflare (£8/year). Resend Pro subscription required (free tier: 1 domain only, and `bengraham.uk` was already registered).
**Rationale:** A product-specific domain adds professionalism to contractor emails and avoids personal domain exposure. Cloudflare provides DNS management and the domain is verified in Resend via DKIM/SPF records. Future: add `proposdigital.uk` landing page for brand presence.

---

## 2026-05-09 — Priority-based dispatch deadline auto-selection

**Context:** Previously the dispatch modal defaulted to 48 hours regardless of works order priority. PMs had to manually adjust the deadline for each priority level.
**Decision:** The `DispatchModal` computes the default deadline from `PRIORITY_DEADLINE_HOURS = { emergency: 4, high: 24, normal: 48, low: 120 }`. A hint label informs the PM of the auto-selection; they can still override it.
**Rationale:** Emergency works need a 4-hour response window; low-priority works can wait 5 days. Auto-setting the deadline based on priority reduces PM cognitive load and ensures urgency is reflected in contractor expectations. The override allows flexibility for unusual circumstances.

---

## 2026-05-07 — pgAudit enablement approach

**Context:** Section 4 requires pgAudit to be enabled before any data migration. The Supabase hosted project does not allow direct superuser SQL for extension creation on the free tier in some cases.
**Decision:** pgAudit is enabled via a migration that calls `CREATE EXTENSION IF NOT EXISTS pgaudit;`. On Supabase Pro/hosted, this runs as the `postgres` role which has extension creation rights. If the extension is already enabled by the platform, the `IF NOT EXISTS` clause prevents an error.
**Rationale:** Supabase Pro grants extension creation to the `postgres` role. The migration is idempotent.

---
