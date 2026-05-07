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

## 2026-05-07 — pgAudit enablement approach

**Context:** Section 4 requires pgAudit to be enabled before any data migration. The Supabase hosted project does not allow direct superuser SQL for extension creation on the free tier in some cases.
**Decision:** pgAudit is enabled via a migration that calls `CREATE EXTENSION IF NOT EXISTS pgaudit;`. On Supabase Pro/hosted, this runs as the `postgres` role which has extension creation rights. If the extension is already enabled by the platform, the `IF NOT EXISTS` clause prevents an error.
**Rationale:** Supabase Pro grants extension creation to the `postgres` role. The migration is idempotent.

---
