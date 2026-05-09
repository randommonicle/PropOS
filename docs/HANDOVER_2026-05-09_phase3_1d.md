# Handover Note — 2026-05-09, Phase 3 (in progress), context ~29% (green)

Produced voluntarily at end of session — not triggered by a §12 amber/red threshold. Intent: give the next chat a clean cold-start surface so it doesn't have to reverse-engineer state from `git log`.

## Completed this session

- `dea9670` feat(financial): service charge accounts tab + status state machine. SCA tab as the 5th per-property tab; finalised lock; client-stamped finalised_at / finalised_by; draft-only delete with RICS Rule 4.7 / TPI §5 messaging. 8 smokes.
- `135ece4` feat(financial): demands tab + LTA s.21B guard + paid lock. Demands as the 6th per-property tab; full state machine `draft → issued → (part_paid → paid | overdue | disputed | withdrawn)`; client-side s.21B guard that blocks `issued_date` and non-draft/-withdrawn statuses without the s.21B summary; auto-stamp issued_date on transition; unit-scoped current-leaseholder picker; draft-only delete with RICS / TPI / LTA s.20B messaging. 10 smokes.
- `82112e5` refactor: audit pass — hoisted shared helpers (`formatYearLabel`, `todayISODate` to lib/utils; `DEMAND_STATUSES`, `ServiceChargeAccountStatus` to lib/constants); both tabs use `slugToTitle` for status / demand-type labels; dropped dead `?? 'secondary'` fallbacks; tightened smoke locators (SCA `Finalised` badge / metadata-line; demands `rowByUnitAndAmount` helper with exact aria-labels); fixed a Rules-of-Hooks violation (`useMemo` above the loading early-return).

All three commits pushed to `origin/main` (fast-forward only). Worktree branch `claude/condescending-mclaren-7f7724` also pushed.

## Decisions taken (also in DECISIONS.md)

- **2026-05-09 — Service charge accounts: finalisation lock, status state machine, delete policy.** State machine `draft → active → reconciling → finalised`; `finalised` is terminal (only `notes` editable); audit columns stamped client-side at the moment of transition; draft-only delete with FK 23503 surfacing.
- **2026-05-09 — Demands: LTA s.21B client guard, status state machine, paid lock, delete policy.** Full state machine; `paid` is terminal (only `notes` editable); s.21B guard rejects save when `issued_date` is set OR status is in {issued, part_paid, paid, overdue, disputed} without `s21b_attached=true`; auto-stamp `issued_date` on draft → issued; unit-scoped leaseholder picker filtered to `is_current=true`; draft-only delete with statutory framework citations.

Both entries explicitly enumerate out-of-scope items so future commits don't accidentally treat absence as approval (see "Things to watch" below).

## Open work — next session starts here

The natural next sub-deliverable per §7 of the handoff is **transactions CRUD per bank account** (Phase 3 commit 1e candidate).

- Schema: `transactions` table at `supabase/migrations/00005_financial_core.sql:118-138`. RLS at `supabase/migrations/00012_rls_policies.sql:122-124` (admin / property_manager only).
- The `sync_bank_account_balance` trigger is already deployed at `00005:144-165` — it maintains `bank_accounts.current_balance` from `SUM(transactions.amount)` on every insert/update/delete. The transactions UI does not need to write the balance directly.
- New tab to add: `app/src/components/modules/financial/TransactionsTab.tsx`, parallel to BankAccountsTab / SCA / Demands. Sixth-going-on-seventh per-property tab? Or per-bank-account drill-down? Worth a UX call before code.
- UX rules to record in DECISIONS: dual-auth threshold gating (`bank_accounts.requires_dual_auth` + `dual_auth_threshold` already on the schema; `payment_authorisations` table at `00005:170` is where the second-signer flow lands); transaction → demand linking (`demand_id` FK, used to mark a demand part_paid / paid); immutable-after-reconciled lock (`reconciled=true` rows lock all fields except notes — mirrors finalised / paid pattern).

Before code, follow the established gate: state file list + test list + UX rules first, wait for confirmation.

## Things to watch

- **Server-side enforcement is missing.** SCA finalisation lock, demand s.21B guard, paid-lock, and finalised-lock are all client-side only in 1c/1d. The `financial-rules` Edge Function is named in the handoff and the schema comments but does not yet exist. Defence-in-depth for non-UI writers (imports, scripts, future API consumers) is deferred. When the function lands, it should reject the same set of writes the UI currently rejects.
- **LTA s.20B 18-month banding warning is deferred.** When an `issued_date` is set for expenditure incurred more than 18 months earlier, the demand is legally unrecoverable. Surfacing this requires demand-history context across the property. Recorded in DECISIONS so it doesn't get forgotten.
- **One-active-SCA-per-year constraint is deferred.** Recorded in DECISIONS; will land alongside reconciliation when "active" is precise enough to pin down a uniqueness constraint without false positives across mid-year handovers.
- **PDF demand generation is out of scope for 1d.** `document_id` stays null. Separate worker commit later.
- **Bulk demand generation per accounting period** — separate ledger commit.
- **The `unitMap` rebuild in `PropertyDetailPage.tsx:168`** was flagged by the audit as a re-render perf concern but is out of strict 1c/1d scope — pre-existing 1a code. Negligible at current data volumes; flag if a property accumulates many leaseholders.
- **Worktree dev server pattern.** `app/playwright.worktree.config.ts` is committed; future worktree commits should use it from commit 1 of the work, not after debugging a "tab missing" failure.

## State of the build

- **Migrations applied through:** 00021 (no schema changes in this session)
- **Tests passing:** 62 / 62 (1 setup + 44 baseline + 8 SCA + 10 demands), 1.2 min suite via `playwright.worktree.config.ts`
- **Last green CI run:** not run (no CI configured; local-only smoke gate)
- **Pushed to origin/main:** yes — `82112e5` is the tip
- **Open issues:** none blocking; deferred items above are scheduled, not bugs

## Suggested first message for next session

```
Hello Claude. You are the build engineer for PropOS, on Opus 4.7.
Phase 3 commits 1a-1d + audit refactor (82112e5) shipped on origin/main.
Read PropOS_Handoff_Document_v1_6_1.docx (in C:\Users\bengr\Downloads\),
/docs/DECISIONS.md, /docs/LESSONS_LEARNED.md, and pick up at commit 1e:
TransactionsTab as the next per-property tab. Schema for transactions is
already deployed in 00005:118-138 with the sync_bank_account_balance
trigger maintaining bank_accounts.current_balance; RLS in 00012:122-124.
State the file list, tests, AND UX rules (dual-auth, demand linking,
reconciled lock) for 1e BEFORE writing code. Surface context-window
status per §12, anchored to the harness's actual context indicator.
Build state: 62/62 smoke passing. No schema changes since 00021.
```
