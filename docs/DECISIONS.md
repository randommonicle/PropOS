# PropOS — Architectural Decision Log

All significant decisions are recorded here with date, context, options considered, decision made, and rationale.
Spec reference: PropOS Handoff Document v1.1 — Section 6.2.

---

## 2026-05-11 — Phase 4 planning + Phase 1-3 retrospective gap analysis

**Context:** Phase 3 closed and merged via PR #1 (commits 1i.1 through 1i.4 — role architecture rework, function-split, cross-phase audit, Tier-1 sweep). Build engineer reviewed a competitor product (Blockman) and surfaced a meaningful feature gap. Separately, a high-value product surface emerged from operational pain at the build engineer's day job: an **LPE/FME pack generator** for conveyancing. Before committing to Phase 4 (BSA module per the original spec roadmap), a retrospective on Phase 1-3 data-model coverage identified gaps that LPE/FME and BSA would both consume.

**Forms clarified (LPE vs FME):**

- **LPE1** (Leasehold Property Enquiries) — selling a leasehold flat in a managed building. Statutory regime: LTA 1985, LTA 1987, CLRA 2002, BSA 2022. Heavy on lease details, freeholder/RMC/RTM, service charge, Section 20 consultations, building compliance (FRA / EWS1 / gas / electrical / lift / asbestos).
- **FME1** (Freehold Management Enquiries) — selling a freehold house on a managed estate. Statutory regime: Rentcharges Act 1977, restrictive covenants on title, estate management schemes. Heavy on estate rentcharge, restrictive covenants, common-parts infrastructure (roads / drainage / gates / open spaces), estate management company.

The two forms share an outer shell (cover letter, contents, pack admin, audit trail, zip mechanics) but content sections diverge sharply. The generator implementation will branch on `form_type` to populate from different underlying data sources.

**Gap analysis findings (14 gaps, three tiers):**

**Critical (backfill before Phase 4 — data-model load-bearing):**

- **G1** Freeholders / landlords as first-class entities (new `landlords` table). Today implicit.
- **G2** RMC / RTM company model (new `management_companies` table). Today not modelled.
- **G3** Structured lease metadata per unit (new `unit_leases` table, versioned). Today `units` carries basic ground rent only.
- **G4** Ground rent schedule (nested in G3 or separate `ground_rent_schedules` table). Today single column value.
- **G5** Document categorisation (`documents.document_type` enum + `include_in_sales_pack` flag + `lpe_category`/`fme_category` enums). Today free-form.
- **G6** Structured compliance items (verify `compliance_items` has typed enum + dates + responsible-party + cert-document FK). Today loose per Phase 1.

**Important (could land with consumer module — Phase 4c LPE generator or Phase 4 BSA):**

- **G7** Disputes / FTT actions table. LPE Section 7.
- **G8** Planned major works (separate from reactive `works_orders`). Drives Section 20 chains + LPE Section 6.
- **G9** Insurance claims history (`insurance_claims` table). LPE Section 4.
- **G10** Reserve fund granularity (computed view or extension on existing `bank_accounts`).
- **G11** Forfeiture / s.146 / pre-action escalation. Folds into collection workflow (Phase 4a).

**FME-specific (land with FME generator — Phase 4d):**

- **G12** Estate assets (roads / drainage / gates / lighting / communal gardens).
- **G13** Restrictive covenants register per property.
- **G14** Adopted vs unadopted infrastructure flags.

**Decision (revised phase plan — regulatory phase order preserved):**

1. **1i.5** — Data backfill commit 1 (G1 + G2 + G3 + G4). Migration `00031` adds `landlords` + `management_companies` + `unit_leases` + `ground_rent_schedules`. ~1 week.
2. **1i.6** — Data backfill commit 2 (G5 + G6). Migration `00032` adds document typing + tightens compliance items. ~3 days.
3. **Phase 4** — BSA module. Original spec roadmap; HRB compliance for buildings >18m or 7+ storeys. Closes AUDIT R-8 (BSA citation canonicalisation).
4. **Phase 4a** — Collection workflow (reminders → final notices → solicitor escalation). State machine on demands; LTA 1985 s.20B 18-month chain DB-enforced; interest calculation; G11 forfeiture/s.146 folds in.
5. **Phase 4b** — Year end + formal accounting reports (Trial Balance, Balance Sheet, Income & Expenditure). Year-end state machine on `service_charge_accounts`; immutable snapshots; pinned to UK GAAP small-entity form.
6. **Phase 4c** — LPE pack generator. Pulls G1-G6 + inline G7-G9. Schema: `lpe_packs` + `lpe_pack_responses` + `lpe_pack_documents` + `lpe_pack_downloads`. AI-assist for free-text via Claude API with strict prompt discipline. Two-stage HITL (responses reviewed → document set confirmed → issue). Edge Function `issue-lpe-pack` generates a tamper-evident zip (SHA-256 + audit log).
7. **Phase 4d** — FME pack generator. Reuses LPE outer shell; consumes G12-G14 + restrictive covenants + estate assets.
8. **Phase 5** — Leaseholder portal + Direct Debit / Standing Order + Document Depot UX + GDPR data-request report + Health & Safety module + remaining Tier 2 gaps from the Blockman parity list.

**Rationale.** Regulatory phase order preserved (BSA before LPE) on the basis that BSA is a statutory requirement for HRBs while LPE is a commercial/operational deliverable — though the LPE generator carries higher commercial value (every leasehold sale × ~£200-500 fee) and addresses daily user pain. Data backfill (1i.5/1i.6) lands first so Phase 4 commits compose against a complete data model — cheaper than retrofitting tables mid-Phase-4. G7-G14 stay grouped with the modules that consume them to keep migration churn proportional to user-visible value.

**LPE/FME zip generation architecture (locked at planning):** server-side Edge Function `issue-lpe-pack`. Streams a zip containing cover letter + contents page + LPE1/FME1 form PDF (rendered from `lpe_pack_responses`) + every included document. SHA-256 of the issued zip stored on `lpe_packs.zip_content_hash` for tamper-evidence. Signed URLs with 24h expiry for solicitor download; `lpe_pack_downloads` table audits every retrieval. Required documents categorised via `documents.lpe_category` enum (lease / accounts / budget / insurance_schedule / fra / ews1 / eicr / gas_safety / asbestos / s20_intent / etc.). HITL gates enforced by DB CHECK: `lpe_pack_responses.reviewed_at IS NULL` blocks transition to `status='issued'`.

**Expanded gap inventory (added 2026-05-11 after deeper competitor-parity audit):**

A structured walkthrough of every Blockman menu / column / button / form after initial planning identified 16 additional gaps (G15-G30) not surfaced by the first-pass review. The original phase plan and prioritisation hold — these get folded in:

- **Folded into 1i.6** (data backfill commit 2): G17 Interested Parties register (LPE-relevant + forfeiture pre-action protocol), G16 Emergency Contacts per unit, G19 Section 153 (CLRA 2002) compliance flag per demand.
- **Verification only (may need no migration)**: G26 Previous Owners — confirm `leaseholders.is_current` + transfer date model supports clean ownership history per unit; if not, add minimal table.
- **Folded into Phase 4a** (collection workflow): G18 Payment Mandates (DD/SO foundational schema), G20 Ground Rent Transfer-to-Landlord workflow, G24 Demand scheduling-in-advance, G27 Issues tracker (extends G7 disputes).
- **Folded into Phase 4b** (year-end + reports): G25 Creditors / accounts payable operational view.
- **Phase 5 / opportunistic**: G15 Tenants distinct from leaseholders, G21 Agency Service File (managing-agent ↔ block engagement), G22 Professional contacts roster per block, G23 Company secretarial workflow for RMC/RTM, G28 Downloads/exports module, G29 Lessee Unit Manager (per-leaseholder cross-block view), G30 Settings module verification.

