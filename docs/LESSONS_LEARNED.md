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

## Phase 2 — Compliance & Works (not yet started)

---
