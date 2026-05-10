# Handover Note — 2026-05-10, Phase 3 (in progress, mid-phase), context ~18% (green)

Continuation of `HANDOVER_2026-05-10_phase3_1g.md`. Two small commits landed in the
follow-up session (1g.5 + 1g.6); the substantial reconciliation work is fresh-chat
territory and is the open item for next session.

## Completed this session (since the previous handover note 4dad88b)

- `efdd77c` 1g.5 — RICS-designation toggle dual-auth. **Schema migration 00024**:
  `payment_auth_action_type` CHECK widened from `IN ('payment','close_bank_account')`
  to `IN ('payment','close_bank_account','toggle_rics_designation')`. New
  `ProposedRicsDesignationToggle = { bank_account_id, new_value: boolean }` interface;
  `CRITICAL_ACTION_TYPES` extended to a 3-tuple. `BankAccountsTab` gains a
  **Request designation removal** button (`ShieldOff` icon) for non-finance roles
  on accounts where `rics_designated = true`. `PaymentAuthorisationsTab` gains a
  third `handleAuthorise` dispatch branch + `authoriseRicsToggle` two-write
  (non-atomic, recoverable, idempotent). Direction-gated: only `true → false`
  flows through dual-auth; the protective `false → true` direction stays a
  direct edit. Mirrors 1g closure design 1:1 (PM-via-button-request,
  admin-direct-via-form). 3 new smokes. **Active count: 85 → 88.**
- `6ff3bac` 1g.6 — Comment hygiene + asymmetry regression test. Four stale
  comments in `BankAccountsTab.tsx` updated (file docstring, `FINANCE_ROLE_TOOLTIP`,
  defence-in-depth note); one regression smoke added in `financial-bank-accounts.spec.ts`
  locking in the 1g.5 admin-direct-flip asymmetry — admins can still untick
  `rics_designated` directly via the form, no PA created. Three forward-looking
  DECISIONS entries added: `1g.6` itself, `Security-smoke pass`, and
  `Data-integrity / auto-protect pass` — each ending with a `FORWARD:` line per
  the new "flag deferred items at the relevant anchor" rule. **Active count:
  88 → 89.**

Both commits pushed to origin/main fast-forward (`4dad88b → efdd77c → 6ff3bac`).
Worktree branch `claude/hardcore-agnesi-a606b2` is in sync.

## Decisions taken this session (also in DECISIONS.md, dated 2026-05-10)

- **RICS-designation toggle dual-auth (1g.5)** — direction-gated; mirrors 1g
  closure; admin-direct-flip asymmetry is by design, not a gap.
- **Comment hygiene + asymmetry regression test (1g.6)** — locks in the design
  call so a future commit can't silently strip it.
- **Security-smoke pass (forward-looking)** — RLS isolation, self-auth bypass
  via direct DB, JWT tampering, hard-delete via service-role, authority-limit
  bypass, storage bucket scoping. Anchored to the financial-rules Edge Function
  commit. `FORWARD:` flag in DECISIONS entry.
- **Data-integrity / auto-protect pass (forward-looking)** — sign-vs-type CHECK,
  audit-stamp coherence, proposed-JSONB immutability post-action, time-window
  sanity, trigger-maintained value protection, rapid-mutation rate limit,
  tamper-resistant audit log, anomaly detector. Anchored to Phase 5 audit work.
  `FORWARD:` flag in DECISIONS entry.

## Open work — next session starts here

**Bank reconciliation workflow** is the substantial next Phase 3 piece. Per spec
§5.3 the engine has these moving parts:

- **Statement import pipeline.** PM uploads a CSV / OFX / QIF bank statement.
  Format detection client-side; rows written to `bank_statement_imports.raw_data`
  with `status='pending'`. Schema is in place at 00005:232; UI does not yet exist.
- **Three-pass matching algorithm** (run server-side, likely in an Edge Function
  `reconciliation_engine.ts`):
  - Pass 1 — exact match: amount to the penny + date within ±2 days + reference OR
    payee match. Confidence 1.00. Auto-matched.
  - Pass 2 — strong match: amount to the penny + date within ±7 days. Confidence 0.80.
    PM one-click confirm.
  - Pass 3 — weak match: amount to the penny + date within ±30 days OR amount within
    £0.50 + date within ±7 days. Confidence 0.50. PM "review carefully" list.