**Pattern established — competitor-parity audit at phase boundaries:**

Going forward, every phase boundary includes a structured competitor-parity audit pass. Walk through Blockman (and any other relevant benchmark) menu-by-menu, screenshot-by-screenshot, with the current PropOS feature surface alongside. Each menu item categorised as ✅ Have equivalent / 🟡 Partial / 🔴 Gap (assign Gn ID + phase tag). Output addended to the phase handover doc — even if "no new gaps surfaced, audit complete".

**Build engineer has full Blockman PM access.** Future Claude sessions doing competitor analysis SHOULD ASK for specific menu details, screenshots, or workflow walkthroughs rather than guess from memory. Asking is cheaper than missing a gap. The 2026-05-11 audit pass surfaced 16 additional gaps after the initial 14-gap inventory was already "complete" per first-pass review — a process gap, not a product gap. The new memory rule `feedback_competitor_parity_audit.md` captures this discipline.

---

## 2026-05-10 — Cross-phase audit Tier-1 sweep (commit 1i.4 — post-Phase-3, pre-Phase-4)

**Context:** `docs/AUDIT_2026-05-10.md` surfaced 31 findings across the lexical-consistency dimension after 1i.3 wrapped Phase 3. 3 CRITICAL + 9 Tier-1 + 11 Tier-2 + 8 Tier-3. The 3 CRITICAL findings (A-1 / A-2 / A-3) form one attack chain: 1i.3's widening of `is_pm_or_admin()` to include `accounts` + `senior_pm` cascaded through the RLS write policies on `payment_authorisations` / `contractors` / `bank_accounts`, but the segregation gates (self-auth, payee-setter ≠ release-authoriser, closure dual-auth) were enforced application-side only. The Tier-1 cluster is statutory-citation drift carried over from 1d / 1e / 1g.5 era code on the deprecated "RICS Client Money Rule 4.7" framing. Two non-atomic flows (B-3, B-5) carried regulatory load. The audit was deliberately written as docs-only so it could land independently of either commit; PR #1 carried the audit + 1i.3 + Handoff v1.7 onto a feature branch and the Tier-1 sweep landed stacked on top as a two-commit decomposition (1i.4 = commit 1 security + commit 2 UI/citation/B-5 wrap). Plan-first signed off via the handover doc (`docs/HANDOVER_audit_tier1.md`).

**Decision (two commits):**

1. **Commit 1 — `00030_security_audit_tier1.sql` + 3 RLS smokes.** Closes A-1 (self-auth WITH CHECK predicate on `payment_auth_update`), A-2 (column-grant REVOKE+GRANT on `contractors`), A-3 (column-grant REVOKE+GRANT on `bank_accounts`). Two corrective edits from the audit's literal SQL caught during smoke development: (a) self-auth predicate refined to gate only the authorisation moment (`status != 'authorised' OR auth.uid() IS DISTINCT FROM requested_by`) — the audit's flat `requested_by IS DISTINCT FROM auth.uid()` over-blocked cancel-by-requester, caught by the existing C-3 smoke; (b) `current_balance` AND `updated_at` granted on `bank_accounts` despite belonging to the "trigger-maintained" defensive set — both are required by the `sync_bank_account_balance` AFTER-INSERT trigger on transactions (separate UPDATE statement, SECURITY INVOKER, hits caller's column-level grant). Defence-in-depth on `current_balance` is the 00026+00027 M-1 `block_balance_writes` trigger (pg_trigger_depth-aware). 3 new smokes (C-1-new / C-2-new / C-3-new) in `security-rls.spec.ts` verify direct supabase-js rejection with code 42501. Full file at 20/20 green.

2. **Commit 2 — citation canonicalisation + B-5 try/catch + 5 deferred-flow .fixme.** Closes R-1 / R-2 (line-446 "admin and director" → "admin staff" propagation gap; 6 BankAccountsTab sites), R-3 (~14 sites across BankAccountsTab / DemandsTab / TransactionsTab / ServiceChargeAccountsTab / PaymentAuthorisationsTab: "RICS Client Money Rule 4.7" → canonical anchor key), R-4 (retention citations re-anchored to "RICS Rule 3.7 evidence trail; TPI Consumer Charter & Standards Edition 3" — Rule 4.7 was segregation, not retention; InvoicesTab line 216 re-anchored), R-5 / R-6 (00028 placeholder + stale PROD-GATE 8 + 9 — supersession documented here per append-only rule, not edited in 00028), B-5 (ReconciliationCompleteModal: audit-log write wrapped in dedicated try/catch with manual-repair SQL hint on failure — RICS Rule 3.7 evidence trail load-bearing). 4 smoke specs updated in lockstep with the UI string changes. B-3 (payee-setup half-state) closed structurally by 00030 — the contractor stamp itself now returns 42501 from `authenticated`, so the half-state attack vector can't arise; no code change needed.

**Citation anchor key established** (governs all future UI / spec / migration audit-comment statutory references):

- **Segregation / dual-auth / signatory contexts** → `RICS Client money handling — segregation of duties` (full form: `RICS Client money handling (1st ed., Oct 2022 reissue) — segregation of duties; both signatories must be staff of the firm`). Lowercase "money" — the 1d era's "Client Money" as proper noun was incorrect.
- **Retention / hard-delete prohibition / reconciled-row lock contexts** → `RICS Rule 3.7 evidence trail; TPI Consumer Charter & Standards Edition 3`. The 1st-edition RICS Client money handling document carries no stable §-numbers — the legacy `§X.X` placeholder in 00028 line 111 was a drafting artefact, not a deferred resolution.
- **Role naming** → "admin staff" (not "admin and director", not "admin or director"). RMC directors / freeholder representatives are client-side per the 1i.2 director-exclusion; the legacy phrasing was misleading.

**Known consequential breakage (PoC-acceptable, all FORWARD: PROD-GATE 1-flagged in 00030):**

- `ContractorsPage.handleSubmit:437` bank-detail edit "flip approved=false to force re-approval" → 42501.
- `BankAccountsTab` closure-flow tail-write `is_active=false` → 42501. Closure dual-auth chain ends with rejection.
- `BankAccountsTab` RICS-designation tail-write `rics_designated=false` → 42501. Same for the direct-edit flow in the protective direction.
- 5 smoke tests marked `.fixme()` with FORWARD anchors pointing to the financial-rules Edge Function: `bank-accounts.spec.ts:75/153/226`, `payment-authorisations.spec.ts:477/562`. Re-enable when the Edge Function lift performs the segregation columns' writes under service-role.

**FORWARD anchors planted by 00030 (5 total):**

1. Financial-rules Edge Function — server-side segregation gate (re-enables the 5 fixmes + the bank-detail-edit re-approval flow).
2. Re-enable bank-detail edit "force re-approval" under service-role.
3. Encrypted contractor bank-detail columns (drops the `contractors.notes` JSON stash).
4. 00028 PROD-GATE 8 + 9 stale annotation supersession (this doc + 00029 preamble pointer).
5. 00028 §X.X placeholder note (this doc).

**Rationale.** Land the regulatory-load-bearing fix (commit 1) on origin BEFORE the citation sweep (commit 2) so a citation-sweep error has the safety net of the WITH CHECK + column-grant already in place. The audit's predicate over-reach (A-1's flat `IS DISTINCT FROM`) was caught by the existing C-3 smoke during commit-1 smoke development, proving the value of running the full security-rls suite (not just the new 3 smokes) immediately after migration apply. The lesson there is generalisable: any RLS predicate refinement should run the full suite covering that table, not just the new smokes for the new predicate — predicate over-reach surfaces as a regression in existing tests that the refinement was supposed to preserve. The `current_balance` / `updated_at` over-exclusion was caught the same way (transaction INSERT failing during C-1-new fixture seed). Both corrections went in during commit-1 development; committed shape matches the live DB.

