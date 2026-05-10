# Handover Note — 2026-05-10, Phase 3 (Tier-1 security hardening complete)

Continuation of `HANDOVER_2026-05-10_phase3_1h_and_audit.md`. The audit's
Tier-1 fix bundle is now on origin/main as commit 1i.1. 12 of the audit's
38 findings are closed (3 of 4 critical). The system is at the audit's
"safe to demo to a regulated customer" baseline. Phase 3 has one
deliverable remaining per spec §7 (invoices CRUD with AI extraction);
that is the recommended next commit.

## Completed this session (since ee99a95)

- `c60c600` 1i.1 — Tier-1 security hardening. Single sweep migration
  `00026_security_hardening.sql` plus fixup `00027_fix_m1_trigger_recursion.sql`
  (caught by the smoke suite — see "Things to watch" below). App-side
  `useAuth.ts` rewrite for H-7 (loadFirmContext now decodes the access-token
  JWT instead of re-querying `public.users`). `supabase/config.toml` flips
  for H-1 + H-3 (`enable_signup = false`, `enable_confirmations = true`,
  `jwt_expiry = 600`). Smoke spec hygiene for H-6 — `_env.ts` `requireEnv`
  helper + sweep across 11 spec files dropped the embedded publishable-key
  fallback; `playwright.config.ts` gained a tiny inline `.env.local` parser
  so the smoke runner picks up env without manual shell setup. New
  `security-rls.spec.ts` adds 12 smokes covering C-1, C-2, C-3, M-1, M-3,
  M-4 plus RLS read-scope. Smoke 14 retired in
  `financial-reconciliation.spec.ts` (the M-1 trigger blocks the
  divergence-injection path it relied on; replacement covers the trigger
  itself in the new file). Active count: **108 → 119. All passing.**

Pushed to origin/main fast-forward (`ee99a95 → c60c600`). Worktree branch
`claude/wonderful-rubin-8cda18` is in sync.

## Decisions taken this session (also in DECISIONS.md, dated 2026-05-10)

- **Tier-1 security hardening (commit 1i.1)** — single migration 00026
  sweeps the audit's §5 Tier-1 list. C-1 column-grant restriction on
  `users` UPDATE; C-2 `WITH CHECK` clauses added to all 30 `FOR ALL USING`
  policies in 00012 + 00025; C-3 split four audit-trail tables (two pure
  audit, two state-tracking with UPDATE retained); M-1 `block_balance_writes()`
  BEFORE-UPDATE trigger; H-2 `firm_id` predicate on `pm_messages_self`;
  H-4 `is_current = true` on four leaseholder-scoped subselects; M-3
  + M-4 cross-column CHECK constraints. The 1i.1 DECISIONS entry cites
  the audit by §ID for traceability and lists all 12 findings closed plus
  the 5 deferred Tier-2/3/4 buckets with their schedule.
- **00027 fixup as a learnable moment.** The original 00026 §M-1 trigger
  rejected ALL writes to `bank_accounts.current_balance` including the
  legitimate UPDATE issued by `sync_bank_account_balance` on every
  transactions write. Caught by the smoke suite within 3 minutes (23
  failures across the financial suite). Fix: `pg_trigger_depth() = 1`
  guard. Threat model preserved (top-level user UPDATE = depth 1, rejected;
  nested-trigger UPDATE = depth 2, allowed). Codified in LESSONS Phase 3
  session 4 as a generalisable pattern for any defence-in-depth BEFORE
  trigger on a trigger-maintained column.
- **Smoke 14 retired, not rewritten.** The `Completion blocked with
  >£0.01 balance discrepancy` smoke injected divergence via direct UPDATE
  on `current_balance` — the M-1 trigger now blocks that path. The £0.01
  gate becomes belt-and-braces; gate component logic stays in place
  defensively. Replacement coverage of the trigger itself lives in the
  new `security-rls.spec.ts` smoke 10. FORWARD: when the financial-rules
  Edge Function lands, revisit whether the gate's pre-flight check warrants
  its own smoke against an Edge-Function-injected divergence path.

## Open work — next session starts here

**Recommended: Phase 3 invoices CRUD with AI extraction.**

The only remaining Phase 3 deliverable per spec §7. The `invoices` table
at 00005:191-217 is in place (forward FK from `transactions.invoice_id`
added at 00005:227). Schema fields support AI-extracted metadata
(`extracted_by_ai`, `extraction_confidence`, `extraction_notes`). This
will be a substantial commit needing:

- Per-property `InvoicesTab` (10th tab) — full CRUD with status state
  machine (received → approved → queued → paid | disputed | rejected).
- File upload → `documents` row → AI extraction Edge Function call →
  prefill `invoices` fields. Anthropic API integration via the spec'd
  `document_processing.ts` Edge Function (not yet built — spec §5 + §7).
- Linkage: surface the `transactions.invoice_id` link in the transactions
  form when paying an invoice.
