# Handover — Phase 4 entry (1i.5 data backfill → BSA → collection → year-end → LPE/FME)

**Status at handover:** 2026-05-11 end-of-session. PR #1 merged to `origin/main` (commits 1i.1 through 1i.4 — role architecture rework, function-split, cross-phase audit, Tier-1 security + UI sweep). Phase 3 fully closed. Phase 4 (BSA module) is the next planned phase per the original spec roadmap, but a **Phase 1-3 retrospective gap analysis** identified six data-model gaps (G1-G6) that should be backfilled BEFORE Phase 4 commits start landing — Phase 4 + downstream phases (LPE/FME generator especially) consume them.

This document is the single-file brief for the next chat — read it cold and pick up.

---

## Where things stand on origin/main

Latest commit: `bfe8fba`. PR #1 merged via rebase merge; six commits replayed onto main:

```
bfe8fba fix(ui): RICS citation canonicalisation + 1i.2 director-exclusion propagation (audit Tier-1)
1f2b4e9 fix(security): self-auth RLS + column-grants on contractors/bank_accounts (audit Tier-1)
edd182c docs: handover note for the audit Tier-1 sweep (pre-Phase-4)
74cb82c docs: cross-phase audit + Handoff Document v1.7
f945514 feat(contractors): function-split + segregation gate -- closes 1i.3 (phase 3)
a60589f feat(auth): role architecture rework -- junction + multi-role JWT claim (1i.3 phase 1+2)
9712751 docs: handover for 1i.3 role architecture rework  ← previous origin/main
```

Live Supabase DB has migrations 00001–00030 applied. Audit Tier-1 closures verified: A-1 (self-auth RLS), A-2 (contractors column-grant), A-3 (bank_accounts column-grant); 12 of 13 Tier-1 / B-3 / B-5 findings closed; R-5 + R-6 documented; B-1/B-2/B-4/B-6/B-7/B-8 still queued for the financial-rules Edge Function lift.

---

## Phase 1-3 retrospective — gap analysis

Triggered by reviewing Blockman (the competing product) + scoping an LPE/FME pack generator inspired by build engineer's day-job pain (current LPE pack production is manual, slow, error-prone — biggest single time sink at work).

### Critical gaps — backfill before Phase 4 (data-model load-bearing)

| ID | Gap | Today | Backfill |
|---|---|---|---|
| **G1** | **Freeholders / landlords as first-class entities** | Implicit; Blockman shows "Redgrove Park Management Company Limited" as G/R Landlord; PropOS has nothing | New `landlords` table: name, address, type (`investor` / `rmc_owned` / `rtm` / `leaseholder_freehold`), companies_house_number, contact. `properties` FK to landlord. |
| **G2** | **RMC / RTM company model** | Not modelled | New `management_companies` table: name, type, companies_house_number, AGM_date, accounts_year_end, registered_office, directors JSONB (or junction). Tied to properties + landlords. Feeds future Block Manager → Secretarial / Professionals UI. |
| **G3** | **Structured lease metadata per unit** | `units` carries basic ground rent | New `unit_leases` table (versioned — lease extensions create new rows): unit_id, term_years, commencement_date, expiry_date, original_term_years, ground_rent_amount_p, ground_rent_escalation_type (`fixed` / `rpi` / `doubling` / `peppercorn` / `other`), escalation_period_years, permitted_user, sublet_consent, pet_restriction, alteration_consent, short_let_restriction, deed_of_variation_history JSONB, lease_extension_history JSONB. |
| **G4** | **Ground rent schedule** | `units.ground_rent_amount` single value | Either nested in G3 OR `ground_rent_schedules` (unit_id, period_start, period_end, amount_p, escalation_event). Recommend nesting in G3 unless complex enough to warrant separate table after schema review. |
| **G5** | **Document categorisation** | `documents` table assumed free-form | Extend `documents`: `document_type` enum (lease / gas_safety / electrical_eicr / lift_loler / fra / ews1 / asbestos_register / accounts_audited / accounts_draft / budget / insurance_schedule / insurance_summary / s20_intent / s20_estimates / s20_award / health_safety / building_safety_case / energy_performance / general). Add `include_in_sales_pack BOOLEAN`, `lpe_category` enum, `fme_category` enum. |
| **G6** | **Structured compliance items** | `compliance_items` from Phase 1; need to verify schema | Verify it has: `compliance_type` enum (matching G5), `last_inspection_date`, `next_due_date`, `frequency_interval` (interval type), `responsible_party` (`managing_agent` / `freeholder` / `rmc` / `contractor`), `certificate_document_id` FK, `lpe_relevant BOOLEAN`, `status` (`current` / `due_soon` / `overdue` / `not_applicable`). |
| **G16** | **Emergency contacts per unit** | Not modelled | New `emergency_contacts` table (unit_id, name, relationship, phone, email, role [key_holder / next_of_kin / attorney / other]). Critical for fire/flood/access. Often distinct from primary leaseholder contact. Folded into 1i.6. |
| **G17** | **Interested parties register** | Not modelled | New `interested_parties` table — mortgagees, attorneys, executors, anyone with a legal interest beyond the registered owner. **LPE-relevant** (solicitors ask about registered charges) AND **forfeiture-relevant** (pre-action protocol requires serving mortgagee). Folded into 1i.6. |
| **G19** | **Section 153 (CLRA 2002) compliance flag** | Not modelled | Per-demand boolean: has the landlord's name + address been served per CLRA 2002 s.153? Without it, demands are unenforceable. DB-enforced via CHECK or trigger on demand insert. Folded into 1i.6. |