---

## 2026-05-10 — Role architecture rework + multi-role + function-split (commit 1i.3 — Phase 3 → 4 boundary)

**Context:** 1i.2 shipped Phase 3 §7 (invoices) on a PoC stand-in for the role architecture: `FINANCE_ROLES = ['admin']` only (regulatory-acceptable but architecturally incomplete). 11 `FORWARD: PROD-GATE` flags planted across `00028_invoices_status_chk.sql` queued the lift; flags 8 (function-split discriminator) and 9 (contractor-onboarding payee-stamping) close here, plus the wider role-architecture rework. The plan-first gate signed off three scope decisions before code (handover doc `docs/HANDOVER_1i3.md`):

1. **Roles to add — first-foot-forward:** `accounts`, `senior_pm`, `auditor`, `inspector`. All four land in this commit while we touch the role enum + RLS sweep.
2. **Migration shape:** Option A — `user_roles (user_id, role)` junction REPLACES `users.role`. No backwards-compat preservation of the column.
3. **Function-split scope: full** — extends `payment_authorisations.action_type` (`payment` → `payment_release`; new `payment_payee_setup`) AND rewrites `ContractorsPage.tsx` to insert a `payment_payee_setup` PA on contractor add / bank-detail edit.

Decomposed internally into three phases with apply-and-verify gates between them; a single 1i.3 deliverable when complete.

**Decision (single commit, three phases):**

1. **Migration 00029.** ~280 lines SQL, transactional. (a) `auth_has_role` / `auth_has_any_role` helpers reading `request.jwt.claims->'user_roles'` array. (b) `user_roles (user_id UUID, role TEXT, granted_at, granted_by, PK(user_id, role))` junction table; CHECK enumerates the post-1i.3 canonical role set; RLS `user_roles_self_select` (read own) + `user_roles_admin_all` (admin gates writes via `auth_has_role('admin')`). Backfill from `users.role`; idempotent. (c) `custom_access_token_hook` rewrite — emits `claims.user_roles[]` array AND `claims.user_role` legacy single-string (priority-picked from the array via deterministic ranking: admin > senior_pm > accounts > pm > others; removes the insertion-order ambiguity that `roles_v[1]` would otherwise introduce for multi-role users); active-user filter preserved. (d) `is_pm_or_admin()` widened to `auth_has_any_role(['admin','accounts','senior_pm','property_manager'])` — cascades to ~30 callers without per-policy edits. (e) RLS sweep: 9 policies that called `auth_user_role()` directly drop+recreate to call `auth_has_role()` — `firms_update`, `users_admin_all`, `properties_delete`, `compliance_director_select`, `demands_leaseholder_select`, `documents_leaseholder_select`, `s20_leaseholder_select`, `mr_leaseholder`, `tc_delete`. (f) 13 auditor read-everywhere policies on financial + audit-log tables (firm-scoped via `auth_firm_id()`); writes denied by no-policy-match. (g) 3 inspector scaffolding read policies on properties / units / leaseholders (Phase 7 inspection-app gates against this). (h) `payment_authorisations.action_type` CHECK widened: rename `payment` → `payment_release`, add `payment_payee_setup`; backfill existing `payment` rows; retarget DEFAULT. (i) `contractors.approved_by UUID REFERENCES users(id)` + `approved_at TIMESTAMPTZ` (nullable for legacy rows; the payee-setter ≠ release-authoriser gate enforced application-side, FORWARD-anchored for Edge-Function lift). (j) Drop `users.role` last — failure in any earlier step rolls back via the transaction wrapper, leaving the column intact. Five `FORWARD: PROD-GATE` flags planted: auditor-confidential-document visibility, legacy `user_role` claim removal, bulk role-assignment UI, role-grant audit log, senior_pm reconciliation re-open UI.

2. **Frontend role-helper sweep (phases 2 + 3).** `constants.ts` extends `USER_ROLES` with the 4 new roles; adds typed helpers `hasAdminRole` / `hasAccountsRole` / `hasSeniorPmRole` / `hasPmRole` / `hasAuditorRole` / `hasInspectorRole` / `hasDirectorRole` / `isStaffPmTier` / `hasAnyFinanceRole`; keeps `isFinanceRole` as a legacy alias for one transitional commit. `CRITICAL_ACTION_TYPES` renames `payment` → `payment_release` and adds `payment_payee_setup`. `authStore.FirmContext` adds `roles: UserRole[]` alongside legacy `role: UserRole`. `useAuth.ts` decodes the array claim with fallback wrapping the legacy single string for stale tokens; filters to known `UserRole` values so a forged claim with an unknown string can't surface in `firmContext.roles`. `statusTransitions.ts` accepts `roles: readonly UserRole[]` (the legacy singular signature is gone). `BankAccountsTab` / `PaymentAuthorisationsTab` / `InvoicesTab` / `ContractorsPage` consume `firmContext.roles` via the typed helpers. `hasAnyFinanceRole` widens in phase 3 from admin-only to admin OR accounts — the tier-asymmetric flip-on for the queue-for-payment + payment_payee_setup request gates.

3. **Function-split — `payment_payee_setup` (phase 3).** New pure helper `app/src/lib/contractors/payeeSetup.ts` exposes `buildPayeeSetupPA(contractor, bankDetails, requesterId, isReApproval)` and `validateProposedPayeeSetup(proposed)` (application-side shape check; DB CHECK only verifies presence). `types/database.ts` adds `ProposedPayeeSetup` + extends the `ProposedAction` discriminated union; `ProposedTransaction` gains optional `contractor_id` to feed the segregation gate. `ContractorsPage.handleSubmit` rewritten: contractor add OR bank-detail edit on existing → INSERT contractor (or UPDATE) with `approved=false` + INSERT a `payment_payee_setup` PA via the helper. The legacy "Approved contractor" checkbox is gone — approval now flows ONLY via the dual-auth PA. `PaymentAuthorisationsTab.handleAuthorise` adds the `payment_payee_setup` branch (`authorisePayeeSetup`): stamps `contractors.approved=true` + `approved_by` + `approved_at` + writes the PoC bank-detail JSON onto `notes` (production schema with encrypted columns FORWARD-anchored), then marks the PA authorised. The same handler enforces the **payee-setter ≠ release-authoriser segregation gate** for `payment_release` action_type: when `proposed.contractor_id` is set, looks up `contractors.approved_by` and rejects the authorise if it equals the current `userId`. RICS Client money handling — segregation of duties; both signatories must be staff of the regulated firm.

**Test infrastructure.** Three new auth-setup files (`auth-accounts.setup.ts`, `auth-senior-pm.setup.ts`, `auth-auditor.setup.ts`); `playwright.config.ts` setup chain extended; `supabase/seed/test_users.sql` rewritten for the junction (idempotent INSERTs into `users` + `user_roles`). Two new spec files: `security-roles.spec.ts` (~6 smokes covering JWT array shape, accounts user resolves accounts-only roles, auditor read-everywhere on 13 finance + audit-log tables, auditor write-deny via RLS rejection, director read-deny on finance-staff tables, inspector scaffold reads); `financial-payee-setup.spec.ts` (5 smokes covering CHECK accepts new types + rejects legacy `payment`, ProposedPayeeSetup validation, authorise stamps approved_by, segregation gate precondition, bank-detail edit triggers re-approval PA). Existing C-1 smoke (`security-rls.spec.ts:177`) rewritten to test the post-1i.3 attack vector (PM cannot self-grant admin via `user_roles` INSERT — RLS rejection); 4 PA smokes (`financial-payment-authorisations` + `financial-invoices`) had `payment` literals swapped to `payment_release`.