- Per-property invoice spend cap (forward DECISIONS 2026-05-10) — out of
  scope for this commit; flag as forward.
- Director-approval queue for over-cap invoices — also forward; reuses
  Critical-Action Authorisations infra from 1g.

Fresh-chat-sized. The plan-first gate applies. Migration verification
query (per the new memory `feedback_migration_verification_in_plan.md`)
should ship alongside any invoice-table-touching SQL.

**Other natural candidates (not blocking):**

- **Financial-rules Edge Function** — homes for atomic completion (PROD-GATE
  item 7), authority-limit enforcement, self-auth bypass, the rest of
  the Security-smoke pass scope (items 2 / 4 / 5 / 6). Substantial.
- **Data-integrity / auto-protect pass** — schema-wide enum CHECK sweep
  (M-2), proposed-JSONB immutability (M-12), time-window CHECK on date
  columns (M-13), rate-limit columns (M-5), `dispatch_log.token` hashing
  (M-6), cascade-on-delete review (L-3). Substantial; bundles cleanly
  with the financial-rules Edge Function commit.
- **`users_select_self` policy provenance** — extra `users` policy not
  anchored in 00012 (almost certainly added by 00013–00016 JWT hook
  setup). Identify source migration, document, consolidate into 00012
  in a later cleanup commit. Cheap.
- **`AuthGuard` "no firm context" UX banner** — FORWARD anchor planted
  in `AuthGuard.tsx` header. One-line UX touch when there's appetite.

## Things to watch (carried forward + new this session)

### Carried forward from the 1h handover
- **C-4 (storage RLS for `documents.is_confidential`)** — the only
  critical audit finding still open. FORWARD: PROD-GATE anchors at
  `00026:bottom` and `00017_storage_rls.sql`. Lands with Phase 5
  leaseholder portal commit. **Promotes to active CRITICAL the moment
  Phase 5 ships.**
- **Server-side enforcement is still missing** across the financial
  layer. PROD-GATE manifest items 1 + 7 (matching engine + atomic
  completion) and the Security-smoke pass items 2 / 4 / 5 / 6 all wait
  for the financial-rules Edge Function.
- **LTA s.20B 18-month banding warning** — still deferred.
- **PDF demand generation** — still deferred.
- **`inter_account_transfer` paired-row authorisation** — schema enum
  supports it; UI doesn't surface it.
- **`authority_limit` enforcement not implemented** — column exists; PoC
  uses role only.
- **Firm-wide pending-authorisations dashboard** — admins must drill
  per-property.
- **`unitMap` rebuild in PropertyDetailPage.tsx:168** — pre-existing 1a
  perf concern; flagged-and-deferred.
- **Compliance smoke flake** — `compliance.spec.ts:RAG summary strip` had
  one flake during 1g.5; not seen since.

### New this session
- **BEFORE-UPDATE triggers on trigger-maintained columns must check
  `pg_trigger_depth() = 1`.** 00027 fixed the recursion bug in 00026's
  M-1 trigger. Boilerplate pattern in LESSONS Phase 3 session 4. Any
  future defence-in-depth trigger on `service_charge_accounts.spent_so_far`
  or similar trigger-maintained columns must apply the same guard.
- **`users_select_self` policy provenance.** Post-00026 verification
  query revealed an extra `users` policy not in 00012. Almost certainly
  added by 00013–00016 (JWT hook setup migrations). Harmless (SELECT-only,
  narrowly scoped) but breaks the LESSONS Phase 1 "single migration to
  reason about RLS" model. **Picking off in a future cleanup commit.**
- **Dashboard "destructive operations" warning is a false positive** on
  policy/trigger/function DDL sweeps (DROP + immediate recreate). Sister
  to the existing "no RLS" warning. Both codified in memory; rule of
  thumb: **Dashboard SQL Editor warnings on policy / RLS / trigger /
  function DDL are usually false positives.**
- **`enable_signup = false` requires the Dashboard sibling toggle too.**
  `supabase/config.toml` only governs the local CLI shadow. The live
  project's H-1 closure depends on the Dashboard toggle (Auth → Providers
  → Email → Allow new users to sign up) being flipped OFF. **Flag for
  the Phase 8 self-host package + verify on the live project before any
  beta customer.**
- **The dispatch_log + payment_authorisations RLS now has three policies
  each** (SELECT + INSERT + UPDATE) instead of one `FOR ALL`. Future
  smoke writers should not expect a single policy hit when introspecting
  `pg_policy`. Matches the C-3 split.
- **Smoke env-var hygiene via `requireEnv`.** New helper at
  `app/tests/smoke/_env.ts`; `playwright.config.ts` loads `.env.local`
  with a 5-line inline parser (no `dotenv` dep added). Pattern: any
  future smoke or script needing env should fail at module load via
  `requireEnv`, never via `?? '<embedded>'` fallback.
