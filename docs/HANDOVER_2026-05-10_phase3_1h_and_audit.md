# Handover Note — 2026-05-10, Phase 3 (reconciliation engine complete + security audit)

Continuation of `HANDOVER_2026-05-10_phase3_1g6.md`. The substantial bank
reconciliation work (1h.1 / 1h.2 / 1h.3) is now on origin/main, plus a deep
security audit covering all of Phase 1-3 architecture. Phase 3 has one
remaining deliverable per spec §7 (invoices CRUD with AI extraction); the
recommended next commit is the Tier-1 security hardening migration sweep.

## Completed this session (since 0bd3b7e)

- `9177a55` 1h.1 — Reconciliation schema + statement import pipeline.
  Migration 00025 adds `firms.is_demo` (Production-grade gate column),
  `bank_accounts.csv_column_map`, three new tables (`suspense_items`,
  `reconciliation_periods`, `reconciliation_audit_log`), and a partial
  unique index `uq_recperiod_one_open_per_account WHERE status='open'`.
  Per-property Reconciliation tab (9th) with `StatementImportModal` for
  CSV upload + column-mapping. CSV-only at PoC; OFX/QIF stubs throw
  "format not yet supported (FORWARD: 1h.4)". Active count: **89 → 93.**
- `cff48b9` 1h.2 — Three-pass matching engine + review UI.
  Pure-functional `matchingEngine.ts` (set-based candidate pools enforce
  the dedup invariant). `ReconciliationReviewModal` auto-applies pass-1
  matches on open + writes audit-log rows. Pass 2 (Suggested 80%) and
  pass 3 (Review carefully 50%) get one-click Confirm. Unmatched rows
  expose the four spec §5.3 PM actions: create new transaction, match
  manually, mark as suspense, reject — each writes a
  `reconciliation_audit_log` row citing RICS Rule 3.7. Active count:
  **93 → 102.** Pass-3's two disjunctive subclauses (amount-to-penny +
  ±30 days, OR ±£0.50 + ±7 days) get separate smoke coverage so a
  future refactor cannot quietly tighten the foreign-card-rounding
  branch.
- `900506e` 1h.3 — Completion + £0.01 balance gate + suspense override.
  `ReconciliationCompleteModal` runs the four pre-flight checks (no
  unmatched rows, every txn in period reconciled, £0.01 balance equality,
  suspense carry-forward override with required notes). On submit:
  period.status=completed, bank_accounts.last_reconciled_at,
  import.status=complete, audit_log row. Smoke 14 injects a corrupted
  balance via direct UPDATE on `bank_accounts.current_balance` (the
  trigger only fires on transactions changes, so this bypass is allowed)
  to exercise the gate. Smoke 2b is a pure-DB test of the partial unique
  index. Active count: **102 → 108. Phase 3 reconciliation engine
  complete.**
- `ee99a95` Security audit — `docs/SECURITY_AUDIT_2026-05-10.md`.
  38 findings, 4 critical, 7 high, 13 medium, 9 low, 5 info. Top finding:
  30 of 33 RLS `FOR ALL` policies are missing `WITH CHECK` clauses,
  creating a cross-firm data-leak primitive. One sweep migration closes
  them. PROD-GATE manifest verified grep-clean (12 items, 16 anchors).
  Adds 8 specific items to the existing Security-smoke pass + Data-
  integrity / auto-protect pass DECISIONS forward entries.

All four commits pushed to origin/main fast-forward
(`0bd3b7e → 9177a55 → cff48b9 → 900506e → ee99a95`). Worktree branch
`claude/keen-perlman-1c455b` is in sync.

## Decisions taken this session (also in DECISIONS.md, dated 2026-05-10)

- **Production-grade gate** — sibling to the existing "Demo mode toggle"
  entry. `firms.is_demo` column added in 00025 (default true). Every PoC-
  only enforcement decision carries a `FORWARD: PROD-GATE` flag at the
  relevant code anchor. The exit-demo flow's pre-flight refuses to flip
  `is_demo=false` if any reachable PROD-GATE path is unaddressed. Initial
  manifest of 12 items planted across the reconciliation module.
- **Reconciliation 1h.1** — schema + statement import pipeline. CSV-only
  parser with column-mapping cached on `bank_accounts.csv_column_map`.
  Persistent-period model (vs implicit-via-`last_reconciled_at` boundaries)
  to support Phase 6 financial-summary report's need for historical
  `suspense_carried_forward` flagging.