**Rationale.** Closes 1i.2 PROD-GATE flags 8 + 9 + the wider role architecture before Phase 4 (BSA module) so the BSA gates can compose against the multi-role + dedicated `accounts` role from day one. Junction table is structurally cleaner than a JSON column on `users` (FK cascade on user delete; trivially queryable; ON CONFLICT idempotent for grants). The deterministic priority ordering on the legacy `user_role` claim removes a class of subtle bugs that would have surfaced for multi-role users during the transition. The function-split closes the regulatory hole the 1i.2 admin-only stand-in left open: today's two-distinct-admins flow is technically RICS-compliant but doesn't model the segregation of payee-setup from payment-release, which is the binding rule. Stamping `approved_by` makes the gate auditable post-hoc — every release authoriser appears in `payment_authorisations.authorised_by`, every payee setter appears in `contractors.approved_by`, and the equality compare is the smoking-gun assertion. PoC compromise: bank details stash on `contractors.notes` as a structured JSON line; production-grade encrypted columns + dedicated payee schema land in the data-integrity / auto-protect pass (FORWARD-anchored). PoC compromise on the segregation gate: enforced application-side in `handleAuthorise`; an Edge-Function lift to server-side enforcement is the same FORWARD anchor as the existing financial-rules Edge Function (DECISIONS Security-smoke pass items 2 + 5).

---

## 2026-05-10 — Invoices CRUD with AI extraction (commit 1i.2 — closes Phase 3 §7)

**Context:** Closes the final Phase 3 spec §7 deliverable — "invoice management with AI extraction". The build pulls together the per-property tab pattern from 1d / 1e / 1g / 1h, the dual-auth machinery from 1f / 1g, the Edge Function pattern from Phase 2 dispatch-engine, and the document vault upload pattern from Phase 1. Two regulatory clarifications from the user during plan-first negotiation reshape the scope:

1. **PM-confirmation is mandatory regardless of AI confidence.** AI confidence is informational; PM Confirm is the only gate from `received` to `approved`. Even at confidence = 1.00 the invoice stays in `received` until the PM clicks Confirm.
2. **`director` role is dropped from staff finance gates.** Research-verified against RICS *Client money handling* (1st ed., Oct 2022 reissue) + RICS Service Charge Residential Management Code 4th ed. (effective 7 April 2026) + TPI Consumer Charter & Standards Edition 3 (effective 1 Jan 2025): both signatories on a managing-agent client-account withdrawal must be staff of the regulated firm. RMC directors / freeholder representatives are CLIENT-side and explicitly excluded. The previous `FINANCE_ROLES = ['admin', 'director']` was a latent regulatory bug — corrected to `['admin']` in this commit.

**Decision:**

1. **Migration 00028.** Three CHECK constraints on `invoices`: `invoices_status_chk` locks the canonical six values from 00005:204 (`received|approved|queued|paid|disputed|rejected`); `invoices_extraction_pair_chk` mirrors the 1i.1 §M-4 audit-stamp coherence pattern (`extracted_by_ai = true` ⇔ `extraction_confidence IS NOT NULL`); `invoices_amount_coherence_chk` locks the spec §6.4 integer-pence arithmetic (`amount_gross = amount_net + COALESCE(vat_amount, 0)` when all three set). Eleven `FORWARD: PROD-GATE` flags planted at the bottom of the migration covering: per-property spend cap, director-approval queue extension, INSERT-trigger-fires-Edge-Function, DAILY_AI_COST_CAP_GBP enforcement, status-transition trigger, INSERT-only `invoices_audit_log`, contractor_id FK constraint, function-split discriminator (research finding F5), contractor-onboarding payee-stamping (F5 sister), BSA HRB Accountable Person sign-off lane (F4), bank-side dual-auth mandate (F6).

2. **Edge Function `document_processing/index.ts` (spec §5.7).** PoC client-invoked via `supabase.functions.invoke('document_processing', { body: { document_id } })` after the InvoicesTab uploads to Storage and inserts the `documents` row. The function downloads the file, calls Anthropic with the runtime model from `ANTHROPIC_RUNTIME_MODEL` (defaults `claude-sonnet-4-6`), parses a strict-shape JSON response (8 fields + confidence + notes), writes back to `documents.ai_extracted_data` + `documents.ai_processed_at`, and inserts/updates the linked `invoices` row stamping `extracted_by_ai=true` + `extraction_confidence` + `extraction_notes`. Error handling is **stage-tagged**: `{ ok: false, stage, message }` per `ExtractionStage` ('invoke' | 'document_load' | 'storage_download' | 'anthropic_call' | 'extraction_parse' | 'documents_update' | 'invoices_upsert'). The client surfaces the stage verbatim ("AI extraction failed at stage: anthropic_call. <message>") so the PM can distinguish recoverable from non-recoverable failures.

3. **`InvoicesTab` — 10th per-property tab.** Drag-drop / file-picker upload (PDF / PNG / JPG, ≤10 MB) drives the AI extraction flow; the drawer auto-opens with extracted fields once `document_processing` resolves. "Create blank invoice" preserves the manual path for invoices without scans. Confidence pill is informational: green ≥0.9, amber ≥0.75 (`AI_CONFIDENCE_REVIEW_THRESHOLD`), destructive <0.75 — paired with an amber "Low confidence — verify all fields" banner when below the threshold. PM Confirm action (`received → approved`) is the only path out of `received`. Queue-for-payment (`approved → queued`) is the finance-only action; it inserts a `payment_authorisations` row with `action_type='payment'` and `proposed.invoice_id` populated, then flips the invoice to `queued`. The `queued → paid` edge is reached **only** by the dual-auth PA authorise flow in `PaymentAuthorisationsTab`, never by direct status edit.

4. **`PaymentAuthorisationsTab.authorisePayment` extension.** When a PA's `proposed.invoice_id` is set, the authorise handler now performs a third write after (a) `transactions.insert` and (b) PA `update`: (c) `invoices.update({ status: 'paid', transaction_id })`. Non-atomic with (a) and (b); recoverable manually if (c) fails (the error message names the exact repair SQL). The `handleReject` handler also reverts `invoices.status` from `queued` to `approved` when an invoice-linked PA is cancelled / rejected, preventing the invoice from being stranded in `queued` with no path forward.

5. **Status state machine — role-tier gating.** A new `app/src/lib/invoices/statusTransitions.ts` module locks the legal edges + the role-gating per edge:
   - **PM (`property_manager`)** drives: `received → approved` (Confirm), `any → disputed`, `any → rejected`, `disputed → received`, `rejected → received` (re-review path).
   - **Finance role (today: admin only)** drives: `approved → queued` (Queue-for-payment), `any → disputed`, `any → rejected`. Finance does NOT drive Confirm or re-review (PM-only — preserves audit trail of original decision).
   - The `queued → paid` edge is **not callable** from the helper — the PA authorise flow is the only path.
   - `rejectionMessageForTransition(role, from, to)` returns null on success or a human-readable string on failure; the same string is the inline error AND the audit-trail anchor (statutory-citation-as-test-anchor pattern from LESSONS Phase 3 sessions 2 / 3 — extends RICS Client money handling citations).

6. **`isFinanceRole` narrowed: `['admin', 'director'] → ['admin']`.** Closes a latent regulatory bug present since 1d.1. Director was wrongly included in the staff dual-auth gate; a CLIENT-side director cannot stand in as a signatory on a managing-agent client-account withdrawal. Tooltip strings, doc comments, and tab descriptions in `BankAccountsTab` + `PaymentAuthorisationsTab` updated. Smoke `financial-payment-authorisations` cross-user authorise still passes (admin authorising PM-initiated PA); director-related test paths (none specifically) were unaffected. The change is invisible to users today (no firm has a director seeded as staff in PoC); becomes load-bearing the moment a real firm with both directors and admins is onboarded.

