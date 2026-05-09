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

## 2026-05-09 — MoneyInput contract: integer-pence canonical value

**Context:** Phase 3 introduces money capture across many forms (bank accounts, demands, transactions, budget line items, S20 quotes, dispensation costs). Per Section 6.4 of the spec, all financial amounts are stored and computed as integer pence in memory — never floats. A single shared input component is needed so that contract is enforced at the UI boundary, not on a form-by-form basis.

**Decision:** All money capture goes through `app/src/components/shared/MoneyInput.tsx`. Contract:
- `value: number | null` — integer pence. `null` represents an empty / unspecified amount.
- `onChange(pence: number | null)` — fires on every keystroke that produces a parseable value; invalid mid-typing strokes emit `null`.
- On blur, the visible draft is reformatted to canonical `1,234.56` (en-GB locale, 2dp).
- The `£` prefix is rendered visually outside the `<input>` so it never enters the value.
- `allowNegative` defaults to `false`. Bank balances and dual-auth thresholds are non-negative; later `transactions` flows will pass `allowNegative` for refunds.
- `disabled` triggers the read-only render path used for trigger-maintained values like `bank_accounts.current_balance` (spec §5.6).
- Parsing helper `parseMoneyInput()` and display helper `formatPenceForInput()` live in `lib/money.ts` so they remain testable independently of the React tree.

**Rationale:** Centralising integer-pence conversion at the component boundary eliminates the dominant class of financial bug — locale-formatted strings being parsed inconsistently and floating-point arithmetic creeping into intermediate values. Every form that captures money MUST use `MoneyInput`; raw `<Input type="number">` for currency is a code-review block.

---

## 2026-05-09 — Bank account deletion policy: RICS Client Money + TPI audit retention

**Context:** `bank_accounts` represents accounts that hold (or have held) leaseholder client money. Hard-deleting a bank account that ever held client money breaches RICS Client Money Rules (Rule 4.7, audit-trail evidence required for inspection) and the TPI Code of Practice §5 (financial record retention). HMRC also imposes a 6-year retention floor on financial records.

**Decision:** Hard-delete is permitted ONLY when ALL of the following hold:
1. Foreign-key check passes (no transactions, payment_authorisations, demands, or statement imports reference the account) — enforced by Postgres FK + 23503 surfacing in the UI.
2. `last_reconciled_at IS NULL` — the account has never been reconciled.
3. `closed_date IS NULL` — the account has not been formally closed.

Any other state forces the PM down the **Mark as Closed** path: edit the account → untick `Active`. The system auto-stamps `closed_date = today` if not supplied. Closed accounts retain their full row history. The deletion-attempt error message names RICS Rule 4.7 and TPI §5 explicitly so the PM understands the constraint is regulatory, not technical.

