# PropOS

Full-stack property management operating system for RICS-regulated managing agents, SME agents, and RMC/RTM self-managed blocks.

**Status:** Phase 3 (Financial) in progress — financial entities (bank accounts, service charge accounts, demands, transactions) and the dual-auth flow (payment authorisations + bank-account closure) all shipped (1a–1g). Bank reconciliation and statement import next.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite + TypeScript (strict) + Tailwind + shadcn/ui |
| Backend | Supabase — Postgres 15, Auth, Storage, Edge Functions |
| State | Zustand (domain stores) + TanStack Query (server data) |
| Email | Resend |
| AI | Claude API (claude-sonnet-4-6) |
| Hosting | Vercel Pro |
| Testing | Playwright Node.js + pytest/Playwright Python — see [Testing](#testing) |

---

## Quick start — local dev

Prerequisites: Node 20+, a running Supabase project (see below).

```cmd
cd app
npm install
npm run dev
```

Requires `app/.env.local`:
```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<sb_publishable_...>
```

Dev server starts at **http://localhost:5173**.

---

## Repository structure

```
PropOS/
├── app/                    # React frontend (Vite + TypeScript)
│   ├── src/
│   │   ├── components/     # UI components (ui/ is the shadcn abstraction layer)
│   │   ├── hooks/          # useAuth and other custom hooks
│   │   ├── lib/            # supabase client, utils, money, constants
│   │   ├── stores/         # Zustand stores (authStore, etc.)
│   │   └── types/          # Hand-written database types (all 26 tables)
│   ├── tests/smoke/        # Playwright E2E smoke tests
│   └── playwright.config.ts
├── supabase/
│   ├── migrations/         # Numbered SQL migrations (run via run_migrations.mjs)
│   └── seed/               # Idempotent seed scripts
├── docs/
│   ├── DECISIONS.md        # Architectural decision log
│   ├── LESSONS_LEARNED.md  # Post-phase retrospective
│   └── COMPLIANCE.md       # UK GDPR / RICS / BSA / LTA notes
└── tests/
    └── TESTING.md          # Testing strategy and Python flag
```

---

## Database

**23 migrations** (00001–00023) covering all 26 tables + trade_categories, RLS policies, dispatch engine, storage security, infrastructure hardening, payment_authorisations extensions for the dual-auth flow. Apply new migrations via the Supabase CLI:

```bash
SUPABASE_ACCESS_TOKEN=<token> npx supabase link --project-ref <ref>
SUPABASE_ACCESS_TOKEN=<token> npx supabase db push
```

If previous migrations were applied via the SQL editor (not CLI), the remote history table will be empty. Repair it first so only new migrations are pushed:

```bash
SUPABASE_ACCESS_TOKEN=<token> npx supabase migration repair 00001 00002 ... 00020 --status applied
SUPABASE_ACCESS_TOKEN=<token> npx supabase db push
```

> **Note:** Run `set` on **separate lines** in cmd.exe (see [Known gotchas](#known-gotchas)). In bash, use `VAR=value command` inline syntax.

### First-time setup (manual steps required)

1. **Enable the JWT claims hook:**
   Supabase Dashboard → Authentication → Hooks → Custom Access Token Hook → `public.custom_access_token_hook`

2. **Create an admin user:**
   Supabase Dashboard → Authentication → Users → Add user (auto-confirm).
   Then on separate cmd.exe lines:
   ```cmd
   set DB_URL=postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres
   set ADMIN_USER_ID=<uuid-from-dashboard>
   set ADMIN_EMAIL=<email>
   node supabase/seed/demo_seed.mjs
   ```

3. **Sign out and back in** after seeding to get a fresh JWT with `firm_id` injected.

---

## Testing

Playwright headless Chromium E2E suite — hits real Supabase, no mocks.

```cmd
cd app
npm run test:smoke           # headless (standard — run this after every change)
npm run test:smoke:headed    # with visible browser (debugging failures)
npm run test:smoke:ui        # interactive Playwright UI
npm run test:smoke:report    # open last HTML report
```

The dev server must be running (`npm run dev`) or Playwright will start it automatically.

**Current coverage (Phases 1, 2, and Phase 3 commits 1a–1g):**

| Spec | Tests |
|------|-------|
| auth.setup + auth-pm.setup | Login flow as admin and as PM, JWT hook, dashboard redirect |
| dashboard | Firm name, stat cards, no 401s, sidebar nav |
| properties | List loads, seed data, create property round-trip |
| documents | Page load, upload button, type filter |
| compliance | Page load, RAG summary, tabs, create round-trip |
| contractors | Page load, sidebar nav, create round-trip |
| works | Page load, tabs, works order create, S20 create |
| property_detail | Units CRUD (create, edit, delete+confirm); leaseholders CRUD (create, edit, end, delete+confirm); tab navigation |
| financial-bank-accounts | Bank accounts CRUD, MoneyInput round-trip, last-4 validation, mark-as-closed, regulatory delete guard |
| financial-service-charge-accounts | SCA CRUD, status state machine, finalised lock, draft-only delete, FK-blocked delete |
| financial-demands | Demands CRUD, leaseholder picker filtering, LTA s.21B guard (status + issued_date), state machine, paid lock, draft-only delete, regulatory delete guard |
| financial-transactions | Transactions CRUD, sign-aware MoneyInput, balance trigger, demand auto-status, reconciled / statement-import locks, draft delete |
| financial-payment-authorisations | Dual-auth request flow, self-auth guard, cross-user authorise / reject / cancel, immutability, closure dual-auth (PM-driven UI + admin authorise) |

**Total: 85 tests passing.** Node.js Playwright is the primary runner; Python (pytest + Playwright) is installed and ready for DB-integrity tests as a parallel runner.


---

## Key architectural decisions

- **JWT `role` claim is reserved** — never overwrite it. PropOS stores its application role as `user_role` in the JWT. PostgREST uses `role` to pick the Postgres database role; overwriting it causes 401 on all API calls.
- **JWT hook must be `SECURITY DEFINER`** — without it, the hook is blocked by RLS on `public.users` (chicken-and-egg: JWT needed to read table, table needed to build JWT).
- **shadcn/ui abstraction layer** — all components import from `@/components/ui`, never directly from `@radix-ui`. One file to swap the primitive library.
- **Financial amounts as integer pence** — all internal calculations in pence. DB stores NUMERIC(14,2). Conversion only at the boundary.
- **Golden Thread immutability** — enforced at three layers: no `updated_at` column, RLS SELECT/INSERT only (no UPDATE/DELETE policies), TypeScript `Update: never`.

Full decision log: [`docs/DECISIONS.md`](docs/DECISIONS.md)

---

## Phase roadmap

| Phase | Status | Deliverables |
|-------|--------|-------------|
| 1 — Foundation | ✅ Complete | Schema, auth, CRUD, document vault, dashboard |
| 2 — Compliance & Works | ✅ Complete | Compliance tracker (RAG), insurance tracker, contractor register + managed trade categories, works orders, dispatch engine (token + email), contractor response page, Section 20 full lifecycle, UX polish |
| 3 — Financial | In progress | ✓ Bank accounts, ✓ Service charge accounts, ✓ Demands, ✓ Transactions, ✓ Payment authorisations (dual-auth), ✓ Bank account closure dual-auth. Bank reconciliation and statement import next. |
| 4 — Portals | Planned | Leaseholder portal, maintenance requests |
| 5 — BSA Module | Planned | Golden Thread, mandatory occurrences, HRB register |
| 6 — Reporting | Planned | PDF reports, AGM packs, Section 20B schedules |
| 7 — AI Layer | Planned | Document AI, works triage, compliance alerts |
| 8 — Self-host | Planned | Docker + Cloudflare Tunnel deployment mode |

---

## Deploying Edge Functions

```bash
# Both functions — use the .bat script which bakes in the correct flags
scripts\deploy-functions.bat

# Or manually:
npx supabase functions deploy dispatch-engine --project-ref <ref>
npx supabase functions deploy contractor-response --project-ref <ref> --no-verify-jwt
```

> **`--no-verify-jwt` is mandatory** for `contractor-response`. The `config.toml` setting and the Supabase Dashboard toggle both reset on every CLI redeploy. The CLI flag is the only reliable method.

---

## Known gotchas

- **cmd.exe `&&` gives env vars trailing spaces:** `set VAR=value && next` sets VAR to `value ` (with space). Always use separate lines in cmd.exe.
- **JWT hook requires manual Dashboard registration** — cannot be automated via SQL. Must be enabled in Auth → Hooks UI.
- **Supabase CLI type gen requires Docker** — types in `app/src/types/database.ts` are hand-written. Run migrations first, then update types manually when schema changes.
- **`Relationships: []` required in supabase-js v2.49+** — every table type must include this field or TypeScript infers insert/select as `never`.
- **`contractor-response` must be deployed with `--no-verify-jwt`** — see Edge Functions section above.
- **New tables not in generated types** — use `(supabase as any).from('table_name')` with a local interface until types are regenerated (e.g. `trade_categories`).
- **Supabase migration history empty after SQL-editor-only workflow** — use `supabase migration repair` to mark pre-existing migrations as applied before running `db push` for the first time.