- **Fresh worktree setup checklist (recurring):** copy `.env.local` from
  the main repo before starting the dev server; start vite with
  `--host 127.0.0.1 --port 5174` to avoid the IPv6-default + main-repo
  port collision; node_modules sometimes need a fresh `npm install` in
  a clean worktree.

## State of the build

- **Migrations applied through:** 00027 (00026 Tier-1 sweep + 00027 M-1
  trigger recursion fix).
- **Tests passing:** 119 / 119 (1 admin setup + 1 PM setup + 117 active
  smokes). New `security-rls.spec.ts` is 12 of those; smoke 14 retired
  from `financial-reconciliation.spec.ts`.
- **Last green CI run:** not run (no CI configured; local-only smoke gate).
- **Pushed to origin/main:** yes — `c60c600` is the tip.
- **Test users seeded:** `admin@propos.local`, `pm@propos.local`,
  `director@propos.local`.
- **Worktree branch:** `claude/wonderful-rubin-8cda18` in sync with
  origin/main.
- **Open audit findings:** 26 of 38 (12 closed in 1i.1). The only
  remaining CRITICAL is C-4. Tier-2/3/4 scheduled per audit §5 with
  FORWARD anchors at the relevant code locations.
- **PROD-GATE manifest:** 12 items + the new C-4 anchor (13 total). Demo-
  mode-exit pre-flight unblocked from the manifest's side except for C-4.

## Suggested first message for next session

The user will likely start the next chat fresh with the Phase 3 invoices
CRUD commit. The prompt below loads the right context: the spec section,
the relevant DECISIONS entries, and the Critical-Action Authorisations
pattern from 1g (which the over-cap director-approval queue can reuse).
Per memory rules: anchor status line to the harness indicator (not a
guess); plan-first gate applies; per-action authorisation required for
commit + push; apply migrations via Dashboard SQL Editor; ship the
verification query alongside any migration SQL.

```
Hello Claude. You are the build engineer for PropOS, on Opus 4.7. Phase 3
is one commit short of complete: invoices CRUD with AI extraction (spec
§7) is the only remaining deliverable. 1i.1 Tier-1 security hardening is
on origin/main (latest c60c600); 119/119 smokes passing; 12 of 38 audit
findings fixed including 3 of 4 critical (C-4 explicitly deferred to
Phase 5).

Today's task: ship the Phase 3 invoices CRUD commit. Plan-first gate
applies — produce file list, smoke list, UX rules, migration SQL plus
the post-apply verification query, FORWARD anchors before any code.

Pull together everything you need:

  1. PropOS Handoff Document §5 (Document AI integration) and §7
     (Phase 3 deliverables list — invoices is the last one).
  2. supabase/migrations/00005_financial_core.sql:191-217 — the
     existing `invoices` table schema + the
     `extracted_by_ai`/`extraction_confidence`/`extraction_notes`
     fields that the AI flow populates.
  3. supabase/migrations/00005_financial_core.sql:227 — the forward
     FK `transactions.invoice_id` already in place.
  4. docs/DECISIONS.md most recent entries — Tier-1 security hardening
     (2026-05-10 — for the 1i.1 patterns); 1g Critical-Action
     Authorisations + action_type discriminator (for the over-cap
     director-approval queue scaffolding); per-property invoice spend
     cap (forward entry — explicitly out of scope for this commit but
     anchor for the FORWARD comment).
  5. docs/SECURITY_AUDIT_2026-05-10.md status table — confirm the 12
     closed findings + C-4 status before any leaseholder-related code.
  6. docs/LESSONS_LEARNED.md — modal-vs-DB-query race, strict-mode
     locator collisions, action-form-as-inline-card, statutory-citation-
     as-test-anchor patterns all apply.

Then produce the plan-first gate:

  - File list (migration if any + per-property InvoicesTab + AI Edge
    Function `document_processing.ts` + smoke spec).
  - Test list (concrete smoke names — invoice CRUD + AI extraction
    happy path + AI extraction failure surfacing + status state machine
    + transactions linkage).
  - UX rules — file upload flow, AI confidence display, manual-edit
    after AI extraction, status state transitions.
  - Out-of-scope (deliberate) — per-property spend cap + director-
    approval queue, with FORWARD anchors planted.
  - Migration plan — SQL plus verification query but do NOT ask the
    user to apply yet; queue for sign-off.

Surface the harness context indicator's actual % in the status line
(the user will paste it; never substitute your own estimate). When
the user wakes up they will sign off; you then proceed migration →
code → smokes → commit per the standing pattern.

Build state: 119/119 smoke passing. Migrations: 00027 latest. Test
users: admin / pm / director seeded. The pattern: write migration SQL
+ verification query, ask the user to apply via Supabase Dashboard SQL
Editor before running smokes. Push only on per-action authorisation.
Plant FORWARD: PROD-GATE flags in code/migrations/docs for any deferred
items per the manifest convention.
```