### Important gaps — land with consumer module

| ID | Gap | Lands with |
|---|---|---|
| G7 | Disputes / FTT actions table | Phase 4c LPE generator |
| G8 | Planned major works (separate from reactive `works_orders`) | Phase 4a collection workflow + Phase 4c LPE |
| G9 | Insurance claims history | Phase 4c LPE |
| G10 | Reserve fund granularity | Phase 4b year-end |
| G11 | Forfeiture / s.146 / pre-action escalation | Phase 4a collection workflow |
| G18 | Payment mandates (DD/SO/cheque) per unit per charge-type | Phase 4a foundational schema (UI lands Phase 5) |
| G20 | Ground rent transfer-to-landlord workflow | Phase 4a |
| G24 | Demand scheduling-in-advance (issue Q1 demand on Dec 1 for Jan 1 due) | Phase 4a (extension of collection state machine) |
| G25 | Creditors / accounts payable operational view | Phase 4b |
| G26 | Previous Owners history verification | 1i.6 (verification only — may need no new table) |
| G27 | Issues tracker (separate from compliance / works) | Phase 4a / 4c (extends G7) |

### FME-specific — land with FME generator

| ID | Gap | Lands with |
|---|---|---|
| G12 | Estate assets (roads / drainage / gates / lighting / communal gardens) | Phase 4d FME generator |
| G13 | Restrictive covenants register | Phase 4d FME generator |
| G14 | Adopted vs unadopted infrastructure flags | Phase 4d FME generator |

### Phase 5 / opportunistic — surfaced by 2026-05-11 competitor-parity audit

| ID | Gap | Lands with |
|---|---|---|
| G15 | Tenants distinct from leaseholders (sublets / AST tracking / deposit handling) | Phase 5 (extends leaseholders model or new `tenancies` table) |
| G21 | Agency Service File (managing-agent ↔ block engagement — Management Agreement, SLA, fees) | Phase 5 (`agency_engagements`) |
| G22 | Professional contacts roster per block (solicitor / accountant / surveyor / insurance broker / fire consultant) | Phase 5 (`block_professionals`) |
| G23 | Company secretarial workflow (AGM minutes, director changes log, CH filing dates, statutory registers) | Phase 5 (extends G2 model) |
| G28 | Downloads / exports module (bulk export history, scheduled exports, report generation log) | Phase 5 opportunistic |
| G29 | Lessee Unit Manager (per-leaseholder cross-block view: all units, total balance, communication log) | Phase 5 |
| G30 | Settings module verification (firm settings, role assignments, charge-types, document categories) | Phase 5 (audit + tidy existing surface) |

**Locked decisions (do not re-litigate):**

- The prioritisation (critical / important / FME-specific) and phasing (1i.5 first, BSA second, LPE third, FME fourth) is signed off.
- Regulatory phase order preserved (BSA before LPE) despite LPE's higher commercial value.
- The 14-gap inventory is comprehensive enough; further gaps may surface during implementation and get folded into the relevant commit.

---

## LPE vs FME — clarify before building the generator

