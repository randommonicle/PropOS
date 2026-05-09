# PropOS — Lessons Learned

Updated at the end of each build phase per Section 6.2.

---

## Phase 1 — Foundation (completed 2026-05-07)

### What worked well

- **Writing migrations as numbered SQL files** with an idempotent runner (run_migrations.mjs) was faster than using the Supabase CLI `db push`, which requires Docker for local type generation and a personal access token for remote linking. The pg-based runner worked directly against the remote DB with just the database password.
- **Structuring the TypeScript types manually** from the migration SQL was more reliable than relying on `supabase gen types typescript`, which requires Docker. Future phases: set up Docker so the gen command can be used for incremental schema changes.
- **Writing RLS as a single migration** (00012) made it easy to reason about the entire security model in one place. The helper functions (`auth_firm_id()`, `is_pm_or_admin()`) kept individual policies concise.
- **Monorepo without workspace tooling** worked cleanly for Phase 1. The single `package.json` in `/app` is simple and friction-free for a solo PoC build.

### What didn't work / friction points

- **`pgAudit` `ALTER SYSTEM` in a transaction**: The spec says to enable pgAudit before migrations. On Supabase hosted, `ALTER SYSTEM` cannot run inside a transaction block, and the pgAudit logging configuration must be done via the Supabase dashboard Extensions panel, not SQL. The extension itself (`CREATE EXTENSION IF NOT EXISTS pgaudit`) runs fine. Log this in the client handoff docs.
- **Supabase CLI type generation requires Docker**: Without Docker Desktop installed, `supabase gen types typescript` fails. Worked around by writing types manually. For Phase 2, either install Docker or use a pg-based type generator script.
- **JWT claims hook requires manual dashboard registration**: The `custom_access_token_hook` function is deployed via migration, but it must also be enabled in the Supabase Dashboard > Authentication > Hooks UI. This is a manual step that cannot be automated via SQL. Document this prominently in the setup guide.
- **`supabase-js` v2.49+ requires `Relationships: []` on all table types**: Without this field, TypeScript infers insert/select types as `never`. This was fixed by a PowerShell regex transformation of database.ts. Future improvement: script the type generation from the schema to include this field automatically.

### What would be done differently

- Start with Docker installed so Supabase CLI tooling works end-to-end from day one.
- Write a type generation script (using `pg` + introspection queries) that outputs the correct TypeScript with `Relationships` fields, instead of hand-writing database.ts.

### Post-Phase 1 setup checklist (must be done manually)

1. **Enable the JWT claims hook**: Supabase Dashboard > Authentication > Hooks > Custom Access Token Hook > set to `public.custom_access_token_hook`
2. **Create first admin user**: Supabase Dashboard > Authentication > Users > Invite user. Then run `ADMIN_USER_ID=<uuid> ADMIN_EMAIL=<email> node supabase/seed/demo_seed.mjs`
3. **Verify storage buckets**: Dashboard > Storage — confirm `documents`, `logos`, `inspection-reports` exist with correct public/private settings

---

### Post-phase setup issues resolved (2026-05-07)

- **JWT `role` claim conflict with PostgREST:** The hook originally set `{role}` to the PropOS role name (e.g. 'admin'). PostgREST uses the `role` JWT claim to pick the Postgres database role — setting it to 'admin' (a non-existent Postgres role) caused every REST API call to return HTTP 401. Fixed by using `{user_role}` as the claim name and updating `auth_user_role()` accordingly. Rule: never overwrite `role` in a Supabase JWT hook.
- **Hook needs SECURITY DEFINER:** Without it, the hook runs as `supabase_auth_admin` and is blocked by RLS on `public.users` (chicken-and-egg: JWT needed to pass RLS, but JWT is what the hook is building). Fixed by adding `SECURITY DEFINER` + `SET search_path = public` to the function.
- **`supabase_auth_admin` needs table-level grants:** `GRANT EXECUTE ON FUNCTION` alone is not enough. Also needed: `GRANT USAGE ON SCHEMA public` and `GRANT SELECT ON public.users`.
- **cmd.exe `&&` chaining adds trailing spaces to env vars:** `set DB_URL=value && next` sets DB_URL to `value ` (with trailing space). Always run `set` on separate lines in cmd.exe. PowerShell `$env:` syntax does not have this problem.

---

## Phase 2 — Compliance & Works (completed 2026-05-09)

### What worked well

- **Edge Function redirect pattern** — When the Supabase gateway overrides `Content-Type` headers (making it impossible to return rendered HTML directly from an Edge Function), the correct approach is for the function to return a `302 redirect` to a React route. The React app is served by Vercel with correct headers and the user sees a proper page. This pattern also cleanly separates concerns: the function does DB work, the React app handles presentation.
- **`scripts/deploy-functions.bat`** — Baking the `--no-verify-jwt` flag into a deploy script eliminates the recurring problem of JWT verification resetting on redeploy. Any critical deploy flags belong in version-controlled scripts, not in documentation.
- **`supabase migration repair`** — When a project's migrations were previously applied via the SQL editor (not the CLI), the `schema_migrations` history table is empty. `supabase migration repair <versions> --status applied` marks them as applied without re-running DDL. Safe and precise.
- **`matchMedia` for OS-adaptive theming** — Using `window.matchMedia('(prefers-color-scheme: dark)')` with an event listener gives live dark/light switching without any CSS framework dependency, ideal for standalone pages (like the contractor response page) that are independent of the app's theme system.
- **Pill tag toggle for multi-select** — Replacing a freeform comma-separated text input with pill toggles from a database-driven list significantly improves data quality (no slug normalisation needed, no typos, consistent display names) while being just as fast to use.
- **`afterAll` cleanup in Playwright specs** — Adding Supabase JS client cleanup in `afterAll` hooks keeps the database clean between sessions without needing a manual reset. FK-safe deletion order (child before parent) must be explicitly managed.