**Rationale:** Soft-delete-by-default for any record tied to client money is the only path that survives both an FCA referral (via the firm's regulator) and a RICS Client Money inspection. The FK guard alone is necessary but not sufficient — a never-reconciled account with zero transactions is the only safe hard-delete window.

---

## 2026-05-09 — Open Banking integration: forward-looking schema and consent design

**Context:** The product brief requires PropOS to pull bank-account data from client accounts in real time so PMs see live balances and transactions without manual statement upload. In the UK this is FCA-regulated as Account Information Services (AIS) under PSD2 / FCA PERG 15; PropOS would either operate as an FCA-authorised AISP or (more likely) integrate with a regulated provider such as TrueLayer, Tink, or GoCardless Bank Account Data. RICS Client Money Rules and the TPI Code both interact with this — pulled data is accepted as a primary record only when the provider's audit chain is preserved.

**Decision:** Open Banking is **out of scope for Phase 3 commit 1b**. No schema changes in this commit. When the integration lands (Phase 6 candidate), the `bank_accounts` table will gain:
- `ob_provider TEXT` — registered AISP we routed through (e.g. `truelayer`, `tink`, `gocardless_bad`).
- `ob_external_account_id TEXT` — provider's stable identifier.
- `ob_consent_id UUID` — FK into a new `open_banking_consents` table managing the 90-day FCA consent lifecycle.
- `last_ob_sync_at TIMESTAMPTZ`, `ob_sync_status TEXT` — observability for the polling worker.

A separate `open_banking_consents` table will track consent grant / renewal / revocation events with full audit trail (who, when, scope, expiry). The bank statement import pipeline (already specified in Phase 3 sub-deliverable) is adapted so its `bank_statement_imports` rows can be sourced from either CSV/OFX upload OR an Open Banking sync — the matching engine downstream does not care.

UX commitments for the Phase 6 work, recorded here so 1b doesn't accidentally pre-judge them:
- Negative `current_balance` values must render with an amber badge plus a "Negative — investigate" tooltip on the BankAccountsTab list (a real-world but rare edge case; cf. handover note).
- Manual `current_balance` override is never allowed in the UI — the trigger and / or the OB sync owns the value.
- The PM-facing UI must surface an immutable provenance label on each transaction: "Source: Statement upload (CSV) / Open Banking (TrueLayer) / Manual entry" so RICS inspections can distinguish primary records from manually keyed ones.

**Rationale:** Recording the constraint set now prevents 1b from baking in patterns (manual balance entry, hand-edited transaction history, unbounded delete) that would have to be ripped out when the integration lands. The schema fields are not added in this commit because (a) we have no provider chosen and the field set will firm up at integration time, and (b) Section 6.4 of the spec forbids speculative migrations.

---

## 2026-05-09 — PropertyDetailPage tabbed layout with `?tab=` URL sync

**Context:** Phase 3 introduces per-property bank accounts. The existing PropertyDetailPage was a single scrolling page (property info → units → leaseholders); adding bank accounts as a fourth stacked section would push every later addition (compliance items per property, S20 consultations per property, transactions per property) further down the page.
**Decision:** Refactor PropertyDetailPage into a Radix-Tabs interface (Overview / Units / Leaseholders to start, Bank Accounts added in commit 1b). Active tab is mirrored into the `?tab=` search param so refresh and direct linking preserve location. Default tab (`overview`) is omitted from the URL (`/properties/:id` rather than `/properties/:id?tab=overview`) to keep the canonical URL clean.
**Rationale:** Tabs scale better than a single scroll for a per-property dashboard; URL sync is required so deep links from emails / reports / activity feeds can point at a specific property tab. A new `Tabs` primitive wrapper was added to `/components/ui` per the abstraction-layer rule (DECISIONS 2026-05-07). Future per-property tabs (Bank Accounts, Compliance, Section 20) extend `TAB_VALUES` and add a `<TabsContent>` block — no other surgery required.

---

## 2026-05-09 — Service charge accounts: finalisation lock, status state machine, delete policy

**Context:** Phase 3 commit 1c introduces `ServiceChargeAccountsTab` as the fifth per-property tab. The `service_charge_accounts` schema (00005:38-53) defines a `status` field with values `draft | active | reconciling | finalised` and audit columns `finalised_at` / `finalised_by`. The spec does not separately enumerate what is editable at each status, who stamps the audit columns, or when hard-delete is permitted. Those rules are needed before reconciliation, demands, and budget line items consume this account row in later commits.

**Decision:**

1. **Status state machine.** `draft → active → reconciling → finalised`. The Edit form exposes all four values in the `Status` select. The only hard-enforced transition rule in 1c is **no reversion from `finalised`**: once an account's stored `status` is `finalised`, the form opens with year start, year end, budget total, and status all disabled, and only the `notes` field is editable. The form surfaces a regulatory note explaining the lock.
2. **Audit-column stamping.** `finalised_at` is set to `NOW()` and `finalised_by` is set to the current authenticated user id at the moment the form transitions an account into `finalised` for the first time. On subsequent edits of an already-finalised account (notes only), the existing stamps are preserved unchanged. Server-side enforcement (rejecting a write that violates these rules from a non-UI client) is deferred to the financial-rules Edge Function in a later commit; for 1c the client guard plus RLS (admin / property manager only — 00012:114-116) is sufficient.
3. **Delete policy.** Hard-delete is permitted ONLY when both:
   - `status = 'draft'` (UI guard before the network call), and
   - no FK references exist from `budget_line_items` or `demands` (Postgres FK + 23503 surfacing in the UI).

   Any other status forces the PM to leave the row in place. The deletion-attempt error message names RICS Client Money Rule 4.7 and TPI Code §5 explicitly so the PM understands the constraint is regulatory, not technical. This mirrors the bank-accounts deletion policy from 1b.
4. **Out of scope for 1c (deliberate).** The per-property "one active SCA per accounting year" constraint is not enforced. It will land alongside the reconciliation engine when the meaning of "active" is precise enough to pin down a uniqueness constraint without false positives across overlapping mid-year handovers.

**Rationale:** The `finalised` status is the closing record of a service-charge year — once issued to leaseholders and reconciled, its dates and budget total are evidence in any future LTA s.27A challenge. Reverting via the UI would compromise that evidential value. Stamping the audit columns at the UI boundary keeps the data path simple for 1c; the Edge Function adds defence-in-depth for non-UI writers (imports, future API consumers) when the financial-rules layer is built. The draft-only delete gate matches the bank-accounts policy and keeps the audit-retention story consistent across financial entities.

---

## 2026-05-09 — Demands: LTA s.21B client guard, status state machine, paid lock, delete policy

**Context:** Phase 3 commit 1d introduces `DemandsTab` as the sixth per-property tab. The `demands` schema (00005:78-104) carries two pieces of statutory metadata that the UI must respect: `s21b_attached` (LTA 1985 s.21B summary, required before a demand becomes legally enforceable) and `issued_date` (the LTA s.20B 18-month rule clock starts here). The schema comment notes that `s21b_attached MUST be true before status is 'issued'` and that the rule is enforced by the `financial-rules` Edge Function. That Edge Function does not yet exist; the UI guard in 1d is the only enforcement, supplemented by the admin/PM-only RLS policy at 00012:139+.

**Decision:**

1. **Status state machine.** `draft → issued → (part_paid → paid | overdue | disputed | withdrawn)`. The Edit form exposes all seven status values. The hard rule is **paid is terminal**: once stored status is `paid`, the form locks unit, leaseholder, demand type, amount, all dates, status, and the s21b_attached checkbox; only `notes` is editable. Withdrawn from `draft` is permitted without s.21B because no demand was issued; withdrawing an already-issued demand keeps its existing `s21b_attached=true`.
2. **LTA 1985 s.21B client guard.** The form rejects the save if EITHER condition holds AND `s21b_attached` is false:
   - `issued_date` is set, or
   - `status` ∈ {`issued`, `part_paid`, `paid`, `overdue`, `disputed`}.

   The rejection message names LTA 1985 s.21B explicitly and tells the PM to either tick the checkbox or revert status to `draft` / `withdrawn`. The mirror server-side enforcement in the financial-rules Edge Function is deferred and will provide defence-in-depth for non-UI writers (imports, future API consumers).
3. **Auto-stamp issued_date on transition draft → issued.** When the form transitions `status` from anything other than `issued` to `issued` and `issued_date` is empty, the save sets `issued_date = today` (en-CA `YYYY-MM-DD` slice). The PM may override before save. Re-issuing an already-issued demand preserves the original date.
4. **Auto-stamp leaseholder picker filtering.** The leaseholder select is disabled until a unit is chosen, and is filtered to leaseholders attached to the selected unit AND `is_current = true`. This prevents a PM from accidentally raising a demand against an ended tenant. If the unit is changed after a leaseholder has been picked, the leaseholder field clears.
5. **Delete policy.** Hard-delete is permitted ONLY when both:
   - `status = 'draft'` (UI guard before the network call), and
   - no `transactions` row references the demand (Postgres FK + 23503 surfacing in the UI).

   The rejection message names RICS Client Money Rule 4.7, TPI Code §5, and LTA s.20B's audit chain. This mirrors the bank-accounts (1b) and SCA (1c) deletion policies.
6. **Out of scope for 1d (deliberate).**
   - **PDF demand generation** — `document_id` stays `null` and is not surfaced as an editable field. The PDF generation worker is a later Phase 3 commit.
   - **LTA s.20B 18-month banding warning** — when an `issued_date` is set for expenditure incurred more than 18 months earlier, the demand becomes legally unrecoverable. Surfacing this as a UI warning requires demand-history context across the property and is deferred until the ledger / reconciliation work has loaded that history. Recorded here so a future commit doesn't accidentally treat the absence as approval.
   - **Bulk demand generation per accounting period** — separate ledger commit; not built in 1d.
   - **Portal visibility toggle** — Phase 5 (leaseholder portal) work.

**Rationale:** s.21B is the bright-line statutory requirement that turns a draft demand into an enforceable one. Letting a PM mark a demand as `issued` without ticking the s.21B box is the kind of compliance failure that surfaces only at FTT (First-tier Tribunal) when the demand is challenged — by which point the demand cycle has already shipped to leaseholders. A client-side reject at save is the cheapest, most legible place to catch it. The paid lock matches the SCA finalised lock so the audit-retention story is consistent across financial entities. The leaseholder picker filtering closes a small but real failure mode where a PM picks a unit and then accidentally selects a leaseholder from a different unit (the `unit_id` and `leaseholder_id` columns are independent NOT NULL FKs in the schema; nothing at the DB layer enforces consistency between them).

---

## 2026-05-09 — Bank account closure role gate (interim) + Critical-Action Authorisations (1f scope)

**Context:** Commit 1b shipped `BankAccountsTab` with no role-based restriction on closure (untick `Active` → auto-stamp `closed_date`) or hard-delete. Any user with `property_manager` could close a client-money account. RICS Client Money Rules and the TPI Code expect firm-level segregation of duties — closure of a client-money account is an accounts-department / financial-controller action, not a day-to-day PM action. The bank itself usually requires two authorised signatories to close such an account. PropOS's current UX did not reflect this.

**Decision (interim, this commit):**

1. **Closure and hard-delete restricted to `admin` or `director` roles.** A new helper `isFinanceRole(role)` and constant `FINANCE_ROLES = ['admin', 'director']` in `app/src/lib/constants.ts` is the gate. `BankAccountsTab` reads the role via `useAuthStore(s => s.firmContext?.role)` and disables: (a) the per-row Delete button, (b) the `Active` checkbox in the edit form, (c) the `closed_date` field in the edit form. Each gated control surfaces a tooltip explaining the restriction. The form itself shows a `Lock` banner when a non-finance user opens an existing account. `handleDelete` re-checks the role server-of-the-UI as defence in depth in case the disabled state is bypassed (DevTools, future code paths). Final enforcement will move server-side in commit 1f.
2. **Existing `admin`/`director` roles are reused; no new `finance` role is introduced mid-PoC.** Adding a `finance` (or `accounts_clerk` / `financial_controller`) role would require a migration, JWT-claim rework, and seed-data updates. The architectural call is to defer the role-taxonomy expansion to a phase boundary; for the interim, `admin` and `director` are the finance-empowered roles.
3. **Test coverage gap acknowledged.** The smoke harness only authenticates as `admin`. The PM-side gate has no test coverage in this commit. A PM seed user + a "PM cannot close / delete" smoke is a 1f deliverable, recorded here so it doesn't get lost. Existing 8 bank-account tests run as admin and continue to pass unchanged.

**Decision (planned for commit 1f — Critical-Action Authorisations):**

The simple role gate above is a stopgap. Commit 1f's scope is widened from "Payment Authorisations" to **Critical-Action Authorisations**, covering ALL of:

- **Payments above `bank_accounts.dual_auth_threshold`** on accounts with `requires_dual_auth=true` (originally-planned scope).
- **Bank account closure** (`is_active: true → false`) — replacing the interim role gate with a proper second-signer flow. Closure becomes a request that an admin / director can initiate but that requires a second authorised signer to execute.
- **RICS-designation toggle** (`rics_designated: true → false` on an account that ever held client money) — high-stakes flag change that should not be a single-user action.
- **Hard-delete on never-reconciled accounts** — already FK-blocked once transactions exist; the dual-auth path becomes the override-of-last-resort if the account also has `closed_date IS NULL` and `last_reconciled_at IS NULL` (the existing 1b conditions).

The infrastructure (`payment_authorisations` table at 00005:170-185, RLS at 00012:126-128) is already deployed; commit 1f adds the request/authorise/reject UI and extends the table to cover non-payment actions if the schema needs `action_type` and `subject_id` columns (TBD at 1f planning).

**Rationale:** Segregation of duties is the bright-line control for client-money handling. RICS inspections check that the firm's procedures match what the system enforces. A firm that has "two-signer required" in its policy but a single-PM-clicks-untick-Active in its software has a control failure. The interim role gate closes the most acute hole today; 1f delivers the proper dual-auth flow that mirrors how the bank itself handles closure. Reusing `admin`/`director` rather than introducing a `finance` role keeps the role taxonomy stable for the PoC; a clean role expansion (with `finance` / `accounts_clerk` / `financial_controller`) can land at a phase boundary when the seed data, JWT hook, and RLS policies can all be updated together.

---

## 2026-05-09 — Property data portability — exit-to-new-agent requirement

**Context:** Property management contracts are terminable. When a managing agent loses (or hands over) a property — by client choice, by RMC re-tender, or by liquidation — the regulatory expectation is that all data for that property transfers cleanly to the incoming agent. PropOS must support this without per-customer engineering work.

**Decision (recorded as a forward-looking constraint; no code in this commit):**

PropOS will support a one-button **"Export property"** action that produces a portable archive of every record scoped to a single `property_id`. The archive must include, at minimum:

- `properties` row + `units`, `leaseholders` (current AND historical), `bank_accounts`, `service_charge_accounts`, `budget_line_items`, `demands`, `transactions`, `payment_authorisations`, `invoices`, `bank_statement_imports`.
- Compliance + works artefacts: `compliance_items`, `insurance_records`, `works_orders`, `section20_consultations`, `dispensation_applications`, related `contractor_quotations`.
- Contractor links: contractors that have ever done work for the property (denormalised so the receiving agent has the contact details, not just an FK to a row they don't have).
- Documents: every file in storage referenced by `documents.id` for that property, included as raw files in a `documents/` folder of the archive.
- Audit: all relevant `audit_log` entries (when that table exists in Phase 5+).

Format: a single zip containing one JSON file per table (one row per line, JSONL preferred for large transactional tables) plus the `documents/` folder. A top-level `manifest.json` records the schema version, export timestamp, exporting firm, and the receiving agent's identifier (if known). The format spec lives in `docs/EXPORT_FORMAT.md` (to be written when the export is built).

Out of scope until **at least Phase 6** (Reporting), possibly later. Recorded here so schema decisions in the interim do not accidentally break per-property partitioning. Specifically:

- **Every per-property record must carry `property_id` directly** or be reachable via a single FK hop from a row that does (e.g. `transactions.property_id` is denormalised even though `transactions.bank_account_id → bank_accounts.property_id` would also work — the denormalisation is intentional and load-bearing for portability).
- **Document storage paths must be reversible to property scope** — currently `documents.path` includes the property id; do not introduce paths that depend on global state.
- **Avoid global lookup tables that mix property-scoped and firm-scoped rows** without a discriminator. The `trade_categories` table (00021) is firm-scoped; that's fine. But avoid (e.g.) a "tags" table that would need to be partially copied.
- **Soft-delete must preserve the `property_id` column** — historical-leaseholder rows are exportable; tombstoned rows that have lost their property linkage are not.

**Rationale:** Data portability is both a contractual expectation and an emerging regulatory norm (UK GDPR Article 20 covers the leaseholder personal-data dimension; the firm-to-firm handover dimension is contractual but increasingly tested in tender processes). Building the export later is fine; building it later when the schema accidentally crossed a property partition boundary is expensive. Recording the constraint in DECISIONS turns it into a checklist item for every future schema change.

---

## 2026-05-07 — pgAudit enablement approach

**Context:** Section 4 requires pgAudit to be enabled before any data migration. The Supabase hosted project does not allow direct superuser SQL for extension creation on the free tier in some cases.
**Decision:** pgAudit is enabled via a migration that calls `CREATE EXTENSION IF NOT EXISTS pgaudit;`. On Supabase Pro/hosted, this runs as the `postgres` role which has extension creation rights. If the extension is already enabled by the platform, the `IF NOT EXISTS` clause prevents an error.
**Rationale:** Supabase Pro grants extension creation to the `postgres` role. The migration is idempotent.

---
