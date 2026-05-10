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

## 2026-05-10 — Transactions: tab placement, sign convention, dual-auth gate, demand auto-status, locks, delete policy

**Context:** Phase 3 commit 1e introduces `TransactionsTab` as the seventh per-property tab, completing the third of four core financial entities (bank accounts, service charge accounts, demands, transactions). The `transactions` schema (00005:118-138) carries a single signed `amount` column (positive = in, negative = out), an FK to `bank_accounts` (NOT NULL), an optional FK to `demands` for receipt linking, and an optional `statement_import_id` for rows sourced from a bank statement upload. The `sync_bank_account_balance` trigger (00005:144-165) maintains `bank_accounts.current_balance` from `SUM(transactions.amount)` on every INSERT / UPDATE / DELETE — the UI never writes the balance directly.

**Decision:**

1. **Tab placement: per-property, with bank-account filter.** Transactions is the seventh per-property tab on `PropertyDetailPage`. The list shows all transactions for the property and is filterable by bank account via a dropdown. Per-bank-account drill-down (e.g. clicking a bank account row to see only its transactions) is a future enhancement; for now the property-level view matches what RICS / TPI inspectors examine. Justification: transactions are conceptually "things that happened to this property's money," and the property is the natural audit unit.
2. **Sign convention.** The DB stores signed amounts. The PM enters absolute amounts in the form and the sign is derived from `transaction_type`:
   - `receipt` → saved as `+amount`.
   - `payment` → saved as `-amount` (validated `amount > 0` before flip).
   - `journal` → MoneyInput with `allowNegative=true`; the PM picks the sign explicitly (validated `amount !== 0`).
   - `inter_account_transfer` is in the schema enum but **not surfaced in the type selector** for 1e. Paired-row creation (one debit + one credit on different accounts, atomically linked) is a deferred commit.