7. **Type extension: `ProposedTransaction.invoice_id`.** Optional UUID. Populated by `InvoicesTab.handleQueueForPayment`; null for PAs created from `TransactionsTab`. The PA tab's authorise handler reads it to drive the cross-write to `invoices`. Not propagated into a separate `action_type` value (e.g. `'invoice_payment'`) because the authorise flow is identical to the existing `'payment'` flow — all that changes is the optional cross-write to `invoices`. Function-split discriminator (research F5: `'payment_payee_setup'` vs `'payment_release'`) is the natural follow-up; PROD-GATE flag planted in 00028.

8. **Out of scope (deliberate, FORWARD anchors planted across 11 PROD-GATE flags in 00028).**
   - Per-property invoice spend cap + director-approval queue (DECISIONS 2026-05-10 forward entry — held for post-Phase-3 successor commit).
   - INSERT trigger on documents row firing `document_processing` automatically (PoC client-invokes).
   - DAILY_AI_COST_CAP_GBP per-firm enforcement (Phase 5+).
   - Status-transition trigger (server-side legality enforcement at DB layer; financial-rules Edge Function commit).
   - INSERT-only `invoices_audit_log` (Data-integrity / auto-protect pass commit).
   - `invoices.contractor_id` FK constraint (Phase 5 contractor-onboarding revisit; pairs with the function-split semantic).
   - Function-split discriminator (`payment_payee_setup` / `payment_release`) on `payment_authorisations.action_type` (1i.3 — role architecture rework).
   - Multi-role membership + dedicated `accounts` role (1i.3 — see forward entry below).
   - BSA HRB Accountable Person sign-off lane on major-works invoices (Phase 4).
   - Bank-side dual-auth mandate (Phase 8 self-host package operational doc).
   - PDF preview rendering inside the drawer (Phase 6 reporting commit).
   - C-4 storage RLS for `documents.is_confidential` — leaseholder portal commit (Phase 5).

**Smokes (16 in `financial-invoices.spec.ts`; 14 active + 2 .skip).** Active count: **119 → 133** (12 net new — 14 active minus 1 already-running and 1 that retires no smoke). Two skipped by default to avoid Anthropic spend on every run; toggle skip when validating live deploy. Coverage:

| # | Smoke | Asserts |
|---|---|---|
| 1 | Invoices tab is the 10th tab | `tabs.nth(9)` text + URL `?tab=invoices` |
| 2 | Manual create persists with `extracted_by_ai=false` | DB row state |
| 3 | AI-extracted invoice — drawer prefills + green pill at 0.95 | Confidence pill present; banner absent |
| 4 | AI extraction failure surfaces stage in UI | `.skip` (live Edge Function) |
| 5 | Confidence < 0.75 surfaces amber banner | Banner visible, "55%" + "Low confidence" |
| 6 | PM edit appends "PM-overrode" to extraction_notes | DB row notes contains override line |
| 7 | received → approved via Confirm stamps approved_by + approved_at | DB row + drawer-close signal |
| 8 | DB CHECK rejects status='banana' | 23514 + `invoices_status_chk` |
| 9 | PA authorise on invoice-linked payment → invoice paid + transaction_id | DB row + transactions.invoice_id |
| 10 | Delete blocked by FK 23503 when transaction references invoice | Inline error + row preserved |
| 11 | CHECK rejects extracted_by_ai=true with NULL confidence | 23514 + `invoices_extraction_pair_chk` |
| 12 | CHECK rejects gross ≠ net + vat | 23514 + `invoices_amount_coherence_chk` |
| 13 | PM confirm mandatory at confidence=1.0 | Status stays `received`; Confirm button visible |
| 14 | Queue-for-payment creates PA + invoice → queued | DB rows + proposed.invoice_id populated |
| 15 | PM cannot drive invoice → paid (no UI affordance) | No "Paid" option; queue button only |
| 16 | LIVE Edge Function pipeline | `.skip` (manual deploy verification) |

**Regulatory citation hygiene (research-driven).** RICS *Client money handling* (1st ed., Oct 2022 reissue) is the binding standard for dual-auth on client-account withdrawals — no monetary threshold; segregation between payee-setup and payment-release functions; both signatories must be staff of the firm. RICS Service Charge Residential Management Code 4th edition is effective 7 April 2026 (NOT September 2025 — corrected from earlier plan). TPI Consumer Charter & Standards Edition 3 effective 1 January 2025 reinforces. Tooltip strings + audit-trail anchors updated to cite "RICS Client money handling — segregation of duties; both signatories must be staff of the firm" rather than the previous "RICS Client Money Rule 4.7" framing (which was approximate and may have been mis-numbered — section verification carried as a forward cleanup item).

**Rationale:** Closing Phase 3 today on the `admin`-only dual-auth stand-in is regulatory-acceptable (two distinct people = compliant under RICS Client money handling) but architecturally incomplete (the function-split between payee-setup and payment-release is not modelled, nor is the multi-role membership requirement). Both gaps are flagged across 11 PROD-GATE anchors and lift in 1i.3. The PM-confirm-mandatory gate is the load-bearing PoC behaviour: it means an AI hallucination at 100% confidence still requires human verification before an invoice can move toward payment — the PoC is safe to demo to a regulated customer on this dimension. The role-tier asymmetry (accounts → admin) is good practice not regulation; lifting it in 1i.3 (with the dedicated `accounts` role + multi-role + RLS sweep) restores firm-side process control without changing the regulatory posture this commit achieves. The InvoicesTab + Edge Function shape mirrors the document-vault upload pattern and the Phase 2 Edge Function deploy convention — no new architectural surface, just the bridging glue between document_type='invoice' uploads and the existing dual-auth queue.

---

## 2026-05-10 — Forward: 1i.3 — Role architecture rework + multi-role + tier-asymmetric dual-auth (forward-looking)

**Context:** PropOS today gates regulated-finance actions on a single `users.role TEXT` column. Two requirements surfaced during 1i.2 plan-first negotiation cannot be satisfied by that shape:

1. **Multi-role membership.** A partner at the firm may legitimately hold both `accounts` and `admin` privileges. The single-column model cannot represent overlapping roles. The dual-auth gate (two distinct *people*) still holds because the self-auth guard checks `user_id`, not role intersection — but the role-tier-asymmetric gate (`accounts` initiates; `admin` releases) needs a way to ask "does this user hold admin?" independently of "does this user hold accounts?".
2. **Dedicated `accounts` role.** Today the closest staff role between `property_manager` and `admin` does not exist — finance staff who upload invoices and provide the first-leg auth on payment runs are forced into either `admin` (over-privileged) or `property_manager` (under-privileged). 1i.2 ships `admin`-only as a PoC stand-in and plants PROD-GATE anchors at every relevant code site.

**Decision (forward-looking — no code in this commit):**

When 1i.3 lands as the closing commit before Phase 4, it should cover:

1. **Migration 00029** — `user_roles (user_id UUID, role TEXT, PRIMARY KEY (user_id, role))` junction table; backfill from existing `users.role` (one row per user); add the `accounts` role to the canonical set; drop `users.role` only after all consumers updated. Foreign-key cascade on user delete.
2. **JWT custom-access-token hook update** — build a `user_roles[]` array claim instead of the single `user_role` string. `auth_user_role()` deprecated in favour of `'admin' = ANY(auth_user_roles())` patterns in RLS predicates.
3. **`useAuth.ts` rewrite** (sister to the 1i.1 H-7 fix) — read the array claim from JWT; expose the array as `firmContext.roles: string[]` not `firmContext.role: string`.
4. **Role-helper split** — `isFinanceRole` deprecated in favour of `hasAccountsRole(roles)`, `hasAdminRole(roles)`, `hasAnyFinanceRole(roles)` (= accounts OR admin). Every consumer touched: `BankAccountsTab`, `PaymentAuthorisationsTab`, `InvoicesTab`, anywhere `firmContext.role` is read.
5. **Mechanical RLS sweep** — every policy that filters on role gets the `ANY(auth_user_roles())` rewrite. Comparable in shape to 1i.1's C-2 30-policy sweep; same drop+recreate rhythm; same Dashboard SQL Editor false-positive note (LESSONS Phase 3 session 4).
6. **Tier-asymmetric gate flips on** — `InvoicesTab.handleQueueForPayment` requires `hasAccountsRole`; `PaymentAuthorisationsTab.handleAuthorise` for `action_type='payment'` requires `hasAdminRole`. Self-auth guard unchanged. PROD-GATE anchors planted in 1i.2 across `constants.ts`, `BankAccountsTab.tsx`, `PaymentAuthorisationsTab.tsx`, `InvoicesTab.tsx`, `00028_*.sql` lift in this commit.
7. **Function-split discriminator** — `payment_authorisations.action_type` CHECK widened to include `'payment_payee_setup'` (creating/changing the payee bank details on a contractor record) and `'payment_release'` (the actual money-out auth — the existing `'payment'` value renames here). Maps to RICS *Client money handling* binding rule. Pairs with item 8.
8. **Contractor-onboarding payee-stamping** — `contractors` table gains `approved_by UUID REFERENCES users(id)` + `approved_at TIMESTAMPTZ`. The PA authorise handler enforces `authoriser_id != contractor.approved_by` (a stronger gate than `user_id != requester_id`).
9. **Smokes** — ~10–12 new smokes covering: multi-role assignment via junction, queue-as-accounts, authorise-as-admin, queue-as-admin-only-rejected (mirror of the post-1i.3 prohibition), multi-role-person-cannot-self-dual-auth, RLS read-scope unchanged under array claim, JWT-claim shape, function-split discriminator on PA insert, payee-setter ≠ authoriser gate.

**Sequencing.** 1i.3 is the natural pre-Phase-4 commit because Phase 4 (BSA module) will gate features on roles and benefits from the multi-role model from day one. Doing the role architecture rework before Phase 4 is cheaper than retrofitting. Plan-first gate produces full file list + smoke list before code, comparable in shape to 1i.1 (which closed 12 of 38 audit findings in one commit).

*FORWARD: this entry is the canonical scope for 1i.3. Every PROD-GATE flag planted in 1i.2 referencing "1i.3" maps back to a numbered item above.*

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

## 2026-05-10 — Reconciliation 1h.3: completion + £0.01 balance gate + suspense override

**Context:** 1h.1 + 1h.2 left periods in `status='open'` with imports in `status='matched'` and every statement row holding a final disposition (`matched` / `suspense` / `rejected`). 1h.3 closes the period: `ReconciliationCompleteModal` runs the four spec-mandated pre-flight checks, captures the carry-forward override + completion notes when open suspense items dated within the period exist, writes the four state mutations (period, bank account `last_reconciled_at`, import `status='complete'`, audit log row), and the period becomes immutable from the UI. This commit closes Phase 3's substantial reconciliation work; the only Phase 3 piece remaining is invoices CRUD with AI extraction.

**Decision:**

1. **Pre-flight checks lock to spec §5.3 verbatim.**
   - `unmatched_count == 0` — every statement row has a final disposition. The check uses the live `bank_statement_imports.unmatched_count` rather than re-walking `raw_data`, so it reflects the current persisted state.
   - Every transactions row in `[period_start, period_end]` on this `bank_account_id` has `reconciled = true`. PoC computes this client-side; a PROD-GATE flag points at the financial-rules Edge Function.
   - `bank_accounts.current_balance == SUM(transactions.amount)` within £0.01 (1p tolerance — spec is explicit: "If they differ by more than £0.01 the system blocks completion and surfaces the discrepancy"). The discrepancy message names "Spec §5.3" verbatim so the smoke 14 anchor is statutory + spec.
   - If open `suspense_items` dated within the period exist, the override card surfaces — completion is permitted only with `carry_forward = true` AND non-empty `completion_notes`. The DB `recperiod_carryforward_notes_chk` CHECK enforces the same invariant at the DB layer.
2. **Submit writes four mutations (non-atomic, recoverable).** In order: (a) `reconciliation_periods` → `status='completed'`, audit columns stamped, `closing_balance_snapshot` captured, carry-forward fields populated; (b) `bank_accounts.last_reconciled_at = now()` per spec §5.3 ("updated when the PM clicks 'Mark reconciliation complete'"); (c) `bank_statement_imports.status='complete'` (the final state of the existing schema enum); (d) `reconciliation_audit_log` row with `action='completion'`, full before/after state JSON, notes citing RICS Rule 3.7 + the carried-forward count if applicable. Failure between (a) and (d) leaves the period closed but the audit-log row missing — a real but rare partial-failure mode that PROD-GATE flag #7 (atomic Edge Function wrap) addresses.
3. **`closing_balance_snapshot` is captured from `bank_accounts.current_balance`** at completion time — i.e. the trigger-maintained value (not the `SUM(transactions.amount)` computation). Under normal flows the two are equal; the £0.01 gate enforces that. Capturing the trigger value preserves the trigger as the system-of-record for balances, which the data-integrity / auto-protect pass relies on.
4. **"Mark complete" button on the per-account row.** Surfaces only when `openPeriod && openPeriodImport && import.status in ('matched', 'complete')`. Distinct from the "Continue reconciliation" button — PMs can complete without re-entering the review modal once matching has finished. Once the period is completed there's no `openPeriod` so neither button surfaces; only the green "Reconciled to <date>" badge plus the "Start reconciliation" button (for the next period) appears. This is the smoke 17 immutability anchor.
5. **Period overlap protection (smoke 2b).** The partial unique index `uq_recperiod_one_open_per_account ON reconciliation_periods(bank_account_id) WHERE status='open'` (00025) blocks any second open period on the same account. The smoke is a pure-DB test (direct supabase-js insert returns code 23505); the UI wraps this in a friendly message. Completed periods may overlap historically — the index is partial deliberately, supporting the typical pattern where period N completes while period N+1 has already opened with overlapping date ranges for boundary transactions.
6. **`TransactionsTab` file docstring updated.** Rule 4 previously said "the only path to undo a reconciliation is the bank reconciliation workflow (deferred to its own commit)". Updated to point at the actual commits + components (1h.1 / 1h.2 / 1h.3 with module references) and notes that re-reconciliation is deferred. Comment-hygiene pattern from the 1g.6 entry — keeps cross-file regulatory citations honest.
7. **Out of scope (deliberate, FORWARD anchors planted).**
   - Atomic transactional wrap of completion — `FORWARD: PROD-GATE` in `ReconciliationCompleteModal.tsx` header. Production-grade gate manifest item 7.
   - DB-layer post-completion immutability (BEFORE-UPDATE trigger rejecting any mutation when `OLD.status='completed'`) — already flagged in `00025_*.sql`. Production-grade gate manifest item 4.
   - Re-reconciliation flow (un-mark a reconciled txn, re-open a closed period) — `FORWARD: PROD-GATE` flag in `ReconciliationTab.tsx` header (carried forward from 1h.1).
   - Per-firm authorised override of suspense-carry-forward (require admin approval before a PM may carry forward) — recorded only here; rare enough to wait until a real customer asks.