- **PM actions on unmatched rows:** create new transaction, manual-match to existing,
  mark as suspense, reject statement row.
- **Suspense items table** — schema does not exist yet; spec says "added in v1.7
  migration". For Phase 3 we'll need to add this in a migration with at minimum:
  `id, firm_id, bank_statement_import_id, statement_row_index, amount, statement_date,
  description, target_resolution_date, status, resolved_to_transaction_id,
  resolution_notes, created_at`.
- **Completion rules:** `bank_accounts.last_reconciled_at` updated only when
  every transaction in the period has `reconciled = true` and no open suspense
  items date within the period. Suspense items can be carried forward with an
  override flag (`suspense_carried_forward = true`) on the reconciliation period.
  The `current_balance` must equal the SUM of transactions to within £0.01 at
  completion or the system blocks completion.
- **Audit log** — every reconciliation action (auto-match, manual-match, suspense,
  reject, completion) writes a row to a `reconciliation_audit_log` table that
  doesn't exist yet. RICS Rule 3.7 evidence trail; 6-year retention minimum.

**Smaller candidates that could come first if a quick win is wanted:**

1. **Size M demo data** — realistic firm + properties + financial entities at
   varied states, per DECISIONS 2026-05-10. Useful for screenshots / sales /
   exploratory testing. Medium-sized commit (2-3 hours).
2. **§6.5 hygiene fix** — drop the publishable-key fallback from each
   `createClient()` call in the smoke specs (currently 4 specs carry the same
   `?? 'sb_publishable_...'` line). Small commit; low impact.

**Recommendation for the next chat:** start straight on **bank reconciliation**
as the substantial Phase 3 piece. It's the spec's §7 next deliverable, the
schema groundwork is in place for transactions/bank-accounts, and the suspense
items + audit-log migrations are the natural shape of the commit.

## Things to watch (carried forward from the 1g handover, plus session-2 additions)

- **Server-side enforcement is still missing.** SCA finalisation lock, demand
  s.21B guard, paid lock, reconciled lock, statement-import lock, dual-auth gate
  (payment AND closure AND rics-toggle), self-auth guard, authorise dispatch —
  all client-side only. The financial-rules Edge Function should mirror the UI
  guards; **note** the new 1g.5 direction-gating rule (`new_value === false`
  for rics-toggle) needs to land in that Edge Function too.
- **LTA s.20B 18-month banding warning** — still deferred.
- **PDF demand generation** — still deferred.
- **`inter_account_transfer` paired-row authorisation** — schema enum supports it;
  UI doesn't surface it.
- **`authority_limit` enforcement not implemented** — column exists; PoC uses role only.
- **Atomic transactional wrap of authorise (payment / closure / rics-toggle)** —
  non-atomic but recoverable; deferred to financial-rules Edge Function.
- **Firm-wide pending-authorisations dashboard** — admins must drill per-property
  to see pending; pulling forward worth considering.
- **Audit log entries for authorise / reject / cancel events** — Phase 5+; the
  new "Data-integrity / auto-protect pass" DECISIONS entry has the canonical scope.
- **Demo mode toggle** — Phase 6+; design constraint already recorded.
- **Per-property invoice spend cap** — forward-looking; design constraint already
  recorded.
- **The `unitMap` rebuild in `PropertyDetailPage.tsx:168`** — pre-existing 1a
  code; minor re-render perf concern; flagged-and-deferred.
- **Compliance smoke flake** — `compliance.spec.ts:RAG summary strip shows three
  cards` failed once on a full run during 1g.5 testing; passes on isolated re-run.
  Worth a flake-investigation pass — likely an order-dependent timing or
  seed-state issue. Not blocking; not from any of session 2's commits.
- **Deferred `__hygiene__` fix on smoke specs** — `?? 'sb_publishable_...'`
  fallback in each `createClient()` call across 4 specs. Small but worth it.

## State of the build

- **Migrations applied through:** 00024 (00024 widened payment_auth_action_type
  CHECK to include `'toggle_rics_designation'`)