| | **LPE1** | **FME1** |
|---|---|---|
| Use case | Leasehold flat in managed building | Freehold house on managed estate |
| Statutory regime | LTA 1985, LTA 1987, CLRA 2002, BSA 2022 | Rentcharges Act 1977, restrictive covenants on title |
| Key party | Freeholder/landlord (separate from owner) | Owner IS freeholder; estate management company runs common parts |
| Charge | Service charge + ground rent | Estate rentcharge / estate management fee |
| Compliance docs | FRA, EWS1, gas, EICR, lift, asbestos | Limited; public liability for common parts |
| Section 20 | Mandatory >£250/leaseholder | N/A |
| BSA / HRB | Critical | Doesn't apply |
| Reserve fund | Usually present | Sometimes |
| Lease section | Full lease detail | No lease (freehold) |
| Insurance | Block buildings policy | Owner's own; pack covers estate common-parts insurance only |

Generator implementation: **shared outer shell** (cover, contents, pack admin, audit, zip mechanics) + **branches on `form_type`** for content sections. Don't try to model both as one flat form.

---

## Revised phase plan

| Phase | Scope | Rough effort |
|---|---|---|
| **1i.5** | Data backfill commit 1 (G1+G2+G3+G4): landlords, management companies, unit_leases, ground rent schedule. Migration `00031`. Smokes pinning the new tables + RLS. | ~1 week |
| **1i.6** | Data backfill commit 2 (G5+G6): document typing + compliance items tightening. Migration `00032`. May need data migration for existing `documents` and `compliance_items` rows. | ~3 days |
| **Phase 4** | BSA module — HRB compliance for buildings >18m or 7+ storeys. Closes AUDIT R-8 (BSA citation canonicalisation: pick canonical form `Building Safety Act 2022 — Higher-Risk Building`). New tables (golden thread expansion, principal accountable person, building safety case, fire/structural safety strategy). | ~3-4 weeks |
| **Phase 4a** | Collection workflow: state machine on `demands.notice_stage` (`current` → `reminder_1` → `reminder_2` → `final_notice` → `pre_action` → `solicitor_referred` → `legal_proceedings`); auto-progression via scheduled task; LTA 1985 s.20B 18-month chain DB-enforced; interest calculation table; G11 forfeiture/s.146 folds in (uses G17 interested parties for mortgagee service); solicitor escalation gated by dual-auth PA. **Also lands here:** G18 payment mandates schema (DD/SO foundational, UI deferred to Phase 5), G20 ground rent transfer-to-landlord workflow, G24 demand scheduling-in-advance, G27 issues tracker (extends G7 disputes). | ~2-3 weeks |
| **Phase 4b** | Year end + formal accounting reports (Trial Balance, Balance Sheet, Income & Expenditure). Year-end state machine on `service_charge_accounts`; immutable snapshots once finalised; reports pinned to UK GAAP small-entity form; audit-log on every report generation. G10 reserve fund granularity folds in. **Also lands here:** G25 creditors / accounts payable operational view (aging buckets, payment runs, supplier-grouped summaries). | ~2 weeks |
| **Phase 4c** | **LPE pack generator.** Pulls G1-G6 + inline G7-G9. Schema: `lpe_packs` + `lpe_pack_responses` + `lpe_pack_documents` + `lpe_pack_downloads`. AI-assist (Anthropic Claude API) for free-text drafting with strict prompts. Two-stage HITL (responses reviewed → document set confirmed → issue). Edge Function `issue-lpe-pack` generates tamper-evident zip. | ~3-4 weeks |
| **Phase 4d** | **FME pack generator.** Reuses LPE outer shell. Consumes G12-G14 + restrictive covenants + estate assets. | ~2 weeks |
| **Phase 5** | Leaseholder portal + DD/SO mandates + Document Depot UX + GDPR data-request report + Health & Safety module + remaining Tier 2 gaps from the Blockman parity list. | TBD per phase |

---

## 1i.5 — first commit detail

This is the FIRST commit to pick up in the new chat. Don't re-derive the schema before grepping; some columns may already exist that this handover doesn't know about.

### Pre-flight before writing the migration

