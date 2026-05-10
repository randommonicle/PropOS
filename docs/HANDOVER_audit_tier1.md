# Handover — Audit Tier-1 sweep (before Phase 4 entry)

**Status at handover:** 2026-05-10 end-of-session. PR #1 open with the 1i.3 role-architecture rework + the cross-phase audit (`docs/AUDIT_2026-05-10.md`) + Handoff Document v1.7. The audit surfaces a 3-CRITICAL attack chain and a Tier-1 citation-drift cluster that should land **before** Phase 4 starts so the BSA module composes against a clean baseline.

This document is the single-file brief — read it cold and pick up. Mirror of `docs/HANDOVER_1i3.md`.

---

## Where things stand on origin/main + PR #1

Most recent commit on the branch: `49a6738`. PR #1 is open and carries all three 1i.3 commits + the audit + v1.7. Reviewer-decision before merge: ship as-is, or block on the Tier-1 sweep landing first.

```
49a6738 docs: cross-phase audit + Handoff Document v1.7
a6ad0e2 feat(contractors): function-split + segregation gate -- closes 1i.3 (phase 3)
b83aaf3 feat(auth): role architecture rework -- junction + multi-role JWT claim (1i.3 phase 1+2)
9712751 docs: handover for 1i.3 role architecture rework  (← origin/main HEAD)
```

**Decision the operator needs to make first thing in the new chat:** merge PR #1 as-is, OR rebase the Tier-1 sweep onto the same branch and merge as one unit. Both are reasonable; the audit was deliberately written as a docs-only commit so it could land independently of either choice.

---

## What the Tier-1 sweep closes

**3 CRITICAL findings = one attack chain** (Audit §1, anchors A-1 / A-2 / A-3): when 1i.3 widened `is_pm_or_admin()` to include `accounts` + `senior_pm`, the RLS write policies on `payment_authorisations`, `bank_accounts`, `contractors` inherited the widening. The self-auth and payee-setter ≠ release-authoriser segregation gates are enforced **application-side only** in `PaymentAuthorisationsTab.handleAuthorise`. An `accounts` user with direct supabase-js can chain four writes to move money with single-staff involvement, defeating RICS Client money handling — segregation of duties.

**9 Tier-1 findings = one UI sweep** (Audit §2, anchors R-1 / R-2 / R-3 / R-4 / R-5 / B-3 / B-5): deprecated "RICS Client Money Rule 4.7" framing in 1d/1e/1g.5 era code; two 1i.2 director-exclusion UI propagation gaps; literal `§X.X` placeholder in 00028; two non-atomic flows with regulatory weight.

---

## Decomposition shape — two commits

**Commit 1 (security, regulatory load-bearing):** `fix(security): self-auth RLS + column-grants on contractors/bank_accounts (audit Tier-1)`. Single new migration `00030_security_audit_tier1.sql` + 3 new smokes. ~150 lines SQL + ~80 lines smoke code. Apply via Dashboard SQL Editor; verify; smoke; commit. Pattern mirrors 1i.1 §C-1 column-grant work.

**Commit 2 (UI / lexical, citation canonicalisation):** `fix(ui): RICS citation canonicalisation + 1i.2 director-exclusion propagation (audit Tier-1)`. 6 components + 4 specs + 1 migration comment + DECISIONS update. ~120 lines net change. Mostly mechanical; no migration; no Dashboard step.

Order matters: commit 1 first so the regulatory-load-bearing fix is on origin before the citation sweep lands. If the citation sweep finds an issue, the safety net is already in place.

---

## File list (commit 1 — security)

### Migration (1)
- `supabase/migrations/00030_security_audit_tier1.sql` — ~150 lines:
  - `DROP POLICY payment_auth_update; CREATE POLICY ... WITH CHECK (... AND requested_by IS DISTINCT FROM auth.uid())` — closes A-1 self-auth
  - `REVOKE UPDATE ON public.contractors FROM authenticated; GRANT UPDATE (<safe columns>) ON public.contractors TO authenticated` — closes A-2 (mirrors 1i.1 C-1 pattern)
  - Same shape for `bank_accounts` excluding `is_active`, `closed_date`, `rics_designated` — closes A-3
  - Verification queries Q1–Q5 (catalog asserts) inlined as comments at the bottom — mirrors 00029
  - Two FORWARD: PROD-GATE flags planted (server-side segregation gate via Edge Function; financial-rules Edge Function)