- **Reconciliation 1h.2** — three-pass matching engine + review UI. Pure-
  functional matching with set-based candidate pool dedup. Pass-1 auto-
  applies on modal open + writes audit-log; pass-2/3 are PM-confirm. The
  £0.50-tolerance branch of pass 3 gets its own smoke (smoke 7b).
- **Reconciliation 1h.3** — completion + £0.01 balance gate + suspense
  override. Pre-flight is hard (submit disabled until checks pass);
  `closing_balance_snapshot` captured from trigger-maintained
  `bank_accounts.current_balance`. Period overlap protection lives at the
  DB layer (smoke 2b is pure-DB).

## Open work — next session starts here

**Two natural candidates for the next commit, in priority order.**

### 1 — Tier-1 security hardening (RECOMMENDED FIRST)

The security audit's Tier-1 fix bundle. Single migration
`00026_security_hardening.sql` plus a small app-side change:

- **Migration 00026** covering the four critical findings:
  - C-1: column-grant restriction on `users` UPDATE (privilege escalation
    fix). Block role + firm_id self-mutation.
  - C-2: `WITH CHECK` clauses on all 30 `FOR ALL USING` policies in 00012
    + 00025. Sweep migration. Closes the cross-firm data-leak primitive.
  - C-3: Audit-trail tables (`reconciliation_audit_log`,
    `golden_thread_audit_log`, `dispatch_log`, `payment_authorisations`)
    split into SELECT + INSERT only RLS — no UPDATE/DELETE policy. Spec
    §5.3 RICS Rule 3.7 evidence trail compliance.
  - M-1: BEFORE-UPDATE trigger blocking `bank_accounts.current_balance`
    direct writes (defence-in-depth on the trigger contract).
  - H-2: Add `firm_id` predicate to `pm_messages_self`.
  - H-4: Add `is_current = true` to all four leaseholder-scoped subselects
    (documents, demands, s20, maintenance_requests).
  - M-3, M-4: cross-column CHECK constraints (sign-vs-type on transactions;
    audit-stamp coherence on payment_authorisations).
- **App change** `app/src/hooks/useAuth.ts` for H-7 — switch
  `loadFirmContext` to read role from JWT claims (`session.access_token`)
  instead of re-fetching from `public.users`. Restores JWT-as-source-of-
  truth defence-in-depth.
- **Config flips** in `supabase/config.toml`: `enable_signup = false`,
  `enable_confirmations = true`, `jwt_expiry = 600` (lowers post-
  revocation window from 1h to 10min).
- **Smoke spec hygiene** — drop the `?? 'sb_publishable_...'` fallback
  in 5 financial-* spec files (H-6).
- **Smokes (~10-15 new)** — covers the Security-smoke pass scope per
  the existing DECISIONS forward entry plus the 3 new items the audit
  added (C-1, C-2, C-3 specifics).

Estimated 1 commit, ~4-6 hours' focused work, lands the system at
"safe-to-demo-to-regulated-customer" baseline. Audit document
`docs/SECURITY_AUDIT_2026-05-10.md` is the canonical reference.

### 2 — Phase 3 invoices CRUD (the remaining Phase 3 deliverable)

Per spec §7: "invoice management with AI extraction" is the only Phase 3
piece outstanding. The `invoices` table at 00005:191-217 is in place
(forward FK from transactions added at 00005:227). Schema fields support
AI-extracted metadata (`extracted_by_ai`, `extraction_confidence`,
`extraction_notes`).

This is a substantial commit that will need:

- Per-property `InvoicesTab` (10th tab) — full CRUD with status state
  machine (received → approved → queued → paid | disputed | rejected).
- File upload → `documents` row → AI extraction Edge Function call →
  prefill `invoices` fields (Anthropic API integration via the spec'd
  `document_processing.ts` Edge Function).
- Linkage: `transactions.invoice_id` FK already exists; surface the link
  in the transactions form when paying an invoice.
- Per-property invoice spend cap (forward DECISIONS 2026-05-10) — out
  of scope for this commit; flag as forward.
- Director-approval queue for over-cap invoices — also forward; reuses
  Critical-Action Authorisations infra from 1g.

This is fresh-chat-sized. Recommend NOT bundling with Tier-1 security.

**Recommendation for the next session:** start with **Tier-1 security
hardening**. It's the highest-value next commit, the audit has done the
analysis work, and it cleanly unblocks the "demo to a real customer"
question. Invoices CRUD then becomes its own session after.

