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

## 2026-05-07 — pgAudit enablement approach

**Context:** Section 4 requires pgAudit to be enabled before any data migration. The Supabase hosted project does not allow direct superuser SQL for extension creation on the free tier in some cases.
**Decision:** pgAudit is enabled via a migration that calls `CREATE EXTENSION IF NOT EXISTS pgaudit;`. On Supabase Pro/hosted, this runs as the `postgres` role which has extension creation rights. If the extension is already enabled by the platform, the `IF NOT EXISTS` clause prevents an error.
**Rationale:** Supabase Pro grants extension creation to the `postgres` role. The migration is idempotent.

---
