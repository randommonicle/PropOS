# PropOS

Full-stack property management operating system for RICS-regulated managing agents, SME agents, and RMC/RTM self-managed blocks.

**Status:** Phase 2 complete and verified ✓ — Phase 3 (Financial) next

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

**16 migrations** covering all 26 tables. Run via:

```cmd
set DB_URL=postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres
node supabase/run_migrations.mjs
```

Run each `set` on a **separate line** in cmd.exe (see [Known gotchas](#known-gotchas)).

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

**Current coverage (Phases 1 & 2):**

| Spec | Tests |
|------|-------|
| auth.setup | Login flow, JWT hook, dashboard redirect |
| dashboard | Firm name, stat cards, no 401s, sidebar nav |
| properties | List loads, seed data, create property round-trip |
| documents | Page load, upload button, type filter |
| compliance | Page load, RAG summary, tabs, create round-trip |
| contractors | Page load, sidebar nav, create round-trip |
| works | Page load, tabs, works order create, S20 create |

Both runners are active. Run both before declaring any change complete.

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
| 2 — Compliance & Works | ✅ Complete | Compliance tracker (RAG), insurance tracker, contractor register, works orders, dispatch engine (token), Section 20 state machine |
| 3 — Financial | Planned | Service charge demands, budgets, bank reconciliation |
| 4 — Portals | Planned | Leaseholder portal, maintenance requests |
| 5 — BSA Module | Planned | Golden Thread, mandatory occurrences, HRB register |
| 6 — Reporting | Planned | PDF reports, AGM packs, Section 20B schedules |
| 7 — AI Layer | Planned | Document AI, works triage, compliance alerts |
| 8 — Self-host | Planned | Docker + Cloudflare Tunnel deployment mode |

---

## Known gotchas

- **cmd.exe `&&` gives env vars trailing spaces:** `set VAR=value && next` sets VAR to `value ` (with space). Always use separate lines.
- **JWT hook requires manual Dashboard registration** — cannot be automated via SQL. Must be enabled in Auth → Hooks UI.
- **Supabase CLI type gen requires Docker** — types in `app/src/types/database.ts` are hand-written. Run migrations first, then update types manually when schema changes.
- **`Relationships: []` required in supabase-js v2.49+** — every table type must include this field or TypeScript infers insert/select as `never`.