3. **Dual-auth gate (interim block; full flow in 1f).** When a `payment` is being created against an account with `requires_dual_auth=true` AND amount exceeds `dual_auth_threshold`, the form **rejects the save** with a message: "This payment requires dual authorisation (threshold £X.XX). Use the Payment Authorisations workflow (Phase 3 commit 1f, deferred). In the interim, payments above threshold cannot be created from this UI." No transaction is inserted. This is consistent with the closure role gate from 1d.1 — block at the UI now, full second-signer infrastructure ships in 1f's Critical-Action Authorisations work.
4. **Demand linking auto-status.** Setting `demand_id` on a `receipt` transaction triggers a follow-up update on the linked demand: the form sums all receipts against that demand and transitions the demand to:
   - `paid` if `SUM(receipts) ≥ demand.amount`.
   - `part_paid` otherwise (whenever there's at least one receipt).
   The transition is forward-only — never reverts a paid demand back. Deletion of a receipt does NOT auto-revert the demand status; the PM updates manually if needed. The linkable demand picker is filtered to demands on the same property with status in `{issued, part_paid, overdue}` (the open statuses) so already-paid or withdrawn demands cannot be re-linked. Full payment-allocation engine (multiple receipts → one demand with explicit allocation, refunds, partial reversals) is deferred.
5. **Reconciled lock.** When `reconciled=true`, the form opens with all fields disabled and surfaces a regulatory note (RICS Rule 4.7 / TPI §5). The per-row Delete button is also disabled with a tooltip. The only path to undo a reconciliation is the bank reconciliation workflow — which is deferred to its own commit. Defence-in-depth role re-check in `handleDelete` matches the pattern from 1d.1's bank-account closure gate.
6. **Statement-import lock.** When `statement_import_id IS NOT NULL`, the row is similarly locked from edit AND delete. Statement-imported transactions are part of an upstream audit chain (CSV / OFX / Open Banking when AIS lands) and are immutable from the UI. Adjustments must be made via a corresponding journal transaction so the upstream chain is preserved.
7. **Delete policy.** Hard-delete permitted ONLY when `reconciled=false` AND `statement_import_id IS NULL`. The `sync_bank_account_balance` trigger automatically adjusts `bank_accounts.current_balance`. Rejection messages name RICS Rule 4.7 / TPI §5 for the reconciled case and the upstream audit chain for the import case.
8. **Out of scope for 1e (deliberate).**
   - **Bank reconciliation workflow** — the UI to mark transactions as reconciled, match against statement-import rows, and produce reconciliation reports. Separate commit.
   - **Statement import pipeline** — CSV / OFX upload + matching engine. Separate commit. The `bank_statement_imports` table at 00005:232 is already in the schema; the UI is not yet built.
   - **Inter-account transfer paired rows** — see (2). Separate commit.
   - **Multi-demand allocation, refunds, partial reversals** — see (4). Deferred to the payment-allocation engine.
   - **Contractor invoice matching** — `transactions.invoice_id` FK is in the schema but not surfaced in the form. Lands when invoices CRUD ships.
   - **Server-side enforcement of dual-auth + reconciled-lock + statement-import-lock** — UI guards only in 1e. Full enforcement in the financial-rules Edge Function (already noted as deferred in 1c and 1d's DECISIONS entries).

**Rationale:** The signed-amount + trigger pattern keeps the bank balance correct without the UI ever doing arithmetic — meaning the test "did the balance update?" is a smoke assertion against the database, not against the UI's display, and that's what RICS would verify in a real inspection. The dual-auth interim block is the same pattern as 1d.1: when full enforcement is one commit away, blocking the action at the UI is safer than letting it slip and adding a retroactive fix. The demand auto-status closes the most common UX gap — a PM marking a receipt without then having to also navigate to the demand to mark it paid — while leaving the multi-allocation complexity for the payment-allocation engine that is the right home for it. The reconciled and statement-import locks mirror the SCA finalised lock and the demand paid lock, so the audit-retention story is consistent across all four financial entities.

---

## 2026-05-10 — Payment Authorisations: dual-auth request flow with self-auth guard

**Context:** Phase 3 commit 1f introduces `PaymentAuthorisationsTab` as the eighth per-property tab and replaces 1e's interim dual-auth **block** with a proper **request → review → approve** flow. RICS Client Money Rules require segregation of duties — the user who initiates a payment above the dual-auth threshold must NOT be the user who authorises it. The deployed `payment_authorisations` schema (00005:170-185) made this hard: `transaction_id NOT NULL` meant the transaction had to exist before the authorisation request, but a transaction created upfront would falsify `bank_accounts.current_balance` (via the `sync_bank_account_balance` trigger) while sitting in pending state.

**Decision:**

1. **Schema migration 00022.** `payment_authorisations.transaction_id` becomes nullable. A new `proposed JSONB` column stores a snapshot of the proposed transaction `{ bank_account_id, amount, transaction_date, description, payee_payer, reference, demand_id }`. A CHECK constraint `(transaction_id IS NOT NULL) OR (proposed IS NOT NULL)` enforces that every PA row references either a real transaction (legacy / post-authorisation) or carries a proposed snapshot (pending). Inner shape of the JSONB is application-validated; the DB does not enforce structure. JSONB chosen over discrete columns: future-extensible (e.g. for inter-account-transfer paired rows) without further migrations, less migration churn, and the snapshot is a write-once capture rather than a queryable record.
2. **Request flow.** TransactionsTab no longer rejects payments above threshold. Instead the form inserts a `payment_authorisations` row in `pending` with the proposed snapshot. The transaction itself is NOT created. A banner in TransactionsTab confirms the request was created and points at the new tab.
3. **Self-authorisation guard (UI, with deferred server backstop).** The Authorise action rejects with an inline error citing RICS / TPI segregation when `requested_by === currentUserId`. The button is also rendered disabled in this case. **Self-rejection IS permitted** and is exposed as a separate "Cancel request" action — a requester can withdraw their own pending request without breaking the rule. Server-side enforcement deferred to the financial-rules Edge Function in a later commit.
4. **Role guard.** Only `admin` or `director` may authorise or reject (mirrors 1d.1's `isFinanceRole`). Property Managers can only request and cancel their own.
5. **Authorise mechanics.** Two writes happen client-side: (a) INSERT a `transactions` row from the proposed snapshot (signed amount preserved, all proposed fields copied verbatim, `created_by` set to the original requester for the audit chain); (b) UPDATE the PA row with `transaction_id = <new>`, `status='authorised'`, `authorised_by=currentUserId`, `authorised_at=now()`. The balance trigger updates `bank_accounts.current_balance` automatically once (a) lands. Failure between (a) and (b) leaves the system in a recoverable state — the transaction exists but the PA row is still `pending`; refreshing surfaces it for re-authorise to retry the link. Atomic transactional wrap deferred to the Edge Function.
6. **Demand auto-status on authorise.** If the proposed payment carries `demand_id`, the same `applyDemandReceiptStatus` helper used in 1e runs after authorise. Forward-only (never reverts paid). Note: the helper only counts `transaction_type='receipt'` rows, so an authorised payment-type transaction with a `demand_id` does not move demand status — this is the correct behaviour because paying a demand is a receipt event, not a payment event. The smoke spec verifies this.
7. **Reject with reason.** Per-row Reject button → modal with required reason input → updates PA row with `status='rejected'`, `rejected_by`, `rejected_at`, `rejection_reason`. Visible to the requester. No transaction created.
8. **Cancel by requester.** Same database state as a rejection but reason is auto-set to "Cancelled by requester" and the modal omits the reason input (cancellations are by the requester themselves; no asymmetric explanation is needed).
9. **Immutability.** `authorised` and `rejected` PAs are immutable from this UI. The action buttons are absent on those rows. A row footer shows the resolution timestamp and reason (for rejections).
10. **Tab placement: per-property.** Eighth tab on `PropertyDetailPage`. The PA list is filtered to PAs whose proposed (or linked transaction's) `bank_account_id` belongs to this property. A firm-wide "All pending authorisations" dashboard for admins is a deferred enhancement.
11. **`authority_limit` column not surfaced.** The schema's per-PA authority limit is left unused for the PoC — enforcement is by role only. Recorded as future work for when a firm has multiple director-level users with differentiated authority limits (linked to the role-taxonomy expansion noted below).
12. **Out of scope (deferred).**
    - **Atomic transactional wrap** of authorise. Edge Function.
    - **Email / in-app notifications** to authorisers when a request is created. Phase 5 portal work.
    - **Firm-wide pending-authorisations dashboard** for admins.
    - **Audit log entries** for authorise / reject events. Phase 5+.
    - **Inter-account-transfer paired authorisation** — the `inter_account_transfer` type still isn't surfaced in TransactionsTab; whichever commit introduces it will need to handle the paired-row flow through the auth pipeline too.
    - **Closure / RICS-designation dual-auth** — 1g (separate commit). The 1d.1 closure role gate stays in place until 1g lands. 1g will require either extending `payment_authorisations` further with a generic `subject_type/subject_id` discriminator OR adding a sibling `critical_action_authorisations` table. Design call deferred to the 1g plan.

**Rationale:** The JSONB-snapshot pattern is the simplest way to honour the existing balance-trigger contract: a pending payment never enters the transactions table, so the trigger never falsifies the balance. Stamping `created_by` on the eventual transaction with the original requester (not the authoriser) keeps the audit trail honest — the person who originated the spend is recorded, while the person who authorised it is recorded on the PA row. The two-write authorise flow without atomicity is acceptable because failure mode is recoverable (no money moves; the PA stays pending; retry is safe). The self-rejection-but-not-self-authorisation asymmetry matches how RICS / TPI describe the rule: the second signer must be different, but a requester withdrawing their own request is not a control failure.

---

## 2026-05-10 — Per-property invoice spend cap (forward-looking requirement)

**Context:** Property managers should not be able to authorise contractor invoice payments above an agreed per-property limit without a director's permission. The per-property limit defaults to whatever is agreed in the management contract at setup but must be editable later — a property's risk profile can change (e.g. major works year, an RMC asking for tighter controls).

**Decision (recorded as a forward-looking constraint; no code in this commit):**

When invoices CRUD is built (Phase 3 successor commit, exact placement TBD), the workflow must support:

1. **Per-property invoice spend cap setting.** A new column on `properties` (e.g. `invoice_approval_threshold NUMERIC(14,2) NULL`) or a per-property settings row. NULL means "no cap; use the firm-default fallback." The default at property setup is read from the management contract — recorded as the contract's "agreed PM authority limit" value at onboarding.
2. **PM-facing approval workflow.** When a PM tries to mark an invoice as approved AND the invoice amount exceeds the property's cap, the action is BLOCKED at the UI with a message: "This invoice exceeds the per-property approval cap (£X.XX agreed in the management contract). Contact a director for permission. Once granted, ask the director to approve via the Director Approvals queue."
3. **Director-approval queue.** Reuses (or extends) the Critical-Action Authorisations infrastructure landing in 1g. A director sees pending invoice-over-cap approvals; on grant, the invoice approval flag flips and the PM can now process it. On deny, reason captured.
4. **Editable per property.** The cap is editable on the property-edit form (or a Settings tab on PropertyDetailPage). Edits to the cap are themselves audit-trailed; raising the cap on a property where significant spend is happening should leave a record.
5. **Default at setup.** When a property is added to PropOS via the onboarding flow, the cap is pre-populated from the firm's contract template (or, in the absence of a template, from an admin-set firm default). This makes the contract-encoded limit the starting point rather than something the PM has to remember to set.

**Rationale:** This closes a control gap that exists today — there is no automated enforcement of the contract's PM authority limit, only the social pressure of "ask the director first." Making it a hard UI gate aligns the system with RICS / TPI expectations on segregation of duties and removes the "I forgot to ask" failure mode. Recording it now as a forward-looking constraint means the invoices schema and UI work, when they land, will design for this from the start rather than retrofitting.

---

## 2026-05-10 — Payment authorisation role taxonomy (future extension)

**Context:** 1d.1 and 1f both gate critical actions on `admin` or `director` roles via `isFinanceRole`. This is right for the PoC but too coarse for a real firm. In production, a firm may want a dedicated "approver" role — a user whose only purpose is to authorise secondary payment requests, with no other PropOS access — and may want to restrict the `director` ability to authorise to specific named individuals (partners) rather than every director.

**Decision (recorded as a forward-looking constraint; no code in this commit):**

When the role taxonomy is expanded — likely at a phase boundary so seed data, JWT hook, and RLS policies can move together — the expansion should:

1. **Introduce a `payment_approver` (or similar) role.** Distinct from `director`. Members of this role have NO read/write access to operational data (properties, units, leaseholders, demands, contractors, etc.) — they only see the Payment Authorisations queue. RLS policies will need a new helper (e.g. `is_payment_approver()`) and the queue-access logic will branch.
2. **Allow a firm-level "authorised approvers" allow-list per bank account.** Some firms designate specific partners as approvers for specific accounts (e.g. one partner approves for the major-works account, another for the service-charge accounts). This is firm-policy-driven and probably modelled as a `bank_account_approvers` join table linking `bank_accounts` to `users` with a role hint.
3. **Use the existing `authority_limit` column on `payment_authorisations`.** A pending PA records the requester's proposed amount; an approver's effective limit is checked at authorise time. If their limit is below the proposed amount, the action is blocked and a higher-authority approver (or co-approval) is required.
4. **Preserve the self-auth guard regardless of role.** Even a dedicated approver cannot authorise their own request — the rule is per-action, not per-role.

**Rationale:** The current interim — `admin` or `director` only — is a reasonable PoC default but loses fidelity to how firms actually structure their controls. A regulated firm typically has a written list of authorised signatories per client account, with limits per signatory. PropOS will eventually need to mirror that. Recording it now means the `payment_authorisations` schema (and the 1g work that builds on it) leaves room for the allow-list and limit-check fields rather than baking in an "any director" assumption.

---

## 2026-05-10 — Test users seed pattern, plus-addressing convention, and demo-data sizing

**Context:** The Phase 3 1f smoke spec exposed a gap: 3 cross-user payment-authorisation tests had to skip because the dev seed contained only `admin@propos.local`. RICS-style segregation-of-duties tests need at least one non-admin user. Beyond closing that immediate gap, the wider question of demo / fake data showed up — both for unblocking tests and for screenshots, exploratory testing, and eventual sales / audit demos.

**Decision:**

1. **Test-user seed pattern.** Test users follow a two-step process: create the auth.users entry via Supabase Dashboard (auto-confirm, password `PropOS2026!` to match admin), then run `supabase/seed/test_users.sql` via Dashboard SQL Editor to insert the matching `public.users` row with the right firm_id and role. The SQL is idempotent (`ON CONFLICT (id) DO UPDATE`) so re-running is safe and refreshes role / full_name without duplicates. Adding more test users later (additional PMs, leaseholders for portal tests, contractor users) follows the same flow — extend the SQL with more `WHERE au.email IN (...)` cases.
2. **Initial test-user set (Size S, this commit).**
   - `pm@propos.local` — role `property_manager`, full name "Demo Property Manager"
   - `director@propos.local` — role `director`, full name "Demo Director"
   - `admin@propos.local` (existing) — role `admin`, unchanged
3. **Plus-addressing convention for operational emails.** Auth login emails are simple `<role>@propos.local` (local-only, never leave the dev project). When seed data populates the `email` field on operational records (leaseholders, contractors), it routes to the developer's two real inboxes via plus-addressing:
   - `ben.graham240689+propos-<context>@gmail.com` for Gmail-routed (admin, PMs, contractors)
   - `ben240689+propos-<context>@proton.me` for Proton-routed (director, leaseholders)
   - The `+` part is metadata — Gmail and Proton both deliver to the base inbox and let the developer sort by the tag. Live email flows (dispatch engine, demand notices) reach a real inbox so the pipeline is end-to-end testable without spamming third parties.
4. **Storage state per role.** Each test user has its own Playwright storage state file under `tests/.auth/<role>-user.json` (gitignored). Tests that exercise cross-user behaviour use `test.use({ storageState: '...' })` to swap the auth identity for the file. The default project storage state is admin (no behavioural change for existing tests). The `auth-pm.setup.ts` setup project saves the PM storage state on every test run; future role setups (`auth-director.setup.ts`, etc.) follow the same pattern when needed.
5. **Production safety.** The `test_users.sql` script will only ever insert against the firm row already present — there is no cross-firm operation. The script's pre-flight `DO $$` block raises an error if no firm exists. Combined with the per-environment `DB_URL` and the Dashboard-only execution path (no automation), the surface for accidentally seeding production is limited.

**Demo-data sizing — flagged forward-looking expansions:**

6. **Size M (planned, post-1g).** Realistic firm + property + leaseholder + financial demo data:
   - 3-5 properties with varied profiles (Victorian conversion, 1970s ex-LA, modern build, HRB > 18m, mixed-use commercial-over-residential)
   - 10-30 units across them; 10-30 leaseholders mixed individual / company / current / historical
   - 1-3 bank accounts per property, varied types and dual-auth thresholds, some RICS-designated
   - 2 service charge years per property (current open + last finalised)
   - 30-50 demands at all status states
   - 50-100 transactions covering receipts / payments / journals, with ~60% reconciled and ~10% statement-imported
   - 5-10 payment authorisations across pending / authorised / rejected
   - All emails route via plus-addressing
7. **Size L (full demo, phase boundary).** Everything in Size M, plus:
   - **Statutory documents per property** — every property has at least one of each required type with varied expiry dates so RAG status varies across the suite: EICR, FRA, gas safety, asbestos management + refurbishment surveys, lift LOLER (where applicable), insurance schedule, H&S policy, water hygiene / Legionella, PAT testing, fire suppression (HRBs), emergency lighting, planning consents / building regs.
   - **Section 20 consultations at every lifecycle stage** — at least one of each: `stage1_pending`, `stage1_observation_period`, `stage1_closed`, `stage2_pending`, `stage2_observation_period`, `stage2_closed → awarded`, `dispensation_applied → dispensation_granted`, `complete`, `withdrawn`.
   - 5-10 contractors with varied trade categories and varied response histories (some routinely accept, some decline, some no-response — so the dispatch escalation path is exercised).
   - Compliance items at varied RAG (red / amber / green).
   - Insurance with varied renewal dates.
   - Works orders at varied lifecycle states.
   - Documents folder in Storage populated with sample PDFs (lorem-ipsum filler is fine; realistic filenames + metadata).
   - BSA / HRB records for the HRB property (lands when Phase 5 schema is in place).

   Each property in Size L should be a complete picture — opening it should show the full PropOS feature set without any "TODO" or empty-state placeholders. Targeted at audit / sales / training demos.

**Per-stage flagging.** Each size's commit must end its DECISIONS entry with an explicit "still missing" list pointing at the next size, so future-me can read the most recent entry and know what's been seeded vs what's expected next. This prevents the "is this all the demo data, or is more coming?" ambiguity.

---

## 2026-05-10 — Demo mode toggle (forward-looking requirement)

**Context:** A real PropOS deployment must distinguish demo / training data from production data and must support cleanly leaving demo mode at first real onboarding. A new firm signing up doesn't want the previous tenant's "Maple House" leaseholders showing in their dashboard — even with RLS preventing cross-firm reads, the operational reality of a single shared dev project means the data needs to be removable in one action when the deployment graduates from demo to production.

**Decision (recorded as a forward-looking constraint; no code in this commit):**

When the demo-mode toggle ships (likely Phase 6 or 7 depending on when the first real customer arrives), the design must support:

1. **All seed / demo data lives under a clearly-marked "demo" firm.** The firm name carries a `(DEMO)` suffix or a dedicated `is_demo BOOLEAN` column. The current dev seed implicitly uses this pattern — there's a single firm and it's the demo one. The decision here is to make it explicit at the schema level rather than implicit by convention.
2. **One-action exit-demo.** An admin button (under Settings → System) deletes the demo firm and cascades. The schema's existing FK structure already supports cascading deletes from `firms` via `ON DELETE CASCADE` (verify this is set on every per-firm table in a follow-up). Auth users belonging only to the demo firm are also removed; auth users on real firms are unaffected.
3. **Pre-flight check.** Exiting demo mode is irreversible. The exit action requires typing the firm name and a checkbox confirming "I understand this deletes all demo data permanently." Same UX pattern as other destructive ops in the regulated-finance world.
4. **Audit log entry on exit.** A single immutable audit-log row records who exited demo mode and when, even though everything else is gone. Useful for compliance.
5. **Per-deployment, not per-firm.** A self-host deployment (Phase 8) starts in demo mode by default with the Size L data present; the operator exits demo on first real onboarding. A multi-tenant cloud deployment may have many firms and exiting demo only removes the demo firm specifically, leaving others untouched.

**Why record now:** the Size S / M / L seed data work designed in this commit will dominate the demo data shape. Designing it from the start to live under one identifiable firm (rather than scattering rows across firms or ad-hoc into the system) makes exit-demo a one-line `DELETE FROM firms WHERE id = $1` rather than a cleanup hunt across 26 tables.

**Out of scope until at least Phase 6** (Reporting / first-customer prep). This entry exists so the demo data work in 1f.5 / Size M / Size L stays compatible with the eventual exit path.

---

## 2026-05-10 — Closure dual-auth (1g): PM-requests-via-button, admin-authorises-via-PA-tab

**Context:** The 1d.1 interim role gate disabled the `Active` checkbox and the `Delete` button for non-finance users on bank accounts. That closed the immediate compliance hole (PMs couldn't unilaterally close client-money accounts) but left PMs with no path at all — they had to ask an admin to do it manually. 1g delivers the proper second-signer flow: PM clicks **Request closure**, an admin or director (not the requester) authorises via the existing Payment authorisations tab, and the account flips to `is_active=false` only on authorise. Replaces the 1d.1 dead-end with a working request lane.

**Decision:**

1. **Schema migration 00023.** `payment_authorisations` gains `action_type TEXT NOT NULL DEFAULT 'payment'` with a CHECK constraint `IN ('payment', 'close_bank_account')`. Existing rows backfill to `'payment'` via the DEFAULT — 1f's flow is unchanged. Future action types (`toggle_rics_designation` in 1g.5) are added by extending the CHECK constraint.
2. **Discriminated `proposed` JSONB.** TypeScript-side, the `proposed` column is now typed as `ProposedAction = ProposedTransaction | ProposedClosure`. Both shapes carry `bank_account_id` (so the per-property filter in PaymentAuthorisationsTab works for either action type without branching). DB-level the column stays a single JSONB; the discriminator is `action_type` on the row, not a key inside the JSONB. This keeps the schema small and avoids encoding type info into the payload.
3. **PM request flow.** BankAccountsTab renders an explicit **Request closure** button (Send icon) on the action column for non-finance roles when the account is currently active. Click → inline confirmation row → submit inserts a `payment_authorisations` row with `action_type='close_bank_account'`, `proposed={ bank_account_id, closed_date: today }`, `requested_by=currentUserId`. The Active checkbox stays disabled (visual cue that closure is gated) but the button gives PMs an actionable path.
4. **Closure authorise dispatch.** PaymentAuthorisationsTab's `handleAuthorise` switches on `action_type`: `'payment'` runs the existing 1f flow (insert transaction + link); `'close_bank_account'` updates `bank_accounts.is_active=false` + `closed_date=proposed.closed_date` (snapshot-from-request, not "now" — the audit trail records the requester's intent), then marks the PA `authorised` with `transaction_id` left null. The two writes are non-atomic; failure between them leaves the bank closed but the PA still pending — recoverable on refresh + retry-authorise (idempotent because is_active is already false). Atomic wrap deferred to the financial-rules Edge Function.
5. **Closure rendering in the queue.** When `action_type='close_bank_account'`, the PA row renders distinctly: "Close: \<account name\>" replaces the description column, payee / amount / demand columns show "—". Status badge and the Authorise / Reject / Cancel buttons behave identically. Self-auth guard is unchanged (admin can't authorise own closure request; admin CAN cancel own request).
6. **Hard-delete still bypasses the auth flow.** Hard-delete is a separate, more-restrictive action that already requires admin/director (1d.1 gate stays in place). Deleting an account that ever held client money is forbidden by the FK / closed_date guards from 1b. The auth flow does NOT cover hard-delete; that path is reserved for the override-of-last-resort case (never-reconciled, never-closed accounts) and stays direct admin/director action without dual-auth. Recorded for visibility.
7. **`inter_account_transfer` paired-row authorisation** still deferred — same reasoning as 1f.
8. **`toggle_rics_designation` deferred to 1g.5** — same dispatch pattern, but the proposed snapshot shape is `{ bank_account_id, new_value: false }` (toggling off the designation is the high-stakes case; on→off is what needs gating). Schema CHECK extends to include `'toggle_rics_designation'`. Lands in a small follow-up commit.

**Smokes (3 added).** `closure PA pending row renders as a closure entry`, `closure authorise flips bank_account to closed`, `PM-driven UI Request closure button creates a closure PA` (uses PM storage state from 1f.5). Active count goes from 82 to 85.

**Rationale:** Reusing the `payment_authorisations` table with an `action_type` discriminator is meaningfully simpler than adding a sibling table — fewer migrations, one auth queue UI, and the existing self-auth guard / role guard / cancel-by-requester / immutability rules apply without modification. The shape-divergence between payment and closure authorisations is small enough that branching once in the authorise dispatch + once in the row rendering is cheaper than maintaining two parallel surfaces. The discriminator-on-row pattern leaves room for future action types (RICS-designation, hard-delete override, future Critical Actions) to slot in without further schema churn.

---

## 2026-05-10 — RICS-designation toggle dual-auth (1g.5): direction-gated request flow

**Context:** 1g §8 deferred the RICS-designation toggle dual-auth to 1g.5 with the snapshot shape `{ bank_account_id, new_value: false }`. RICS Client Money Rule 4.7 treats the designation flag as evidence: removing it on an account that ever held client money should not be a single-user action. The direction matters — toggling `false → true` is the protective direction (declaring an account as RICS-designated tightens controls); toggling `true → false` is the high-stakes direction that strips a designation already on record. Only the latter needs gating.

**Decision:**

1. **Schema migration 00024.** `payment_auth_action_type` CHECK constraint widened from `IN ('payment', 'close_bank_account')` to `IN ('payment', 'close_bank_account', 'toggle_rics_designation')`. Drop + re-add (no NOT VALID needed because all existing rows are 'payment' or 'close_bank_account'). The proposed JSONB column stays a single column; the per-action shape is application-validated via `ProposedRicsDesignationToggle = { bank_account_id, new_value }`.
2. **Direction gating in the UI.** The dual-auth path covers `true → false` only. The protective direction (`false → true`) remains a direct edit through the Bank account form — no request needed. The PM-facing "Request designation removal" button (`ShieldOff` icon) on `BankAccountsTab` is shown only when `!canManageClosure && account.rics_designated === true`. Click → inline confirmation row → insert PA with `action_type='toggle_rics_designation'`, `proposed={ bank_account_id, new_value: false }`. Confirmation banner cites RICS Rule 4.7 (the assertion text doubles as the test anchor — the LESSONS Phase 3 pattern).
3. **PM-via-button-request, admin-direct (mirrors 1g closure exactly).** Admins / directors continue to flip the `rics_designated` checkbox in the form directly. The asymmetry is deliberate: the dual-auth flow is the path PMs use; admins are not blocked. If a future requirement tightens to "no single-user action regardless of role", the admin-form-checkbox can be gated separately. Recorded as forward-looking (see "Things to watch" below).
4. **Authorise dispatch.** `PaymentAuthorisationsTab.handleAuthorise` adds a third branch — `await authoriseRicsToggle(pa, proposed)`. Two writes, non-atomic, recoverable: (a) UPDATE `bank_accounts.rics_designated = proposed.new_value`; (b) UPDATE the PA row to `authorised`. `transaction_id` stays null. The snapshot's `new_value` is applied verbatim rather than "negate current" — re-authorising when the row already matches is idempotent. Atomic wrap deferred to the financial-rules Edge Function.
5. **PA row rendering.** Description column shows `"RICS designation: <account name> → Remove"` (or `"Designate"` if a future flow surfaces the protective direction). Payee / amount / demand columns show `"—"`. Self-auth guard, role gate, cancel-by-requester, and post-action immutability are unchanged from 1f / 1g.

**Smokes (3 added).** `rics-toggle PA pending row renders as a designation-removal entry`, `rics-toggle authorise admin authorises bank_account.rics_designated flips`, `PM-driven UI Request designation removal button creates a rics-toggle PA` (uses PM storage state). Active count goes from 85 to 88.

**Out of scope (deliberate).**

- **Server-side enforcement** of the direction gate, role guard, and self-auth guard — financial-rules Edge Function. *FORWARD: when that function lands, mirror the 00024 CHECK and the UI's `proposed.new_value === false` direction guard.*
- **Admin direct-flip block** in the BankAccountForm — admins still toggle `rics_designated` directly. *FORWARD: if firm policy hardens to "no single-user action regardless of role", gate the admin checkbox via dual-auth as well.*
- **`false → true` direction** — direct edit, no request needed (protective direction). *FORWARD: if a regulator flags spurious designations, gate this direction too.*
- **Atomic transactional wrap** of the two-write authorise — same recovery story as 1g closure.
- **Firm-wide pending-authorisations dashboard** — still per-property; pulling forward is recorded in the 2026-05-10 Closure DECISIONS entry.

**Rationale:** The migration is one CHECK extension. The TypeScript additions are a 4-line interface + a tuple member + a discriminator branch in two places. The smoke surface mirrors the 1g closure surface 1:1. The asymmetry between PM-request and admin-direct is the same call as 1g closure — keeping the two flows aligned avoids splitting the muscle memory. RICS Rule 4.7's surfacing in the confirmation banner gives the test a stable anchor and explains the constraint to the PM in their own context, satisfying the "statutory citations doubling as test anchors" pattern from LESSONS Phase 3 session 2.

---

## 2026-05-10 — Comment hygiene + asymmetry regression test (1g.6)

**Context:** A 1g.5 audit pass surfaced four stale comments in `BankAccountsTab.tsx` referencing commits / behaviours that have since shifted (transactions shipped in 1e; the balance trigger landed in 00005:144; the dual-auth workflow shipped across 1f / 1g / 1g.5 rather than only 1f). Separately, the deliberate 1g.5 asymmetry — admins can edit `rics_designated` directly via the form while PMs go through the dual-auth request flow — is a design decision that should have a regression test so a future commit accidentally extending the gate to admins fails loudly rather than silently.

**Decision:**

1. **Comment fixes in `BankAccountsTab.tsx`.** File-level docstring updated to: name `sync_bank_account_balance` (00005:144) explicitly as the trigger; remove `transactions` from the "NOT responsible for" list (TransactionsTab owns that since 1e); add the rule-5 line covering the closure / RICS-designation dual-auth flows. `FINANCE_ROLE_TOOLTIP` rewritten to direct PMs at the **Request closure** button rather than referencing "commit 1f" as a future home. `handleDelete`'s defence-in-depth comment now references the financial-rules Edge Function (deferred) rather than commit 1f.
2. **Regression smoke (1 added).** `admin can flip rics_designated true→false directly via the form (1g.5 asymmetry preserved)` lives in `financial-bank-accounts.spec.ts`. Seeds an admin-owned account with `rics_designated=true`, snapshots the firm's PA count, opens the edit form, asserts the checkbox is enabled, unticks + saves, asserts the row is updated and PA count is unchanged. Active count: 88 → 89.
3. **No schema or behaviour changes.** Pure-comment + pure-test commit. Migration ledger unchanged at 00024.

**Rationale:** Stale comments accumulate trust debt. A reader auditing financial code who sees "trigger lands in commit 2" loses confidence in every other comment in the file. Regression tests on deliberate asymmetries are the cheapest way to make a design choice survive future refactors — without one, "admin can edit directly" is just a memory in DECISIONS that may not be the most-recently-read document when the next change lands.

---

## 2026-05-10 — Security-smoke pass (forward-looking)

**Context:** PropOS is a regulated-finance system; RICS / TPI / FCA inspection trails depend on evidential controls that survive contact with adversarial users. The current smoke harness covers happy-path UI flows and statutory citation surfacing but does not exercise the security boundaries. A dedicated security-smoke pass is the right home for those tests, scheduled to land alongside the financial-rules Edge Function (the server-side enforcement layer that several UI guards already defer to).

**Decision (forward-looking; no code in this commit):**

When the security-smoke pass lands (likely the financial-rules Edge Function commit), it should cover at minimum:

1. **RLS enforcement under role-swap.** A PM-authenticated supabase-js client should read **zero** rows from another firm's `bank_accounts`, `payment_authorisations`, `transactions`, `demands`, `service_charge_accounts`, `compliance_items`. Build a "foreign firm" via the test_users.sql pattern (a second firm with its own admin / PM seeded via Dashboard). Today no smoke verifies cross-firm isolation.
2. **Self-auth bypass via direct DB.** A user crafting an INSERT into `payment_authorisations` then an UPDATE setting `status='authorised'` and `authorised_by=<self>` should be rejected by the financial-rules Edge Function. Today: client-side guard only — direct DB writes via supabase-js with a leaked publishable key would succeed.
3. **JWT tampering.** A token with a forged `user_role: 'admin'` claim should not get elevated access. The hook resolves role from `public.users` (DECISIONS 2026-05-07), so the rejection should be automatic; the smoke proves the trust boundary holds.
4. **Hard-delete via service-role.** Out-of-band deletion of `bank_accounts` / `transactions` / `demands` should be detected via the audit-log layer (Phase 5+) and produce a flagged anomaly. Smoke writes the bypass and asserts the audit signal.
5. **Authority limit bypass.** `payment_authorisations.authority_limit` is currently unused. Once enforcement lands, smoke should authorise above-limit and assert rejection.
6. **Storage bucket scoping.** Leaseholder-portal users should not retrieve another firm's documents via the storage API. Mirrors the RLS test for the storage layer.

*FORWARD: this entry is the canonical scope for the security-smoke pass. When the financial-rules Edge Function is built, expand each bullet into a smoke + cite this entry in the commit's DECISIONS.*

---

## 2026-05-10 — Data-integrity / auto-protect pass (forward-looking)

**Context:** The financial entities (bank accounts, transactions, demands, payment authorisations, service charge accounts) currently rely on UI guards + RLS for integrity. The DB has minimal CHECK constraints and no anomaly detection. A dedicated integrity / auto-protect pass should harden the DB layer so a determined bad actor with direct DB access cannot quietly corrupt the audit trail. This is the kind of work that belongs in Phase 5 alongside the audit-log table.

**Decision (forward-looking; no code in this commit):**

When the integrity / auto-protect pass lands, it should cover at minimum:

1. **Sign-vs-type integrity.** `transactions.transaction_type='receipt'` requires `amount > 0`; `payment` requires `amount < 0`; `journal` allows either non-zero. Implement as a `CHECK` constraint on the table. Smoke: insert each forbidden combination via supabase-js and assert rejection. Existing UI converts on save (1e), so this just locks in what the UI already enforces.
2. **Audit-stamp coherence.** `(authorised_at IS NULL) = (authorised_by IS NULL)` and the equivalent for `(rejected_at, rejected_by, rejection_reason)`. A row with `authorised_at` set but `authorised_by` null is structurally invalid and signals tampering. Add as `CHECK` constraints on `payment_authorisations`.
3. **Proposed-JSONB immutability post-action.** Once a PA is `authorised` or `rejected`, `proposed` should be frozen. Add a BEFORE-UPDATE trigger that rejects `OLD.status != 'pending' AND NEW.proposed IS DISTINCT FROM OLD.proposed`. UI never edits `proposed` after pending; this defends against direct-DB tampering.
4. **Time-window sanity.** `transactions.transaction_date` constrained to a sensible window — e.g. `1990-01-01 ≤ transaction_date ≤ today + 1 year`. Same on `demands.issued_date`. CHECK constraint with a clear error message.
5. **Trigger-maintained-value protection.** `bank_accounts.current_balance` is owned by `sync_bank_account_balance` (00005:144). Add a column-level rule: any UPDATE that changes `current_balance` is silently overwritten back to `SUM(transactions.amount)` for that account, OR rejected with an explicit error. Same pattern for any future trigger-owned values (e.g. `service_charge_accounts.spent_so_far` when reconciliation lands).
6. **Rapid-mutation rate limit (auto-protect).** Add a `last_mutation_at TIMESTAMPTZ` column to high-stakes tables (`payment_authorisations`, `bank_accounts`) and a BEFORE-UPDATE trigger that rejects mutations faster than (e.g.) 100ms apart. Prevents flapping / scripted attacks. The dispatch path inside the financial-rules Edge Function gets a bypass token.
7. **Tamper-resistant audit log.** Append-only `audit_log` table with `INSERT`-only RLS for every role including `service_role`. Every financial mutation writes a row with `actor_id`, `action`, `before_state`, `after_state`, `at`. Belongs with the Phase 5 audit work.
8. **Anomaly detector.** A periodic Edge Function that surfaces patterns like "balance changed by > 10% in < 5 minutes without a corresponding transaction insert" or "more than N demands withdrawn in M minutes". Surfaces to admin dashboard. Phase 6+.

The "auto-protect on detection" pattern: items 5, 6, 7 are passive (they reject or rewrite invalid writes). Item 8 is active (it surfaces alerts). Layering passive + active gives defence in depth.

*FORWARD: this entry is the canonical scope for the data-integrity / auto-protect pass. When Phase 5 audit-log lands, expand each bullet into a migration + smoke + cite this entry.*

---

## 2026-05-10 — Production-grade gate (the demo-grade-to-production-grade rule)

**Context:** PropOS is being built as a PoC; many enforcement decisions ship as UI-only at PoC time with the proper server-side enforcement deferred (financial-rules Edge Function, INSERT-only audit-log RLS, atomic transactional wraps, etc.). The "Demo mode toggle" entry from earlier today covers data deletion at exit-demo time but not the orthogonal question of feature-behaviour difference. The build engineer's directive: **a real customer must never be exposed to a PoC-grade behaviour**. PoC-only paths must be either replaced with their production version OR refused at runtime when a firm has exited demo mode.

**Decision:**

1. **`firms.is_demo BOOLEAN NOT NULL DEFAULT true`** — added in migration 00025. Default `true` => every existing firm is correctly classified at PoC time. The Demo-mode-exit flow (Phase 6/7 candidate per the existing entry) flips this to `false`. No runtime branching is implemented in this commit, but the column is in place so future PoC-grade code paths can reference it without a migration when the production replacement lands.
2. **`FORWARD: PROD-GATE` flag convention.** Every PoC-only enforcement decision in any commit carries a paired flag at the relevant code anchor (file, migration, doc) — not just in DECISIONS. Convention:
   ```
   // FORWARD: PROD-GATE — replace before any firm exits demo mode.
   // Reason: <one line>. Anchor: <DECISIONS entry>.
   ```
   The grep manifest is `grep -r "FORWARD: PROD-GATE"`.
3. **Exit-demo pre-flight (not in this commit; recorded as the eventual contract).** When the demo-mode-exit flow ships, its pre-flight scans the codebase (or a maintained manifest) for `FORWARD: PROD-GATE` flags. For each, the production replacement must either be deployed (Edge Function live, trigger present, etc.) OR the code path must refuse to run with a clear "production-grade enforcement not yet deployed for this firm — contact support" banner. The flow refuses to flip `is_demo=false` if any reachable PROD-GATE path is unaddressed.
4. **Sibling, not replacement, of the existing "Demo mode toggle" entry.** That entry covers data deletion (one-action exit-demo deletes the demo firm and cascades). This entry covers behaviour difference (PoC-only enforcement paths must not be reachable from a non-demo firm). Both are pre-flight checks at the same moment.

**Rationale:** Without this rule, the "Demo mode toggle" is half a story — clean data, but unsafe behaviour. With it, exiting demo mode is a hard gate that catches every UI-only guard, every non-atomic write path, every audit-log path that's missing append-only RLS. The `FORWARD: PROD-GATE` convention turns the deferred items list into a grep-able manifest rather than a memory-only hazard. The `is_demo` column is one line in a migration; the runtime-branch implementation lands when it's needed and can rely on the column already being there.

**Initial PROD-GATE manifest** (planted in this commit's reconciliation work; expand on every subsequent commit):

| # | PoC compromise | Production replacement | Anchor |
|---|---|---|---|
| 1 | Client-side three-pass matching | Edge Function `reconciliation_engine.ts` | `app/src/lib/reconciliation/matchingEngine.ts` (1h.2) |
| 2 | Self-mapped CSV columns | Curated bank-template presets | `parseStatement.ts` header + `00025_*.sql` |
| 3 | CSV-only parsers | OFX + QIF + Open Banking AIS | `parseStatement.ts` registry |
| 4 | UI-only `period.status='completed'` immutability | DB BEFORE-UPDATE trigger | `00025_*.sql` |
| 5 | UI-only suspense-row immutability | DB CHECK + trigger | `00025_*.sql` |
| 6 | UI-only audit-log INSERT (no append-only RLS) | INSERT-only RLS for every role | `00025_*.sql` |
| 7 | Two-write non-atomic completion | Edge Function in `BEGIN…COMMIT` | `ReconciliationCompleteModal.tsx` (1h.3) |
| 8 | UI-only £0.01 balance check | DB-level trigger reconciling balance | `00025_*.sql` |
| 9 | Manual suspense-item resolution path | Resolution lifecycle UI | `ReconciliationTab.tsx` |
| 10 | Client-stamped `reconciled_by` | Edge Function stamps from auth context | `ReconciliationReviewModal.tsx` (1h.2) |
| 11 | No 6-year retention enforcement on `reconciliation_audit_log` | retention_until + nightly cold-storage cron | `00025_*.sql` |
| 12 | No anomaly detection on reconciliation patterns | Periodic Edge Function | DECISIONS only — too distant for code FORWARD |

*FORWARD: PROD-GATE — this entry is the canonical scope of the production-grade gate. Every Phase 3+ commit should grow the manifest and plant a paired flag at each anchor.*

---

## 2026-05-10 — Reconciliation 1h.1: schema + statement import pipeline

**Context:** Phase 3's bank reconciliation engine (spec §5.3) is the last substantial piece before Phase 3 wraps. The work is too large for one commit, so it's split: 1h.1 (schema + import pipeline), 1h.2 (matching engine + review UI), 1h.3 (completion + audit log writes). Each commit ends in a clean state — 1h.1 leaves periods open with statement uploaded, awaiting the review screen that lands in 1h.2. The plan-first gate produced the file list, smoke list, and migration SQL up front; the user signed off on the 3-commit decomposition, the CSV-only parser scope, the dedicated `reconciliation_periods` table, the partial unique index for one-open-period-per-account, the column-mapping JSONB on `bank_accounts`, and the `firms.is_demo` Production-grade gate column.

**Decision:**

1. **Schema migration 00025.** Adds `firms.is_demo`, `bank_accounts.csv_column_map JSONB`, three new tables (`suspense_items`, `reconciliation_periods`, `reconciliation_audit_log`), and a partial unique index `uq_recperiod_one_open_per_account ON reconciliation_periods(bank_account_id) WHERE status = 'open'` (enforces 1h.3 smoke 2b — one open period per bank account at any time). RLS on each new table mirrors the financial-tables pattern at 00012:122-136 (`firm_id = auth_firm_id() AND is_pm_or_admin()`). Seven `FORWARD: PROD-GATE` flags planted across the migration file at each PoC-only enforcement point.
2. **Tab placement.** Reconciliation is the **9th** per-property tab on `PropertyDetailPage`, after Payment authorisations. Per-property scope matches RICS / TPI inspection units; multi-account reconciliation across the firm is deferred (Phase 6 reporting candidate).
3. **Period lifecycle is the persistent thing.** A reconciliation period is the durable unit. A statement upload is an event within the period. PMs can start a period, walk away, and come back to upload — supporting the realistic workflow where statement download from the bank and processing happen at different times. The `bank_statement_imports.status` (pending → processing → matched → complete) tracks the import event; the `reconciliation_periods.status` (open → completed) tracks the period itself.
4. **Status discipline.** Per spec §5.3 "On parse success, status moves to 'processing'." On the client, we insert directly with `status='processing'` once the parser succeeds — pending only ever exists transiently in the spec's server-side model and would be misleading to write client-side. Matching ('matched') and completion ('complete') statuses land in 1h.2 / 1h.3.
5. **CSV parser with column-mapping.** `parseStatement.ts` dispatches by detected format (`detectFormat` sniffs OFX `<?xml`/`<OFX>` and QIF `!Type:` markers). CSV implementation handles header-row detection (skipping Lloyds-style preambles), quoted fields with escaped quotes, single-amount and debit/credit-pair amount paths, three date formats (DD/MM/YYYY, YYYY-MM-DD, MM/DD/YYYY), thousands separators, parens-for-negative, £ prefix. OFX and QIF stubs throw `StatementParseError` with the literal "FORWARD: 1h.4" string in the user-facing message — doubling as the test anchor for smoke 4 (statutory-citation pattern from LESSONS Phase 3 session 2 applied to forward references).
6. **Column-mapping cached on `bank_accounts.csv_column_map`.** First import surfaces a mapping form auto-populated from cached map if the previous import's headers are still present; mismatched headers reset the map. Saved back on successful import only — failed imports don't pollute the cache. PROD-GATE flag points at curated bank-template presets as the production replacement.
7. **One-open-period-per-account guard.** The partial unique index in 00025 enforces this at the DB layer. UI catches the 23505 and surfaces the friendly message "This account already has an in-progress reconciliation period. Open it from the list."
8. **No matching, no completion, no review modal in this commit.** ReconciliationTab and StatementImportModal both reference 1h.2 / 1h.3 explicitly with FORWARD comments. The "review pending" state when an open period has an uploaded statement surfaces a clear message pointing at 1h.2.

**Smokes (4 added).** Active count: 89 → 93.
- `Reconciliation tab renders 9th and lists per-account state` — verifies tab presence, the per-account row, the "Never reconciled" badge for a fresh account, and the Start reconciliation button.
- `PM starts a new reconciliation period — period row created with status=open` — full flow through the modal asserting the `reconciliation_periods` row.
- `CSV statement upload parses and writes raw_data with status=processing` — asserts the bank_statement_imports row status, row_count, parsed amounts in pence (e.g. £1500.00 → 150000), date normalisation to ISO, and that csv_column_map is cached.
- `OFX upload surfaces format-not-yet-supported note rather than crashing` — asserts the parse-error message names "FORWARD: 1h.4", the submit button is disabled, and no period or import rows persist on Cancel.

**Out of scope (deliberate, with FORWARD anchors planted).**
- Matching engine + ReviewModal — 1h.2.
- Completion modal + £0.01 balance check + audit-log writes per action — 1h.3.
- OFX + QIF parsers — `FORWARD: 1h.4` (PROD-GATE flag in `parseStatement.ts`).
- Curated bank-template presets — PROD-GATE flag in `parseStatement.ts` + `00025_*.sql` near `csv_column_map`.
- Re-reconciliation flow — `FORWARD: PROD-GATE` flag in `ReconciliationTab.tsx` header.
- Suspense-item resolution UI — flagged in `ReconciliationTab.tsx`; Phase 3 successor.
- Server-side enforcement (atomic completion, INSERT-only audit log, period-immutability trigger, sign/type CHECK, retention cron) — financial-rules Edge Function commit; covered by the Security-smoke pass and Data-integrity / auto-protect pass entries.

**Rationale:** Splitting the substantial reconciliation work into three commits keeps each unit small enough to land in green-band context, with clean DECISIONS entries per commit. The persistent-period model (vs implicit-via-`last_reconciled_at` boundaries) cleanly supports the Phase 6 financial-summary report's need to surface `suspense_carried_forward` historically. The `firms.is_demo` column landing in this migration (rather than waiting for the demo-mode-exit commit) costs one ALTER and means every PoC compromise from this commit forward has a column to branch on when its production replacement ships. The PROD-GATE flag convention turns the manifest into a grep-able codebase property rather than a memory hazard.

---

## 2026-05-10 — Reconciliation 1h.2: three-pass matching engine + review UI

**Context:** 1h.1 left periods open with statements uploaded in `bank_statement_imports.status='processing'`. 1h.2 implements the three-pass matching algorithm (spec §5.3 Matching Algorithm), the review modal that consumes the matching output, and the four PM actions on unmatched rows (Create new transaction / Match manually / Mark as suspense / Reject). Every action writes an audit-log row citing RICS Rule 3.7 — statutory citation doubling as test anchor (LESSONS Phase 3 session 2 pattern).

**Decision:**

1. **Pure-functional matching engine in `app/src/lib/reconciliation/matchingEngine.ts`.** `runMatching(rows, transactions)` returns `{ matches, unmatchedRowIndices, unmatchedTransactionIds }`. No DB I/O. The pass predicates are local helpers (`matchesPass1` / `matchesPass2` / `matchesPass3`); the dedup invariant is enforced by `Set` candidate pools that shrink per pass. Deterministic ordering (date asc, then amount desc, then index/id) means smoke 8's pass-1-then-pass-2 dedup test is stable across runs regardless of DB row ordering.
2. **Pass predicates lock to spec verbatim.**
   - Pass 1: `txn.amount === stmt.amountP` to the penny + `|days(txn, stmt)| <= 2` + `(stmt.reference contains txn.reference OR stmt.payee == txn.payee)`. Confidence 1.00. Auto-applies on modal open.
   - Pass 2: amount-to-penny + `|days| <= 7`. No ref/payee constraint. Confidence 0.80. PM Confirm.
   - Pass 3 (two disjunctive subclauses): amount-to-penny + `|days| <= 30`, OR `|stmt - txn| <= 50p` + `|days| <= 7`. Confidence 0.50. PM Confirm. The two subclauses get separate smoke coverage (smokes 7 + 7b) so a future refactor cannot quietly tighten the £0.50 tolerance branch without breaking a test.
3. **Auto-match-on-open with idempotent re-entry.** When `ReconciliationReviewModal` opens for a `processing` import, it loads unreconciled txns on the bank account, runs matching, applies pass-1 matches to the DB (`transactions.reconciled=true` + `statement_import_id` + `reconciled_at` + `reconciled_by`), writes audit-log rows with `action='auto_match'`, persists the per-row state into `bank_statement_imports.raw_data`, and updates `matched_count` / `unmatched_count` / `status='matched'`. Re-opening the modal is safe — already-matched rows are filtered out of the candidate pool on re-run (idempotent property the design depends on).
4. **Per-row state lives on `raw_data`.** Each parsed row gains optional fields after matching: `matchStatus` (`'matched' | 'suspense' | 'rejected'`), `matchedTransactionId`, `matchPass`, `matchConfidence`, `suspenseItemId`, `rejectionReason`. Every PM action rewrites the whole `raw_data` JSONB with the per-row patch — simpler than per-element JSONB UPDATEs and makes the modal source-of-truth easy to reason about. The corresponding `transactions.reconciled` flag and `suspense_items` row are the system-of-record; `raw_data` is the audit trail of what the PM saw on screen.
5. **`auditLog.recordAction()` helper.** Wraps the INSERT to `reconciliation_audit_log`. Throws on error rather than silently swallowing — spec §5.3 RICS RULE: "the reconciliation engine ... is the system component that demonstrates compliance, so its audit log is itself a compliance artefact." Every action's `notes` field starts with the literal string `RICS Rule 3.7 evidence trail —`. PROD-GATE flag points at server-side actor stamping.
6. **Tab dispatch updated.** `ReconciliationTab` now branches on `(openPeriod, openPeriodImport)` state: no period or no import → `StatementImportModal`; period with import → `ReconciliationReviewModal`. The "Continue reconciliation" button on each account row routes to the correct modal automatically.
7. **Unmatched-row sub-flows.** Each unmatched row exposes four buttons (Create new / Match manually / Suspense / Reject) which open an inline `ActionForm` card under the unmatched list (rather than nested modals — keeps the surface coherent and avoids strict-mode locator collisions on multiple modal headings). Each sub-flow:
   - **Create new** prefills the new transactions row from stmt (`amount`, `date`, `description`, `payee`, `reference`); sign convention picks `transaction_type` (positive = receipt, negative = payment); inserts with `reconciled=true` so the new row participates in subsequent reconciliation summing immediately.
   - **Match manually** picker offers all unreconciled transactions on this `bank_account_id` (no period filter — more flexible for the off-cycle catch-up case where a PM is reconciling rows the algorithm couldn't reach).
   - **Suspense** requires a non-empty reason and inserts a `suspense_items` row with `target_resolution_date` (defaulted to today; PM can override).
   - **Reject** requires a non-empty reason; no transaction created; row is flagged in `raw_data`. Audit-log row's notes include the reason verbatim so the rejection rationale is preserved.
8. **Out of scope (deliberate, FORWARD anchors planted).**
   - Completion + £0.01 balance gate + `last_reconciled_at` write — 1h.3.
   - Suspense-item resolution UI — `FORWARD: PROD-GATE` flag in `ReconciliationTab.tsx`; covered by Production-grade gate item 9.
   - Edge Function lift of matching algorithm — `FORWARD: PROD-GATE` in `matchingEngine.ts` header; covered by Production-grade gate item 1.
   - Atomic transactional wrap of "flip txn.reconciled + write audit row" — non-atomic at PoC; recoverable on refresh because pass-1 matching is idempotent. Covered by item 7 of the Production-grade gate.
   - Server-stamped `actor_id` on audit-log rows — `FORWARD: PROD-GATE` in `auditLog.ts`. Covered by item 6.

**Smokes (9 added).** Active count: 93 → 102.
- `Pass-1 exact match auto-matches with confidence 1.00 + audit row` — verifies the auto-apply path, the `confidence 1.00` substring in audit notes, and the `bank_statement_imports.status='matched'` transition with correct counts.
- `Pass-2 strong match Suggested 80% — Confirm + audit row` — clicks the per-row Confirm button, asserts modal-state-change before DB query (modal-vs-DB-query race pattern from LESSONS Phase 3 session 2), verifies `confidence 0.80` substring.
- `Pass-3 weak match (amount-to-penny + ±30 days subclause)` — covers Pass-3 subclause A.
- `Pass-3 weak match (£0.50 tolerance + ±7 days subclause — foreign card rounding)` — **smoke 7b** locks the disjunctive subclause B path so a future refactor can't silently tighten the rounding tolerance.
- `Dedup — pass-1 match removes its txn from pass-2 candidate pool` — two-txn-two-row scenario; verifies the candidate pool invariant.
- `Unmatched — Create new transaction prefills + saves with reconciled=true` — verifies the new row carries `reconciled=true` and `statement_import_id` set.
- `Unmatched — Match manually picker filters to unreconciled txns` — picker visible, selects a txn that wouldn't have matched algorithmically (off-cycle date + different amount).
- `Unmatched — Mark as suspense inserts suspense_items row` — verifies `status='open'`, `target_resolution_date`, `resolution_notes` capture.
- `Unmatched — Reject writes audit row citing RICS Rule 3.7` — string assertion against the audit notes; no transactions row created.

**Rationale:** Pure-functional matching keeps the engine trivially testable and the smoke surface deterministic. The dedup invariant via `Set` pools is the simplest correct shape; alternatives (graph matching, optimal assignment) would be over-engineered for a per-period pool of ~50–200 rows. Splitting the disjunctive Pass-3 rule into two smokes is cheap insurance against the kind of regression the LESSONS Phase 3 entry calls out — the £0.50 tolerance branch is a foreign-card-rounding edge case that's easy to break under refactor and hard to spot by eye. The action-form-as-inline-card approach (vs nested modals) avoids strict-mode locator collisions across multiple modal headings — the LESSONS pattern that bit the 1f / 1g smokes the first time. The PROD-GATE flags planted in `matchingEngine.ts`, `auditLog.ts`, and `ReconciliationTab.tsx` extend the Production-grade gate manifest from items 1, 6, 9 of the canonical list.

---

## 2026-05-07 — pgAudit enablement approach

**Context:** Section 4 requires pgAudit to be enabled before any data migration. The Supabase hosted project does not allow direct superuser SQL for extension creation on the free tier in some cases.
**Decision:** pgAudit is enabled via a migration that calls `CREATE EXTENSION IF NOT EXISTS pgaudit;`. On Supabase Pro/hosted, this runs as the `postgres` role which has extension creation rights. If the extension is already enabled by the platform, the `IF NOT EXISTS` clause prevents an error.
**Rationale:** Supabase Pro grants extension creation to the `postgres` role. The migration is idempotent.

---