**Smokes (6 added).** Active count: 102 → 108.
- `Completion blocked when unreconciled transactions remain in period` — pre-flight `pf-unreconciled` shows ok=false, submit disabled, period stays open.
- `Completion blocked with >£0.01 balance discrepancy` — direct `UPDATE` on `bank_accounts.current_balance` to inject divergence (the trigger fires only on transactions changes, so this bypass is allowed); pre-flight surfaces "Discrepancy of £1.00" + "Spec §5.3 blocks completion".
- `Completion succeeds with no suspense — period completed + audit row + last_reconciled_at` — verifies all four mutations: period status, last_reconciled_at, import status='complete', audit row with `RICS Rule 3.7` + `no carried-forward suspense` substrings.
- `Completion with open suspense in period requires completion_notes` — checkbox + textarea state machine (submit disabled until both filled); after save: `suspense_carried_forward=true`, `completion_notes` persisted, audit notes contain the literal "1 suspense item(s) carried forward" string.
- `Completed period is immutable — Mark complete button absent on completed rows` — drives a period to completed via direct DB writes (faster than UI), then checks the tab shows "Reconciled to" badge + no `recon-complete-<id>` testid.
- **Smoke 2b** — `Cannot create a second open reconciliation_period for the same bank account`. Pure-DB. Inserts one open period, then attempts a second — expects PostgreSQL error code `23505`. Locks the partial unique index from 00025.

**Phase 3 status after this commit:** 108/108 smokes passing. Phase 3 deliverables remaining per spec §7: invoice management with AI extraction (separate commit). Bank reconciliation engine (the substantial Phase 3 piece) is now complete. The Production-grade gate manifest carries 12 PROD-GATE entries across the reconciliation module, all anchored at code locations (file headers, migration headers, component bodies) with grep-able tags.

**Rationale:** Splitting completion into its own commit keeps the diff readable and the smoke surface focused. Capturing `closing_balance_snapshot` from the trigger-maintained `current_balance` (rather than the SUM-from-transactions computation) preserves the trigger as the single source of truth — anything else creates two competing balance authorities, which the spec §5.6 rule ("never a manually set figure") forbids by implication. The pre-flight is hard rather than soft: blocked checks disable the submit button entirely, preventing a PM from accidentally completing a period with un-disposed work; this is consistent with the SCA finalised lock + demand paid lock + reconciled lock established in 1c / 1d / 1e — completion is terminal and merits the same treatment. The smoke 2b pure-DB test (rather than a UI test) is correct here because the protection lives at the DB layer; testing the UI's friendly-message wrapping would test something less load-bearing than the index itself.

---

## 2026-05-10 — Tier-1 security hardening (commit 1i.1)

**Context:** End-of-Phase-3 deep architectural security audit (`docs/SECURITY_AUDIT_2026-05-10.md`, commit `ee99a95`) identified 38 findings across the codebase, including 4 CRITICAL items rooted in a single mechanical gap: 30 of 33 RLS `FOR ALL USING` policies in 00012 + 00025 lacked paired `WITH CHECK` clauses, opening a cross-firm `firm_id` mutation primitive that compounded into a privilege-escalation chain (C-1 + H-7) and an audit-trail destruction surface (C-3). The audit's §5 Tier-1 fix bundle is the canonical scope for the system to reach a "safe to demo to a regulated customer" baseline. The canonical scope for the security-smoke surface is the existing `2026-05-10 — Security-smoke pass` forward entry, extended by the audit's §6 with three specific RLS gaps (C-1 mutation, C-2 firm_id transfer, C-3 audit-log DELETE).

**Decision:**

1. **Single migration `00026_security_hardening.sql`** lands the DB-layer Tier-1 fixes:
   - **C-1**: column-grant restriction on `users` UPDATE (`REVOKE UPDATE` + `GRANT UPDATE (full_name, phone)`) plus `users_update_self` rewritten with `WITH CHECK (id = auth.uid())`. Closes the privilege-escalation primitive at its source — anything new added to `users` later is denied by default per the audit's "most defensive" recommendation.
   - **C-2**: drop + recreate every `FOR ALL USING` policy with paired `WITH CHECK` matching the `USING` predicate. 28 policies in 00012 + 2 policies in 00025 + the `users_admin_all` policy. Mechanical sweep; closes the cross-firm `firm_id` mutation primitive that several other findings depended on.
   - **C-3**: split four audit-trail tables. `reconciliation_audit_log` and `golden_thread_audit_log` → SELECT + INSERT only (no UPDATE/DELETE policy at all; RLS rejects both for every authenticated role). `dispatch_log` and `payment_authorisations` → SELECT + INSERT + UPDATE (no DELETE) per audit's "judgement call: state-tracking too" note. RICS Rule 3.7 evidence-trail compliance enforced at the RLS layer rather than by convention.
   - **M-1**: `block_balance_writes()` BEFORE-UPDATE trigger on `bank_accounts.current_balance`. Defence-in-depth on the `sync_bank_account_balance` trigger contract (00005:145).
   - **H-2**: `pm_messages_self` rewritten with `firm_id = auth_firm_id()` predicate. Closes cross-firm message-planting vector.
   - **H-4**: four leaseholder-scoped subselects (`documents_leaseholder_select`, `demands_leaseholder_select`, `s20_leaseholder_select`, `mr_leaseholder`) gain `is_current = true` filter. Closes historical-leaseholder document access.
   - **M-3**: `transactions_sign_type_chk` CHECK constraint locks the sign-vs-type contract the UI already enforces.
   - **M-4**: `pa_authorised_pair_chk` + `pa_rejected_triple_chk` CHECK constraints on `payment_authorisations` enforce audit-stamp coherence.