1. **Confirm origin/main HEAD** — `git log --oneline origin/main -1` should show `bfe8fba` (audit Tier-1 commit 2 — UI sweep).
2. **Verify migration sequence** — `ls supabase/migrations/` should show `00030` as the latest. Next migration is `00031`.
3. **Grep actual schema state for the 6 gaps:**
   - `Grep "CREATE TABLE landlords\|landlords (" supabase/migrations` — expect 0 matches (G1 not present).
   - `Grep "CREATE TABLE management_companies\|CREATE TABLE rmc\|CREATE TABLE rtm" supabase/migrations` — expect 0 matches (G2 not present).
   - `Read supabase/migrations/00002_*` (or wherever `units` is defined) and list every column. Confirm what lease fields exist on `units` today (G3 / G4 baseline).
   - `Grep "CREATE TABLE documents" supabase/migrations -A 20` — confirm existing columns. Add `document_type` enum (G5) on top of existing schema, don't replace.
   - `Read` the migration that creates `compliance_items` (likely Phase 1, ~00007 or 00008). Check what fields exist; G6 may be partially covered already.
   - `Grep "ground_rent" supabase/migrations` — confirm what ground rent surface exists today on `units` or elsewhere.
4. **Confirm live DB state** — paste a Q-style query into Dashboard:
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN ('landlords', 'management_companies', 'unit_leases', 'ground_rent_schedules');
   ```
   Expect 0 rows (no backfill happened in a parallel commit).
5. **Re-read** `docs/DECISIONS.md` 2026-05-11 entry (the planning decision) before drafting the migration. The gap descriptions there are canonical.

### Plan-first gate for 1i.5

Once pre-flight is done, **stop and surface a plan** to the build engineer before writing any SQL. The plan should cover:

- Exact column lists for `landlords`, `management_companies`, `unit_leases` (and `ground_rent_schedules` if separating from G3).
- FK strategy: how does `properties` link to `landlords`? Does every existing property need a landlord backfilled, or do we allow `landlord_id` to be nullable initially?
- Migration data step: do we backfill any existing `units.ground_rent_amount` rows into the new `unit_leases` table?
- RLS for the new tables: mirror the existing pattern (firm-scoped via `auth_firm_id()`, PM-tier writes via `is_pm_or_admin()`, auditor read-only).
- Smokes to add: at minimum, RLS-rejection smokes for cross-firm access on each new table; column-grant smokes if any new tables get the segregation-style REVOKE+GRANT pattern.
- Verification queries Q1-Q5 inline at the bottom of the migration (memory rule: migration plan must include the verification query).

### Apply path

Dashboard SQL Editor per memory rule `feedback_dashboard_migration_pattern.md`. Verification queries run immediately after; paste results back before commit.

---

## 1i.6 — second commit detail

After 1i.5 lands. Migration `00032`:

**G5 — Document categorisation:**
- Add `document_type` enum to `documents` (or column with CHECK if Postgres enums feel heavy). Backfill existing rows to `'general'` initially; PM can re-categorise via UI later.
- Add `include_in_sales_pack`, `lpe_category`, `fme_category` columns to `documents`.

**G6 — Compliance items tightening:**
- Tighten `compliance_items`: verify enum, add `lpe_relevant BOOLEAN`, add `certificate_document_id` FK to `documents`. Backfill `lpe_relevant=true` for gas/electrical/lift/FRA/EWS1/asbestos rows.

**G16 — Emergency contacts:**
- New table `emergency_contacts` (id, firm_id, unit_id FK, name, relationship, phone, email, role enum [`key_holder` / `next_of_kin` / `attorney` / `other`], notes, created_at, updated_at).
- RLS: firm-scoped via `auth_firm_id()`; PM-tier writes via `is_pm_or_admin()`; leaseholder read on own unit's contacts.

**G17 — Interested parties register:**
- New table `interested_parties` (id, firm_id, property_id FK, unit_id FK [nullable for property-wide parties], party_type enum [`mortgagee` / `attorney` / `executor` / `assignee` / `chargee` / `other`], name, address, contact_phone, contact_email, legal_reference [e.g. mortgage account number — encrypted], created_at).
- RLS: firm-scoped writes by PM-tier; auditor read-everywhere; **forfeiture-relevant** so the audit log on inserts/updates matters.

**G19 — Section 153 (CLRA 2002) compliance flag:**
- Add `section_153_compliant BOOLEAN NOT NULL DEFAULT false` to `demands` (or check existing schema; may already exist as a different column).
- Add CHECK constraint or trigger: when `demands.status` transitions to `'issued'`, `section_153_compliant` MUST be true. Without it, the demand is unenforceable per CLRA 2002 s.153.
- Verification query: count of `demands` with `status='issued' AND section_153_compliant=false` (expect 0 after backfill).

**G26 — Previous Owners verification:**
- This is a *check*, not a migration. Confirm the existing `leaseholders` table has: `is_current BOOLEAN`, `transfer_date DATE`, `transfer_reason TEXT`, prior_leaseholder_id (or similar chain modelling). If yes, no migration. If no, add columns or a `unit_ownership_transfers` table.

**Smokes:**
- Verify new enum values insert/select correctly.
- `lpe_relevant` filter returns the expected rows from seed data.
- `emergency_contacts` RLS: cross-firm INSERT rejected, leaseholder read of OWN unit's contacts permitted.
- `interested_parties` RLS: same cross-firm rejection pattern.
- `demands` CHECK: insert with `status='issued' AND section_153_compliant=false` rejected (23514).

**Order matters in 1i.6:** G5+G6 first (documents + compliance — the foundation that the LPE generator pulls from), then G16+G17 (cheap schema additions), then G19 (statutory CHECK), then G26 verification (read-only, can be after the commit even).

---

## LPE/FME pack generator — full design (for Phase 4c reference)

Detailed in the 2026-05-11 DECISIONS entry. Headline points:

### Schema (lands in Phase 4c migration)

```sql
CREATE TABLE lpe_packs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               UUID NOT NULL REFERENCES firms(id),
  property_id           UUID NOT NULL REFERENCES properties(id),
  unit_id               UUID NOT NULL REFERENCES units(id),
  form_type             TEXT NOT NULL,        -- 'LPE1' | 'FME1' | 'LPE2'
  form_version          TEXT NOT NULL,
  requesting_solicitor  TEXT,
  solicitor_reference   TEXT,
  requested_date        DATE,
  issued_date           DATE,
  issued_by             UUID REFERENCES users(id),
  status                TEXT NOT NULL,        -- 'draft' | 'review' | 'issued' | 'reissued'
  fee_amount_p          INTEGER,
  fee_invoiced_at       TIMESTAMPTZ,
  sequence_number       INTEGER,              -- per-firm pack number
  data_snapshot_at      TIMESTAMPTZ NOT NULL,
  document_set_version  INTEGER NOT NULL DEFAULT 1,
  zip_storage_path      TEXT,
  zip_content_hash      TEXT,                 -- SHA-256
  zip_size_bytes        BIGINT,
  zip_generated_at      TIMESTAMPTZ,
  zip_generated_by      UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lpe_pack_responses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id           UUID NOT NULL REFERENCES lpe_packs(id) ON DELETE CASCADE,
  section           TEXT NOT NULL,
  question_key      TEXT NOT NULL,
  question_text     TEXT NOT NULL,
  response_text     TEXT,
  response_type     TEXT NOT NULL,            -- 'auto' | 'ai_drafted' | 'manual' | 'flagged' | 'na'
  source_table      TEXT,
  source_query      TEXT,
  source_row_ids    UUID[],
  reviewed_by       UUID REFERENCES users(id),
  reviewed_at       TIMESTAMPTZ,
  override_reason   TEXT,
  CONSTRAINT lpe_response_review_chk CHECK (
    (reviewed_at IS NULL) = (reviewed_by IS NULL)
  )
);