## Things to watch (carried forward + new this session)

### Carried forward from the 1g.6 handover
- **Server-side enforcement is still missing** across the financial layer.
  PROD-GATE manifest item 1 (matching engine) and item 7 (atomic
  completion) are the reconciliation-specific ones. The financial-rules
  Edge Function is the home for all of them.
- **LTA s.20B 18-month banding warning** — still deferred.
- **PDF demand generation** — still deferred.
- **`inter_account_transfer` paired-row authorisation** — schema enum
  supports it; UI doesn't surface it.
- **`authority_limit` enforcement not implemented** — column exists; PoC
  uses role only.
- **Atomic transactional wrap of authorise (payment / closure / RICS-
  toggle)** — non-atomic but recoverable; deferred to financial-rules
  Edge Function.
- **Firm-wide pending-authorisations dashboard** — admins must drill
  per-property.
- **`unitMap` rebuild in PropertyDetailPage.tsx:168** — pre-existing 1a
  perf concern; flagged-and-deferred.
- **Compliance smoke flake** — `compliance.spec.ts:RAG summary strip` had
  one flake during 1g.5; not seen since but worth a flake-investigation
  pass when context allows.

### New this session
- **Worktree dev server bind-to-IPv4.** Vite v6 binds to `localhost`
  (which resolves to IPv6 first on Windows) by default, but the
  Playwright config uses `http://127.0.0.1:5174`. Fix: start vite with
  `--host 127.0.0.1`. The `playwright.worktree.config.ts` shim could be
  extended with a `webServer` block that includes the right `--host`
  flag. Pattern to remember: when smokes fail with `ERR_CONNECTION_REFUSED`
  but `localhost:5174` works in a browser, this is the cause.
- **Worktree `.env.local`** — the worktree didn't have one when the
  session started (fresh checkout) so the app failed to load with
  "Missing Supabase environment variables". Created with the publishable
  key + URL (gitignored). Pattern for the next worktree: copy `.env.local`
  from the main repo OR create with the standard values during worktree
  setup.
- **`enable_signup = true` + `enable_confirmations = false`** in
  `supabase/config.toml` is a known PoC choice but should flip in any
  production deployment. Audit finding H-1.
- **`jwt_expiry = 3600`** is a 1-hour post-revocation window for offboarded
  users. Lower to 600s in production. Audit finding H-3.
- **`bank_accounts.current_balance` direct UPDATE allowed.** Used by smoke
  14 to inject a corrupted balance and exercise the £0.01 gate. Per audit
  finding M-1, production needs the BEFORE-UPDATE trigger guard. Until
  then: do not assume the trigger contract is enforced against direct DB
  writes. PROD-GATE manifest item 8.
- **The `users_update_self` policy at 00012:48 permits role + firm_id
  self-mutation.** This is the single highest-severity finding (C-1) and
  the first thing to fix in Tier-1 security.
- **Period overlap is DB-enforced** — the `uq_recperiod_one_open_per_
  account` partial unique index in 00025 returns `23505` on a second open
  period for the same bank account. UI catches and surfaces a friendly
  message. Smoke 2b verifies the DB-layer guard directly.
- **Statutory-citation-as-test-anchor pattern continues to work.**
  Reconciliation smokes assert on the literal "RICS Rule 3.7" string in
  audit-log notes. The pattern extended cleanly from §5.21B / RICS 4.7 /
  TPI §5 in earlier commits to the new audit-log domain. Reusable for
  every future regulatory citation.
- **Action-form-as-inline-card pattern** (vs nested modals) avoids
  strict-mode locator collisions on multiple modal headings — used in
  ReconciliationReviewModal for the four PM actions. Pattern to use
  whenever a modal needs to surface a sub-flow that itself needs a form.

## State of the build

- **Migrations applied through:** 00025 (00025 added `firms.is_demo`,
  `bank_accounts.csv_column_map`, three reconciliation tables, partial
  unique index for one-open-period-per-account)
- **Tests passing:** 108 / 108 (1 admin setup + 1 PM setup + 106 active
  smokes). Reconciliation suite is 19 of those (4 from 1h.1, 9 from 1h.2,
  6 from 1h.3 including smoke 2b).
