# Handover Note — 2026-05-10, Phase 3 (in progress, mid-phase), context ~53% (yellow)

Produced at the natural break after 1g shipped. Context entered yellow band during 1g; the next work unit (whatever it is) gets a fresh chat per §12.

## Completed this session (since the previous handover note 8e83ace)

- `f0c37ee` 1d.1 — bank account closure + delete restricted to admin / director (interim role gate; surfaced via tooltips and a Lock banner). Defence-in-depth role check in `handleDelete`. Added `isFinanceRole(role)` and `FINANCE_ROLES` to `lib/constants.ts`.
- `9d740d6` 1e — TransactionsTab as the 7th per-property tab. Sign-aware MoneyInput (receipt → +; payment → flipped to − on save; journal → allowNegative). Bank-account balance trigger (`sync_bank_account_balance`, deployed in 00005:144) does the arithmetic — UI never writes `current_balance`. Demand auto-status on receipt linking. Reconciled lock + statement-import lock + draft-only delete with regulatory rationale. 10 new smokes.
- `ce4aba5` 1f — PaymentAuthorisationsTab as the 8th per-property tab. **Schema migration 00022**: `payment_authorisations.transaction_id` made nullable; new `proposed JSONB` column; CHECK constraint `(transaction_id IS NOT NULL) OR (proposed IS NOT NULL)`. The 1e dual-auth interim block is replaced by a request flow — payment over threshold creates a pending PA with proposed snapshot, no transaction yet. Authorise inserts the transaction from snapshot + links + stamps. Self-auth guard, role guard, cancel-by-requester, immutability of post-action rows. 11 new smokes (8 active + 3 then-skipped on admin-only seed).
- `36ea06c` 1f.5 — Test users (PM + director) seeded via Dashboard auth + `supabase/seed/test_users.sql`. Plus-addressing convention for operational emails. PM Playwright storage state under `tests/.auth/pm-user.json`. The 3 previously-skipped cross-user PA smokes now active. **Active count went from 78 → 82.**
- `24243ae` 1g — Bank account closure dual-auth. **Schema migration 00023**: `payment_authorisations.action_type TEXT NOT NULL DEFAULT 'payment'` with CHECK `IN ('payment', 'close_bank_account')`. PMs gain a "Request closure" button (Send icon) on the bank-accounts tab; closure flows through the existing PA queue with a row-rendering branch and an authorise dispatch branch. The 1d.1 interim role gate is now superseded by the proper second-signer flow. 3 new smokes. **Active count: 82 → 85.**

All five commits pushed to origin/main (fast-forward only). Worktree branch `claude/condescending-mclaren-7f7724` also up-to-date.

## Decisions taken this session (also in DECISIONS.md, dated 2026-05-10)

- **Bank account closure role gate (interim) + Critical-Action Authorisations (1f scope)** — admin/director only via UI gate; full second-signer flow ships in 1g.
- **Property data portability — exit-to-new-agent requirement** — forward-looking; per-property partition must be preserved as schema evolves.
- **Transactions UX rules** (1e) — sign convention, dual-auth gate, demand auto-status, reconciled / statement-import locks, delete policy.
- **Payment Authorisations design** (1f) — JSONB-snapshot pattern, two-write authorise (non-atomic, recoverable), self-auth guard, cancel-by-requester asymmetry, demand auto-status forward-only.
- **Per-property invoice spend cap** (forward-looking) — defaults from contract, editable per property, director approval over cap.
- **Payment authorisation role taxonomy** (forward-looking) — future `payment_approver` role with per-account allow-lists and authority limits.
- **Test-user seed pattern + plus-addressing + Size M / L flags** (1f.5) — Dashboard-applied SQL is canonical; per-role storage state files; Size M / Size L demo data scopes documented.
- **Demo mode toggle** (forward-looking) — single demo firm; one-action exit-demo cascades; pre-flight confirmation + audit log entry.
- **Closure dual-auth design** (1g) — `action_type` discriminator on `payment_authorisations`; proposed JSONB shape varies by action_type; reuses the queue UI; `inter_account_transfer` and `toggle_rics_designation` deferred.

## Open work — next session starts here

The natural next sub-deliverable per §7 of the handoff is **bank reconciliation workflow**. Schema is already in place: `transactions.reconciled` + `reconciled_at` + `reconciled_by` columns (00005:118-138), `bank_statement_imports` table (00005:232). What's missing is the UI:

- A reconciliation tab (or a sub-page off TransactionsTab) where the PM picks a bank account + a date range, sees unreconciled transactions, and matches them against bank statement lines.
- "Mark reconciled" and "Mark unreconciled" actions, with an audit stamp (`reconciled_at`, `reconciled_by`).
- The reconciled-lock from 1e already prevents edits to reconciled transactions — the new UX only adds the marking flow.
- Reconciliation report output (probably a later commit; balance-as-of-date plus reconciled-vs-unreconciled summary).

**Smaller candidates that could come first if you want quick wins:**

1. **1g.5** — RICS-designation toggle dual-auth. Tiny: extends `action_type` CHECK, adds `ProposedRicsDesignationToggle` interface, adds branches in `handleAuthorise` and the row renderer. ~30 min.
2. **Size M demo data** — realistic firm + properties + financial entities at varied states. Recorded in DECISIONS 2026-05-10. Useful for screenshots / exploratory testing / sales demos. Medium-sized commit (2-3 hours).

**My recommendation for the next chat:** start with **1g.5** (small, completes the 1d.1 → 1g closure-dual-auth story across all critical bank-account actions), then **bank reconciliation** as the substantial Phase 3 piece. Defer Size M / Size L demo data to phase boundary unless a demo / screenshot need surfaces sooner.

## Things to watch

- **Server-side enforcement is still missing.** SCA finalisation lock, demand s.21B guard, paid lock, reconciled lock, statement-import lock, dual-auth gate, self-auth guard, closure authorise — all client-side only. The financial-rules Edge Function is named in the handoff but does not yet exist. When it lands it should reject the same set of writes the UI currently rejects.
- **LTA s.20B 18-month banding warning is still deferred** — recorded in DECISIONS so it doesn't get forgotten.
- **PDF demand generation is still out of scope** — `document_id` stays null. Separate worker commit later.
- **`inter_account_transfer` paired-row authorisation** — schema enum supports it; UI doesn't surface it. Same gap mentioned in 1e and 1g DECISIONS entries.
- **`authority_limit` enforcement not implemented** — column exists; PoC uses role only.
- **Atomic transactional wrap of authorise (payment AND closure) is non-atomic** — failure mode is recoverable but flagged for the financial-rules Edge Function.
- **Firm-wide pending-authorisations dashboard** — admins must drill into each property to see pending requests. Recorded in DECISIONS 2026-05-10 as a future enhancement; might be worth pulling forward when 1g.5 lands.
- **Audit log entries for authorise / reject / cancel events** — Phase 5+ (dedicated audit table).
- **Demo mode toggle** — Phase 6+; design constraint already recorded.
- **Per-property invoice spend cap** — forward-looking; design constraint already recorded.
- **The `unitMap` rebuild in `PropertyDetailPage.tsx:168`** — pre-existing 1a code; minor re-render perf concern; flagged-and-deferred from the audit pass.

## State of the build

- **Migrations applied through:** 00023 (00022 added `proposed JSONB`; 00023 added `action_type` discriminator)
- **Tests passing:** 85 / 85 (1 admin setup + 1 PM setup + 83 active smokes)
- **Last green CI run:** not run (no CI configured; local-only smoke gate)
- **Pushed to origin/main:** yes — `24243ae` is the tip
- **Test users seeded:** `admin@propos.local`, `pm@propos.local`, `director@propos.local`
- **Worktree branch:** `claude/condescending-mclaren-7f7724` is in sync with origin/main
- **Open issues:** none blocking; deferred items above are scheduled, not bugs

## Suggested first message for next session

Substitute the work focus depending on which next-step you choose:

```
Hello Claude. You are the build engineer for PropOS, on Opus 4.7.
Phase 3 commits 1a-1g shipped on origin/main (latest 24243ae).
Read PropOS_Handoff_Document_v1_6_1.docx (in C:\Users\bengr\Downloads\),
/docs/DECISIONS.md, /docs/LESSONS_LEARNED.md, /docs/HANDOVER_2026-05-10_phase3_1g.md,
and pick up at <next work item — see Open Work section of the handover note>.
State the file list, tests, AND UX rules BEFORE writing code per the standing
plan-first rule. Surface context-window status per §12, anchored to the
harness's actual context indicator.
Build state: 85/85 smoke passing. Migrations: 00023 latest. Test users:
admin / pm / director seeded. The pattern: write migration SQL, ask me to
apply via Supabase Dashboard SQL Editor before running smokes.
```

Recommended first work item: **1g.5 (RICS-designation toggle dual-auth)** as a quick win, then **bank reconciliation workflow** as the substantial next Phase 3 piece.