CREATE TABLE lpe_pack_documents (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id                  UUID NOT NULL REFERENCES lpe_packs(id) ON DELETE CASCADE,
  document_id              UUID NOT NULL REFERENCES documents(id),
  included                 BOOLEAN NOT NULL DEFAULT true,
  required                 BOOLEAN NOT NULL,
  category                 TEXT NOT NULL,
  document_content_hash    TEXT,
  canonical_order          INTEGER,
  zip_path                 TEXT,
  included_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lpe_pack_downloads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id         UUID NOT NULL REFERENCES lpe_packs(id),
  downloaded_by   UUID REFERENCES users(id),
  downloaded_via  TEXT NOT NULL,
  downloaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address      INET,
  user_agent      TEXT,
  signed_url_id   TEXT
);
```

### Edge Function `issue-lpe-pack`

- Deno runtime on Supabase Edge Functions
- Service-role for Storage reads; gated by JWT role check (`admin` / `senior_pm` / `accounts`)
- Verifies pack is in `status='review'` AND every response reviewed (DB CHECK is the backstop)
- Renders LPE1/FME1 form PDF from responses; generates cover letter + contents page
- Streams zip via `archiver` or Deno-native zip lib; computes SHA-256 on stream
- Uploads to `lpe-packs/<firm_id>/<pack_id>.zip` bucket
- Updates `lpe_packs` row to `status='issued'` + zip metadata
- Writes `golden_thread_audit_log` row
- Returns signed URL (24h expiry)

### Zip structure

```
PropOS_Sales_Pack_<unit_slug>_<issued_date>_PK<seq>.zip
├── 00_Cover_Letter.pdf
├── 01_Contents.pdf
├── 02_LPE1_Form.pdf      (or FME1 / LPE2)
├── 03_Lease/
├── 04_Service_Charge_Accounts/
├── 05_Current_Budget/
├── 06_Recent_Demands/
├── 07_Insurance/
├── 08_Compliance/
├── 09_Section_20_Consultations/
├── 10_Planned_Works/
└── 11_BSA/   (HRB only)
```

### Two-stage HITL

1. **Stage 1 — responses reviewed**: every `lpe_pack_responses.reviewed_at IS NOT NULL`. CHECK constraint backstops; UI shows counter "23/30 reviewed"; "Generate zip" disabled until 30/30.
2. **Stage 2 — document set confirmed**: separate panel showing every LPE2-required category with selected document. Toggle to include/exclude. Warning banner if required category empty — PM must mark "N/A" with reason before zip can generate.

### AI-assist discipline

- Strict prompt: "Only state facts present in the provided context. Do not infer. If context is empty or ambiguous, respond exactly: `INSUFFICIENT_DATA — flag for PM`."
- Structured context: pass only relevant audit-log entries / Section 20 rows / issues / compliance — not the whole DB.
- All AI drafts get `response_type='ai_drafted'`; PM must explicitly review before pack can move to `issued`. CHECK constraint is the regulatory backstop.
- Audit log preserves the AI draft even after PM override.

---

## Standing patterns to honour (from memory rules)

- **State file list + tests before writing code.** Non-trivial commits get the plan-first gate.
- **Migration plan must include verification queries.** Smokes test runtime, the catalog query tests state.
- **Never strip statutory comments.** LTA / RICS / TPI / BSA citations are required audit trail.
- **Confirm before push or merge to main.** Per-action authorisation. No standing approval.
- **Apply migrations via Dashboard SQL Editor.** Fastest, friction-light.
- **Anchor context-% estimates to the 1M harness window.** Under-estimate when guessing.
- **Worktree dev server on 5174 with `playwright.worktree.config.ts`.** Don't touch main repo's 5173.
- **Junction `app/node_modules` → main repo's** on first worktree use. `mklink /J` on Windows.
- **Worktree needs its own `.env.local`** copied from main repo (gitignored).
- **Vite needs `--host 127.0.0.1`** to bind IPv4 on Windows (Playwright targets 127.0.0.1 not localhost).
- **statutory citation as test anchor.** Same string is UI message AND smoke regex. Move them in lockstep.
- **Flag deferred items at the relevant anchor**, not just in DECISIONS.

## Standing patterns from Phase 3 Session 5 lessons (audit Tier-1)

- **REVOKE+GRANT requires trigger-grep.** Before any `REVOKE UPDATE ON table` + `GRANT UPDATE (allowlist)`, grep all triggers issuing separate UPDATEs on that table. AFTER triggers (SECURITY INVOKER) need their written-to columns in the allowlist.
- **Run the FULL smoke file covering a table after RLS predicate refinement**, not just new smokes. Predicate over-reach surfaces as regression in existing tests.
- **Worktree dev server caches OLD source under HMR on Windows + OneDrive.** Restart the dev server with `--host 127.0.0.1 --port 5174` if smokes fail citing old text after a string edit.
- **`.fixme()` over `.skip()` or deletion** for FORWARD-anchored expected breakage. Comment links to the PROD-GATE.

## Competitor-parity audit (new pattern as of 2026-05-11)

- **At every phase boundary**, do a structured competitor-parity audit pass before committing to the next phase's plan. Walk through Blockman menu-by-menu, screenshot-by-screenshot, with the current PropOS feature surface alongside. Each menu / column / button / form gets categorised as ✅ Have equivalent / 🟡 Partial / 🔴 Gap (assign Gn ID + phase tag). Output addended to the phase handover doc — even if "no new gaps surfaced".
- **The build engineer has full Blockman PM access.** Future Claude sessions doing competitor analysis SHOULD ASK for specific menu details, screenshots, or workflow walkthroughs rather than guess from memory. Asking is cheaper than missing a gap. If a screenshot shows a column or menu item whose function isn't obvious, ask before designing a parity feature around an assumed meaning.
- **The 2026-05-11 audit pass surfaced 16 additional gaps (G15-G30) after the initial 14-gap inventory was already "complete" per first-pass review** — a process gap, not a product gap. The discipline is doing the structured walkthrough; the artifact captures completeness.
- **Anchor for new chats:** memory rule `feedback_competitor_parity_audit.md` (added 2026-05-11).

---

## Out of scope for 1i.5 / 1i.6 (FORWARD anchors)

Locked deferrals — do not pull into the data-backfill commits.

| # | Item | Lands in |
|---|---|---|
| 1 | Financial-rules Edge Function (server-side segregation gate) | Phase 4 or Phase 4a |
| 2 | BSA citation canonicalisation (AUDIT R-8) | Phase 4 |
| 3 | Encrypted contractor bank-detail columns | Data-integrity / auto-protect pass (Phase 5) |
| 4 | Pre-commit hooks (5 linters) | Dedicated CI commit, opportunistic |
| 5 | Tier-3 cleanup (firmContext.role legacy, `auth_user_role()` SQL, `as any` casts) | Opportunistic |
| 6 | Multi-year financial period filter UI | Phase 4b year-end |
| 7 | Budget / forecast analysis UI | Phase 4b year-end |
| 8 | Direct Debit / Standing Order mandates | Phase 5 |
| 9 | GDPR data-request report | Phase 5 |
| 10 | Health & Safety module | Phase 5 (overlaps Phase 4 BSA naturally) |
| 11 | Document Depot UX | Phase 5 |
| 12 | Block Manager submenus (Secretarial, Professionals, Year End workflow UI) | Phase 4b + Phase 5 |
| 13 | "Re-Order Unit Position" column | Phase 5 opportunistic |

---

## Pre-flight checklist for the new chat

1. ✅ Read this handover doc cold.
2. ✅ Read `docs/DECISIONS.md` 2026-05-11 entry (the planning decision).
3. ✅ Check `git log --oneline origin/main -1` shows `bfe8fba`.
4. ✅ Confirm worktree HEAD vs origin/main alignment.
5. ✅ Grep schema for G1-G6 state (commands listed in "1i.5 — first commit detail" above).
6. ✅ Confirm 6 demo users still resolve (Dashboard: `SELECT email FROM auth.users WHERE email LIKE '%@propos.local'` → 6 rows: admin / pm / director / accounts / senior_pm / auditor).
7. ✅ Decide worktree strategy: keep this worktree (rebase on latest origin/main first), spin a new one, or work in main repo. Recommend new worktree per memory rule for isolation.
8. ✅ Stop after schema grep + 1i.5 plan; surface plan for sign-off before writing the migration.

---

## Estimated total scope to Phase 4c (LPE generator live)

- **1i.5 + 1i.6 data backfill:** ~10 working days
- **Phase 4 BSA module:** ~15-20 working days
- **Phase 4a collection workflow:** ~10 working days
- **Phase 4b year-end + reports:** ~10 working days
- **Phase 4c LPE generator:** ~15-20 working days
- **Total to LPE shipping:** ~12-15 weeks of focused build time

This is realistic single-engineer pace with Claude assist. Build engineer's day-job pain (manual LPE pack production) gets relieved at end of Phase 4c.

---

## Worth flagging for next chat

- The schema grep may reveal that some G1-G6 items are partially covered already (e.g., `compliance_items` from Phase 1 might already have `compliance_type` enum). The gap analysis is based on memory of what's been built, not a direct schema audit. The first action is to verify.
- If the schema audit reveals an existing column we don't know about (e.g., `units.lease_term_years` already exists), use it — don't duplicate.
- The 1i.5 migration should be PR'd separately from 1i.6 to keep blast radius small.
- Branching strategy: open a fresh PR per phase, merged via rebase. PR #2 = 1i.5+1i.6 bundle. PR #3 = Phase 4 BSA. Etc.