2. **Fixup migration `00027_fix_m1_trigger_recursion.sql`** — caught by the smoke suite. The 00026 `block_balance_writes()` function fired on every UPDATE that changed `current_balance` including the legitimate UPDATE issued by `sync_bank_account_balance()` on every transactions write. Result on first smoke run: 23 failures across the financial suite (all transactions writes blocked). Fix: gate the rejection on `pg_trigger_depth() = 1` — top-level user UPDATE rejected; nested-trigger UPDATE allowed. Threat model unchanged (a `supabase-js .update()` call from a PM still trips depth = 1). LESSONS entry recorded (LESSONS Phase 3 session 4 — BEFORE-UPDATE triggers on trigger-maintained columns).
3. **App-side `useAuth.ts` rewrite for H-7.** `loadFirmContext` now decodes the access-token JWT to source `firm_id` and `user_role`, instead of re-querying `public.users`. Restores the JWT-as-source-of-truth model (DECISIONS 2026-05-07 — JWT hook is SECURITY DEFINER; the JWT hook is the authoritative source). The latency before a role change propagates (up to `jwt_expiry`s = 600s post-1i.1) IS the security guarantee — with the OLD pattern, a C-1 exploit was reflected immediately client-side too, undoing the defence-in-depth.
4. **Config flips for H-1 + H-3.** `supabase/config.toml`: `enable_signup = false` (admin-driven user creation only, per DECISIONS 2026-05-10 — Test users seed pattern), `enable_confirmations = true`, `jwt_expiry = 600` (10-minute post-revocation window for offboarded users — was 3600). The Dashboard sibling toggle (Auth → Providers → Email → Allow new users to sign up) MUST also be flipped OFF for the live project; `config.toml` only governs the local CLI shadow. Documented inline in the file.
5. **Smoke spec hygiene for H-6.** `app/tests/smoke/_env.ts` helper exports `requireEnv()` that throws at module load if `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is unset. Sweep across **11 spec files** (audit said 5; grep showed 11 — six `financial-*` plus `contractors`, `compliance`, `property_detail`, `works`, `properties`) replaces every `process.env.X ?? '<publishable-key-fallback>'` with the helper. `app/tests/cleanup.mjs` (which inlined both URL + key with no fallback) gets the same treatment with an inline check (no `_env.ts` import — it's `.mjs`). `playwright.config.ts` gets a tiny inline `.env.local` parser (no `dotenv` dependency added) so the smoke runner picks up the env without manual shell setup.
6. **`security-rls.spec.ts` — 12 new smokes.** Canonical scope: the existing Security-smoke pass forward entry's bullets that are addressable now (cross-firm read scope via "every row carries my firm_id" assertion, plus the audit's §6 additions). What's covered: 3× C-1 (mutation rejected on role + firm_id, positive control on `full_name`), 3× C-2 (UPDATE + INSERT rejection on three financial tables), 2× C-3 (DELETE rejection on `reconciliation_audit_log` + `golden_thread_audit_log`; DELETE rejected + UPDATE permitted on `payment_authorisations`), 1× RLS read scope, 1× M-1 trigger, 1× M-3 CHECK, 1× M-4 CHECK. What's deferred to the financial-rules Edge Function commit: Security-smoke pass items 2 (self-auth bypass via direct DB), 4 (hard-delete audit signal — needs Phase 5 audit log), 5 (authority-limit bypass), 6 (storage scoping — Phase 5 leaseholder portal). Plus full cross-firm read isolation (needs second-firm fixture seeded via service-role; FORWARD).
7. **Smoke 14 retired.** The `Completion blocked with >£0.01 balance discrepancy` smoke in `financial-reconciliation.spec.ts` injected divergence via direct UPDATE on `bank_accounts.current_balance` — the M-1 trigger now blocks that path. Replacement is `security-rls.spec.ts` smoke 10 (`M-1 — direct UPDATE … is blocked by trigger`). The £0.01 gate becomes belt-and-braces; gate component logic is left in place defensively. FORWARD: PROD-GATE — when the financial-rules Edge Function lands, revisit whether the gate's pre-flight check warrants its own smoke against an Edge-Function-injected divergence path.
8. **`AuthGuard` "no firm context" UX banner deferred.** Today: authenticated-but-unprovisioned users hit the `Loading…` state and redirect to `/login` on next refresh. Adequate but not friendly. FORWARD anchor planted in `AuthGuard.tsx` header pointing at audit §H-7 + this entry.
9. **`users_select_self` policy provenance flagged.** Post-migration verification query revealed an extra `users` policy (`users_select_self`, cmd=r, USING `id = auth.uid()`) not written in 00012. Almost certainly added by one of the JWT hook migrations (00013–00016). Harmless (SELECT-only, narrowly scoped) but breaks the LESSONS Phase 1 "single migration to reason about RLS" model. FORWARD: identify the source migration, document, and either consolidate into 00012 in a later cleanup or formally split RLS into per-table sections.
10. **Audit findings closed in this commit (12):** C-1, C-2, C-3, M-1, M-3, M-4, H-2, H-4, H-7, H-6, H-1, H-3. Audit document executive-summary status flipped accordingly. **C-4 (storage RLS for `documents.is_confidential`) explicitly remains OPEN with FORWARD: PROD-GATE anchors at the bottom of `00026_*.sql` and at `00017_storage_rls.sql`** — Tier-2 per audit §5; lands with the Phase 5 leaseholder-portal commit. The exposure is theoretical today (no leaseholder users seeded) but promotes to CRITICAL the moment Phase 5 ships, per audit §C-4.

**Audit §6 additions to existing forward entries (recorded here, not re-derived in those entries):**

- *Security-smoke pass scope* — the canonical 6 bullets are extended by **3 audit-added items**: C-1 mutation, C-2 firm_id transfer, C-3 audit-log DELETE rejection. All three landed as smokes in this commit (numbers 1–8 in `security-rls.spec.ts`). The remaining 4 bullets (cross-firm read fixture, self-auth bypass, authority-limit, storage scoping) defer to the financial-rules Edge Function commit + Phase 5.
- *Data-integrity / auto-protect pass scope* — the canonical 8 items are extended by **5 audit-added items**: M-2 (schema-wide enum CHECK sweep), M-3 (sign-vs-type — landed in this commit), M-6 (`dispatch_log.token` hashing), L-3 (cascade-on-delete review), and C-4 (storage-vs-table RLS coherence — cross-references the Tier-2 work). M-3 is closed; the rest defer to the data-integrity pass commit.

**Out of scope (deliberate, FORWARD anchors planted):**

- **Tier-2 audit items (Phase 5 leaseholder portal commit):** C-4 (storage RLS confidentiality), L-4 (`meetings_read` tiered access), L-5 (`fpc_read` board-only fields), plus re-verification of H-2 + H-4 under leaseholder load.
- **Tier-3 audit items (Phase 8 self-host package):** H-5 (pgAudit log config doc), M-9 (CSP / SRI headers at deployment layer), M-10 (cookies vs localStorage session storage decision), production re-verify of H-1 in deployment template.
- **Tier-4 audit items (Data-integrity / auto-protect pass commit):** M-2 (schema-wide enum CHECKs), M-12 (`proposed` JSONB immutability post-action), M-13 (time-window CHECK on date columns), M-5 (`last_mutation_at` rate-limit columns), M-6 (`dispatch_log.token` hashing), L-3 (cascade-on-delete review).
- **Authority-limit, self-auth bypass, hard-delete, storage scoping smokes** (Security-smoke pass items 2 / 4 / 5 / 6) — need the financial-rules Edge Function or Phase 5 portal/audit-log; flagged in `security-rls.spec.ts` header.

**Smokes (12 new, 1 retired).** Active count: **108 → 119.** All passing.
- **C-1** — PM cannot UPDATE `users.role` on own row (column-grant 42501).
- **C-1** — PM cannot UPDATE `users.firm_id` on own row.
- **C-1 positive** — PM CAN UPDATE `full_name` on own row (proves the column-grant scope is right, not over-restricted).
- **C-2** — PM cannot transfer `bank_accounts` to a foreign firm via `firm_id` (WITH CHECK 42501).
- **C-2** — PM cannot transfer `transactions` to a foreign firm via `firm_id`.
- **C-2** — PM cannot INSERT `bank_accounts` with a foreign `firm_id`.
- **C-3** — PM cannot DELETE from `reconciliation_audit_log` or `golden_thread_audit_log` (RLS rejects silently — no policy match; row remains after attempted DELETE).
- **C-3** — PM cannot DELETE `payment_authorisations`; UPDATE still permitted (state-transition table).
- **RLS read scope** — every row returned from 6 financial tables carries `firm_id = my firm_id`.
- **M-1** — direct UPDATE on `bank_accounts.current_balance` is blocked by trigger (P0001 with literal "trigger-maintained" message).
- **M-3** — `transactions` row with `type='receipt'` and `amount<0` is rejected by `transactions_sign_type_chk` (23514).
- **M-4** — `payment_authorisations` with `authorised_at` set but `authorised_by` NULL is rejected by `pa_authorised_pair_chk` (23514).

**Rationale:** Tier-1 is a mechanical hardening pass — no design changes, no UI surface changes (apart from the H-7 trust-boundary correction inside `useAuth.ts` which is invisible to users). Bundling C-1 + C-2 + C-3 + M-1 + M-3 + M-4 + H-2 + H-4 in a single migration is correct because they all close at the DB layer and share the same DROP+CREATE rhythm; an exit at any sub-bundle would leave a gap visible to the PROD-GATE manifest grep without commensurate commit-discipline benefit. Closing 3 of 4 critical findings in one commit (C-4 deferred to Phase 5) puts the system at the audit's "safe to demo to a regulated customer" baseline. The 00027 fixup is a reminder that defence-in-depth triggers must reason about their own recursion — the BEFORE-UPDATE pattern is now established for any future trigger-maintained column.

---

## 2026-05-07 — pgAudit enablement approach

**Context:** Section 4 requires pgAudit to be enabled before any data migration. The Supabase hosted project does not allow direct superuser SQL for extension creation on the free tier in some cases.
**Decision:** pgAudit is enabled via a migration that calls `CREATE EXTENSION IF NOT EXISTS pgaudit;`. On Supabase Pro/hosted, this runs as the `postgres` role which has extension creation rights. If the extension is already enabled by the platform, the `IF NOT EXISTS` clause prevents an error.
**Rationale:** Supabase Pro grants extension creation to the `postgres` role. The migration is idempotent.

---