- **Last green CI run:** not run (no CI configured; local-only smoke gate)
- **Pushed to origin/main:** yes — `ee99a95` is the tip
- **Test users seeded:** `admin@propos.local`, `pm@propos.local`,
  `director@propos.local`
- **Worktree branch:** `claude/keen-perlman-1c455b` in sync with
  origin/main
- **Open issues:** none blocking. The 4 critical security audit findings
  are scheduled for the Tier-1 hardening commit; deferred items above are
  scheduled, not bugs.
- **PROD-GATE manifest:** 12 items, 16 grep-confirmed code anchors.
  Manifest is complete. Demo-mode-exit pre-flight is unblocked from the
  manifest's side.

## Suggested first message for next session

The user will likely start the next chat fresh with the Tier-1 security
hardening commit. The prompt below loads the right context: the security
audit document, the Production-grade gate DECISIONS entry, and the
existing Security-smoke pass forward entry. Per memory rules: anchor
status line to the harness indicator (not a guess); plan-first gate
applies to this commit (it's substantial); per-action authorisation
required for commit + push; apply migrations via Dashboard SQL Editor.

```
Hello Claude. You are the build engineer for PropOS, on Opus 4.7.
Phase 3 reconciliation engine complete (commits 1h.1 / 1h.2 / 1h.3
shipped on origin/main, latest ee99a95). The deep security audit
in docs/SECURITY_AUDIT_2026-05-10.md identifies 4 critical findings
and a Tier-1 fix bundle that lands the system at safe-to-demo-to-
regulated-customer baseline.

Today's task: ship the Tier-1 security hardening commit. Plan-first
gate applies — produce file list, smoke list, UX rules, migration
SQL, FORWARD anchors before any code. The audit + the existing
Security-smoke pass DECISIONS entry are the canonical scope.

Pull together everything you need:

  1. docs/SECURITY_AUDIT_2026-05-10.md — read in full. The four
     critical findings (C-1 through C-4) plus the Tier-1 list at §5
     are the scope. The audit also adds 3 specific gaps to the
     existing Security-smoke pass DECISIONS forward entry — those
     get a smoke each.
  2. docs/DECISIONS.md most recent entries — Production-grade gate
     (2026-05-10), the 1h.1/1h.2/1h.3 entries (for the per-table
     RLS + CHECK additions to mirror), and the Security-smoke pass
     forward entry. The latter is the canonical scope; cite it in
     the new commit's DECISIONS entry rather than re-deriving.
  3. docs/LESSONS_LEARNED.md — the modal-vs-DB-query race + strict-
     mode locator collision patterns apply to the new RLS smokes
     too. The new "worktree dev server bind-to-IPv4" + ".env.local
     in fresh worktree" patterns from the 1h handover are worth
     pulling into LESSONS as part of this commit.
  4. supabase/migrations/00012_rls_policies.sql — the file you'll
     sweep with WITH CHECK clauses.
  5. supabase/migrations/00025_reconciliation_schema.sql — three
     newer policies that need the same sweep.

Then produce the plan-first gate:

  - File list (migration 00026 + app-side useAuth.ts + config.toml
    + 5 smoke spec hygiene fixes + new smokes file).
  - Test list (concrete smoke names, not categories — Security-
    smoke pass scope from the DECISIONS entry plus the 3 new items
    the audit added).
  - UX rules — auth flow changes; post-fix behaviour where role
    changes don't propagate until JWT refresh; offboarding's 10-min
    window; signup-disabled error message.
  - Out-of-scope (deliberate) — Tier-2/3/4 from the audit, with
    FORWARD flags.
  - Migration plan — write SQL but do NOT ask the user to apply it
    yet; queue for sign-off alongside the rest of the plan.

Surface the harness context indicator's actual % in the status
line (the user will paste it; never substitute your own estimate).
When the user wakes up they will sign off; you then proceed
migration → code → smokes → commit per the standing pattern.

Build state: 108/108 smoke passing. Migrations: 00025 latest. Test
users: admin / pm / director seeded. The pattern: write migration
SQL, ask the user to apply via Supabase Dashboard SQL Editor before
running smokes. Push only on per-action authorisation — never
standing approval. Plant FORWARD: PROD-GATE flags in code /
migrations / docs for any deferred items per the manifest convention
(DECISIONS 2026-05-10 — Production-grade gate). When the Tier-1
commit lands, the 4 critical findings move from "open" to "fixed"
in the audit doc; DECISIONS entry should reference the audit by
section number for traceability.
```

---

End of handover.