### What didn't work / friction points

- **Supabase gateway Content-Type override** — The gateway adds `x-content-type-options: nosniff` and overrides custom `Content-Type` headers set in Edge Function responses. Attempts to return `text/html` directly from the function resulted in the raw source code being shown to the user in the browser. Only the redirect approach works reliably.
- **`config.toml verify_jwt = false` not picked up by CLI** — Despite being the documented approach, the Supabase CLI ignores this setting during deploy and resets JWT verification to on. The Dashboard toggle has the same problem. `--no-verify-jwt` on the deploy command is the only method that persists. This cost significant debugging time.
- **Resend free tier — 1 domain limit** — The free tier only allows one sender domain. Since `bengraham.uk` was already the personal portfolio domain, a dedicated domain (`proposdigital.uk`) was required for PropOS. This triggered a Resend Pro upgrade. Budget accordingly for any project sending from a custom domain.
- **`trade_categories` table not in generated types** — Since the table was added via a manual migration after the initial type generation, `supabase.from('trade_categories')` returned `never` in TypeScript. Workaround: `(supabase as any).from('trade_categories')` with a local interface. The permanent fix is to regenerate types (requires Docker) or maintain the hand-written `database.ts` file.
- **FK-safe deletion order in Playwright cleanup** — Straggler leaseholders from old test runs (non-smoke names but attached to smoke units) caused FK constraint errors when deleting units. Required a two-step approach: first delete leaseholders by unit_id (found via unit_ref pattern), then delete units.

### What would be done differently

- Register the email sending domain before building the dispatch feature, not after. Resend domain verification (DNS propagation + DKIM) takes time and blocks end-to-end testing of the email flow.
- Set up Docker from the start so `supabase gen types typescript` works. Hand-maintaining `database.ts` accumulates drift risk, especially when adding new tables like `trade_categories`.
- Write a `scripts/deploy-functions.bat` (or Makefile target) from the very first Edge Function deployment — never rely on remembering flags.

---

## Phase 3 — Financial (in progress; 1a–1d complete 2026-05-09)

### What worked well

- **State-the-plan-first gate.** On every non-trivial commit (1c, 1d), the operator asked for the file list + test list + UX rules before any code was written. This caught two scope ambiguities cheaply (whether one-active-SCA-per-year was in scope; what the s.21B guard's exact trigger conditions should be) and aligned the test list with the implementation in advance. Cost: one extra round-trip per commit. Benefit: zero rework so far.
- **Audit-refactor pattern as a pre-push gate.** Three review agents (code-reuse, code-quality, efficiency) launched in parallel via the `simplify` skill caught 8 real issues across the new tabs and specs — including one Rules-of-Hooks bug (`useMemo` after a loading early-return) that TypeScript's `tsc -b --noEmit` did not flag and that only surfaced as a blank page in the browser console. Worth running before every push that touches non-trivial code.
- **Statutory citations in error messages.** Surfacing "LTA 1985 s.21B", "RICS Client Money Rule 4.7", "TPI Code §5", and "LTA s.20B" verbatim in user-facing rejection messages turned out to also be the cleanest way to write the smoke assertions (regex against the rule number). Two-for-one: the compliance traceability and the test anchoring share the same string.
- **Worktree-local Playwright config (`playwright.worktree.config.ts`).** A 16-line shim that overrides `baseURL` to a non-5173 port and disables `webServer` reuse. Solves the worktree-vs-main-repo dev-server collision permanently; reusable for every future worktree commit.
- **Self-seeding smoke specs.** The dev seed has properties + units but no leaseholders. Rather than introduce a global fixture, the demands smoke seeds its own current leaseholder via `notes='Smoke DEM%'` and unwinds in `afterAll` (FK-safe order: transactions → demands → leaseholders). Self-contained, no inter-spec ordering dependencies.

### What didn't work / friction points

- **`tsc -b --noEmit` does not catch Rules-of-Hooks violations.** A `useMemo` placed after a conditional early return passed typecheck cleanly but rendered as a blank page in the browser. Only a Playwright run with `page.on('console')` capture surfaced the React warning. Lesson: typecheck is necessary but not sufficient — every UI change still needs a real browser smoke before pushing.
- **`TaskStop` on `npm run dev` does not kill the underlying Vite child.** Stale Vite processes accumulated on 5174/5175/5176 across multiple test runs in the same worktree. Detection via `Get-NetTCPConnection -LocalPort N -State Listen`; cleanup via `Stop-Process -Id <pid> -Force`. Pattern to keep in scratch.
- **`reuseExistingServer: true` in Playwright is dangerous across worktrees.** The base config silently reused the main repo's 5173 dev server, meaning the first commit-1c smoke run was actually testing main-repo code. The failures looked like "tab missing" — only port-ownership investigation surfaced the real cause. The `playwright.worktree.config.ts` shim is now mandatory for worktree work.
- **`DEMAND_TYPE_OPTIONS` label refactor changed `Service charge` → `Service Charge`.** Switching from hardcoded labels to `slugToTitle(value)` title-cases every word, which broke a smoke test that did `selectOption('Service charge')`. Caught by the smoke run, not typecheck. Lesson: any label change in a `<select>` needs grep across the smoke specs.

### What would be done differently

- Capture browser-console errors during smoke runs (e.g. via a Playwright reporter or a global `page.on('pageerror')`) so Rules-of-Hooks and similar runtime warnings break the build instead of being silent. Add to test infrastructure backlog.
- Establish the worktree-config + 5174 pattern from commit 1 of the next phase, not after a debugging session.

---