- **Tests passing:** 89 / 89 (1 admin setup + 1 PM setup + 87 active smokes)
- **Last green CI run:** not run (no CI configured; local-only smoke gate)
- **Pushed to origin/main:** yes — `6ff3bac` is the tip
- **Test users seeded:** `admin@propos.local`, `pm@propos.local`, `director@propos.local`
- **Worktree branch:** `claude/hardcore-agnesi-a606b2` in sync with origin/main
- **Open issues:** none blocking; deferred items above are scheduled, not bugs

## Suggested first message for next session

The user is going to bed and will not be at the keyboard for the first part of
the next session. The prompt below tells Claude to do the full read-and-plan
pass autonomously and have the plan ready for review when the user returns.
Claude must NOT start writing code without explicit sign-off.

```
Hello Claude. You are the build engineer for PropOS, on Opus 4.7.
Phase 3 commits 1a–1g.6 shipped on origin/main (latest 6ff3bac).
The user is asleep when this session starts and will be back in a few
hours. Please complete the full read-and-plan pass autonomously now so
the plan is ready for review when they return. Do NOT begin writing
code without explicit sign-off — finish at the plan-first gate and wait.

Pull together everything you need to plan the bank reconciliation
workflow:

  1. PropOS_Handoff_Document_v1_6_1.docx (in C:\Users\bengr\Downloads\)
     — read §5.3 in full (the reconciliation engine spec), §5.6 (the
     financial compliance rules including the trigger-maintained
     bank_account balance), §7 (Phase 3 deliverables list), and §12
     (context window rules — anchor the status line to the harness's
     real indicator, NOT a guess; under-estimate when uncertain; the
     window is ~1M tokens, not 200k).
  2. /docs/DECISIONS.md — the most recent entries (2026-05-10) cover
     1f / 1f.5 / 1g / 1g.5 / 1g.6 plus the forward-looking entries for
     the security-smoke pass and the data-integrity / auto-protect pass.
     The latter two are the canonical scope for related work; cite
     them in your plan rather than re-deriving.
  3. /docs/LESSONS_LEARNED.md — Phase 3 session 2 additions cover
     interim role gates, JSONB-snapshot pattern, statutory citations
     doubling as test anchors, plus several smoke-flake patterns
     (modal-vs-DB-query race, strict-mode locator collisions) that
     apply to reconciliation UI tests too.
  4. /docs/HANDOVER_2026-05-10_phase3_1g6.md — this note. Read the
     "Open work" + "Things to watch" sections.
  5. The relevant code today: `bank_statement_imports` table at
     migration 00005:232; `transactions.reconciled` + `reconciled_at`
     + `reconciled_by` columns at 00005:118-138; the `reconciled_lock`
     and `statement-import lock` UX in TransactionsTab.tsx.

Then produce the plan-first gate output:

  - File list (every new file + every modified file, including any
    new migration / new Edge Function / new schema for suspense_items
    and reconciliation_audit_log).
  - Test list (concrete smoke test names, not categories).
  - UX rules — including the matching-confidence display, the PM
    actions on unmatched rows, the £0.01 balance-equality block, the
    suspense-carried-forward override, and the audit-log writes per
    action. Cite spec §5.3 line-references.
  - Out-of-scope (deliberate) — call out what's deferred and add
    `FORWARD:` flags pointing at the right phase.
  - Migration plan — write SQL but DO NOT ask the user to apply it
    yet; queue it for sign-off alongside the rest of the plan.

Surface the harness context indicator's actual % in the status line
at the top of every reply (the user will paste it; never substitute
your own estimate). When the user wakes up they will sign off on the
plan and you will then proceed migration → code → smokes → commit
following the standing pattern.

Build state: 89/89 smoke passing. Migrations: 00024 latest. Test
users: admin / pm / director seeded. The pattern: write migration SQL,
ask the user to apply via Supabase Dashboard SQL Editor before
running smokes. Push only on per-action authorisation — never standing
approval. Plant `FORWARD:` flags in code / migrations / docs for
deferred items per the flag-deferred-items rule (not just in DECISIONS).
```