### Smokes (~3 new in `security-rls.spec.ts`)
- **C-1-new** — accounts user direct `UPDATE payment_authorisations SET status='authorised', authorised_by=<self>` on a PA they raised → expect 42501 RLS rejection.
- **C-2-new** — accounts user direct `UPDATE contractors SET approved_by=<self>, approved=true` → expect column-grant rejection (42501).
- **C-3-new** — pm user direct `UPDATE bank_accounts SET is_active=false WHERE id=<closed-bank>` → expect column-grant rejection. Mirror smoke for `rics_designated`.

### Migration plan must include verification (memory rule)
Q1: `auth_user_role()` residue check (should still be 0 from 00029)
Q2: New `payment_auth_update` policy has the self-auth predicate (`pg_get_expr(polwithcheck, polrelid) LIKE '%requested_by%'`)
Q3: Column grants on `contractors` exclude `approved_by`, `approved_at`, `approved`
Q4: Column grants on `bank_accounts` exclude `is_active`, `closed_date`, `rics_designated`
Q5: Existing PA flows (authorise + cancel-by-requester) still work — covered by full smoke run post-apply

---

## File list (commit 2 — UI sweep)

### Components (4 files)
- `app/src/components/modules/financial/BankAccountsTab.tsx` — 6 sites: closure copy (lines ~127, 160, 181, 213, 419, 455). Replace "Rule 4.7" / "Client Money" → "Client money handling — segregation of duties" (segregation paths) or "Rule 3.7 evidence trail" (retention paths per Audit R-4 anchor key). Replace "admin or director" / "admin and director" → "admin staff" wherever the `canManageClosure` gate is admin-only.
- `app/src/components/modules/financial/DemandsTab.tsx` — line 127-128 hard-delete prohibition. Anchor: `RICS Rule 3.7 evidence trail; TPI Consumer Charter & Standards Edition 3` + `LTA 1985 s.20B audit chain`.
- `app/src/components/modules/financial/TransactionsTab.tsx` — line 89 + 168-169. Anchor: `RICS Rule 3.7 evidence trail` (retention).
- `app/src/components/modules/financial/ServiceChargeAccountsTab.tsx` — lines 90-91 + 103. Anchor: `RICS Rule 3.7 evidence trail`.
- `app/src/components/modules/financial/PaymentAuthorisationsTab.tsx:446` — replace `Authorisation actions are restricted to admin and director roles.` with `Authorisation actions are restricted to admin staff (RICS Client money handling — both signatories must be staff of the firm).`. Also wrap `authorisePayeeSetup` two-write path in try/catch with contractor-stamp rollback (B-3).
- `app/src/components/modules/financial/ReconciliationCompleteModal.tsx:154-218` — wrap audit-log write in try/catch + surface manual-repair message (B-5; RICS Rule 3.7 evidence trail load-bearing).
- `app/src/components/modules/financial/InvoicesTab.tsx:216` — anchor to `RICS Rule 3.7 evidence trail; TPI Consumer Charter & Standards Edition 3` (currently `(RICS Client money handling)` — wrong anchor).

### Smoke specs (4 files; literal regex updates)
- `app/tests/smoke/financial-bank-accounts.spec.ts` — lines 198, 220: `RICS Client Money Rule 4\.7` → `RICS Client money handling`
- `app/tests/smoke/financial-demands.spec.ts` — lines 299, 317: same swap (or `RICS Rule 3\.7` for retention assertions)
- `app/tests/smoke/financial-service-charge-accounts.spec.ts` — lines 227, 263
- `app/tests/smoke/financial-payment-authorisations.spec.ts` — lines 607, 610. Plus add a new smoke pinning the new line-446 string.

### Migrations
- `supabase/migrations/00030_*.sql` (the security commit) carries a one-line annotation in its preamble pointing back to 00028 PROD-GATE flags 8 + 9 (closed by 1i.3 / 00029) and the `§X.X` placeholder note (R-5 — convention: leave 00028 as-is per append-only rule; document the supersession here).

### Docs (3)
- `docs/DECISIONS.md` — new entry covering the Tier-1 sweep. Reference Audit IDs A-1/A-2/A-3 + R-1/.../R-5 + B-3/B-5. Establishes the citation anchor convention (segregation → "RICS Client money handling"; retention → "RICS Rule 3.7 evidence trail").
- `docs/LESSONS_LEARNED.md` — Phase 3 session 5 stub: "RLS-vs-UI gate divergences emerge when role helpers widen; column-level grants are the cleanest defence". Pattern for future: when widening `is_pm_or_admin()`, audit every RLS write policy that calls it before merging.
- `docs/AUDIT_2026-05-10.md` — annotate closed findings (A-1, A-2, A-3, R-1, R-2, R-3, R-4, R-5, B-3, B-5) with `CLOSED <commit>`. Audit doc serves as the working punch-list; closed items remain visible for audit trail.

---

## Standing pattern when picking this up

1. **Plan-first gate signed off** for the migration shape via the audit findings. Don't re-derive the SQL — the AUDIT doc §1 + §2 has the canonical form. The plan-first remains worthwhile for the smoke list + the UI sweep file list before any code.
2. **Apply migration via Dashboard SQL Editor** (memory rule). Run verification queries Q1-Q5 immediately after; paste results back to Claude before moving to commit 2.
3. **Worktree dev server on 5174** with `playwright.worktree.config.ts` (memory rule `project_worktree_dev_server`). Junction `app/node_modules` → main repo's `app/node_modules` is in place from the 1i.3 session — re-use, don't re-install.
4. **Smoke after each commit.** Commit 1 (security) → run full smoke suite + the 3 new RLS smokes. Commit 2 (UI sweep) → run full smoke suite; all 4 modified smoke specs must go red-then-green in the same commit (UI string change + smoke regex must move in lockstep per Audit R-2 / R-3).
5. **Ask before push or merge.** Per-action authorisation (memory rule `feedback_confirm_before_push`).
6. **Statutory citation as test anchor pattern** — the same string is the UI message AND the smoke assertion (LESSONS Phase 3 session 2). When changing one, change the other in the same commit or smokes will go red.

---

## Pre-flight on this plan in the next session

Before writing any code, confirm:

1. PR #1 status — open / merged / closed. If still open, decide whether the Tier-1 sweep lands on the same branch (rebase) or a follow-on branch.
2. `git log --oneline origin/main` shows `49a6738` at or above HEAD.
3. The 5 Tier-1 audit findings are still grep-able as quoted in this doc: `grep -n "admin and director" app/src/components/modules/financial/PaymentAuthorisationsTab.tsx` → returns line 446; `grep -rn "RICS Client Money Rule 4.7" app/src/` returns 9+ occurrences (R-1 + R-3 cluster).
4. Test users still resolve: `SELECT email FROM public.users WHERE email LIKE '%@propos.local'` → 6 rows (admin / pm / director / accounts / senior_pm / auditor).
5. Re-read `docs/AUDIT_2026-05-10.md` §1 (CRITICAL findings) + §2 (Tier-1 sweep) before drafting any code.

---

## Out of scope for this sweep (FORWARD anchors)

| # | Item | Reason deferred |
|---|---|---|
| 1 | Server-side segregation gate (financial-rules Edge Function) | Application-side gate + RLS self-auth predicate is regulatory-acceptable; Edge Function lift folds into the existing financial-rules commit |
| 2 | Encrypted contractor bank-detail columns | Data-integrity / auto-protect pass commit; PoC compromise on `contractors.notes` JSON stash is regulatory-acceptable for demo |
| 3 | BSA citation form canonicalisation | Phase 4 entry-criteria — pre-empt then |
| 4 | Pre-commit hook opportunities (5 linters) | Dedicated CI commit; not blocking Phase 4 |
| 5 | All other non-atomic flows (B-1, B-2, B-4, B-6, B-7, B-8) | Folded into financial-rules Edge Function commit |
| 6 | Tier-3 cleanup (remove `firmContext.role` legacy + `auth_user_role()` SQL + `as any` casts) | Opportunistic; not blocking |

---

## Estimated scope

- **Commit 1 (security):** ~150 lines SQL + ~80 lines smoke + 5 verification queries + DECISIONS entry. Single-session work unit; ~1 hour Claude time + 5 min Dashboard apply.
- **Commit 2 (UI sweep):** ~120 lines net across 6 components + 4 smoke specs + DECISIONS update. Single-session work unit; ~45 min Claude time, no Dashboard step.
- **Total:** comparable in shape to 1i.1 minus the migration scale — two small / medium commits, both yellow-band safe per memory rule.

After both land, Phase 4 (BSA module) can start clean in a fresh chat.
