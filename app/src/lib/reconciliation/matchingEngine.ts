/**
 * @file matchingEngine.ts
 * @description Three-pass matching algorithm. Spec §5.3 "Matching Algorithm".
 *
 * Pass 1: amount-to-the-penny + ±2 days + (statement reference contains
 *         transaction reference OR statement payee_payer matches transaction
 *         payee_payer). Confidence 1.00. Auto-matched, no PM review required.
 * Pass 2: amount-to-the-penny + ±7 days. Confidence 0.80. PM one-click confirm.
 * Pass 3: amount-to-the-penny + ±30 days OR amount within £0.50 + ±7 days.
 *         Confidence 0.50. PM "review carefully" list.
 *
 * Constraint: a transaction can only match one statement row, and a statement
 * row can only match one transaction. Once matched, both are removed from the
 * candidate pool for subsequent passes (spec §5.3).
 *
 * Responsible for: pure-functional matching of statement rows to candidate
 *                  transactions; producing a structured result the review UI
 *                  consumes.
 * NOT responsible for: writing reconciliation flags to the DB, writing audit
 *                      log rows (auditLog.ts), the review UI itself
 *                      (ReconciliationReviewModal.tsx).
 *
 * FORWARD: PROD-GATE — client-side matching is PoC-grade. The spec says the
 * engine is implemented as Edge Function `reconciliation_engine.ts`. Before
 * any firm exits demo mode, the matching call must move server-side so:
 *   1. The matching result and the corresponding transactions.reconciled flips
 *      happen inside one transactional wrap (no torn states under refresh).
 *   2. Statutory citations on the audit-log rows are stamped from server
 *      context, not client payload.
 *   3. The audit-log INSERT is the only path that's INSERT-only RLS-allowed
 *      (mirrors the documents §5.7 retention pattern from spec).
 * Anchor: DECISIONS 2026-05-10 — Production-grade gate manifest item 1.
 */
import type { Database } from '@/types/database'
import type { ParsedStatementRow } from './parseStatement'
import { poundsToP } from '@/lib/money'

type Transaction = Database['public']['Tables']['transactions']['Row']

export interface MatchResult {
  /** Index into the original raw_data array. */
  statementRowIndex: number
  transactionId:     string
  pass:              1 | 2 | 3
  confidence:        1.00 | 0.80 | 0.50
}

export interface MatchingOutput {
  matches:        MatchResult[]
  /** Indices of statement rows that didn't match anything. */
  unmatchedRowIndices: number[]
  /** IDs of transactions that didn't match anything. Useful for the review
   *  UI's "Match manually" picker — these are the candidates to show. */
  unmatchedTransactionIds: string[]
}

const PENCE_50 = 50  // 50p tolerance for Pass 3's foreign-card-rounding rule
const DAYS_2  = 2
const DAYS_7  = 7
const DAYS_30 = 30

/**
 * Run the three-pass matching algorithm. Pure function — no DB I/O.
 *
 * @param rows         The parsed statement rows (raw_data of bank_statement_imports).
 * @param transactions Unreconciled transactions on the relevant bank_account_id.
 *                     The caller is responsible for filtering — this function
 *                     trusts its input.
 */
export function runMatching(
  rows: ParsedStatementRow[],
  transactions: Pick<Transaction, 'id' | 'amount' | 'transaction_date' | 'reference' | 'payee_payer'>[],
): MatchingOutput {
  // Mutable candidate pools. Every match removes one row + one txn.
  const remainingRows = new Set(rows.map(r => r.index))
  const remainingTxns = new Set(transactions.map(t => t.id))
  const matches: MatchResult[] = []

  // Index transactions by id for O(1) lookup.
  const txnsById = new Map(transactions.map(t => [t.id, t]))

  // Deterministic ordering: by date asc, then amount desc, then index — so
  // tests are stable across runs regardless of DB ordering.
  const orderedRows = [...rows].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    if (a.amountP !== b.amountP) return b.amountP - a.amountP
    return a.index - b.index
  })
  const orderedTxnIds = [...remainingTxns].sort((a, b) => {
    const A = txnsById.get(a)!
    const B = txnsById.get(b)!
    if (A.transaction_date !== B.transaction_date)
      return A.transaction_date < B.transaction_date ? -1 : 1
    const ap = poundsToP(Number(A.amount))
    const bp = poundsToP(Number(B.amount))
    if (ap !== bp) return bp - ap
    return a < b ? -1 : 1
  })

  // ── Pass 1 — exact match ──────────────────────────────────────────────
  for (const row of orderedRows) {
    if (!remainingRows.has(row.index)) continue
    for (const txnId of orderedTxnIds) {
      if (!remainingTxns.has(txnId)) continue
      const t = txnsById.get(txnId)!
      if (matchesPass1(row, t)) {
        matches.push({
          statementRowIndex: row.index,
          transactionId:     txnId,
          pass:              1,
          confidence:        1.00,
        })
        remainingRows.delete(row.index)
        remainingTxns.delete(txnId)
        break
      }
    }
  }

  // ── Pass 2 — strong match (amount+date only, no ref/payee) ────────────
  for (const row of orderedRows) {
    if (!remainingRows.has(row.index)) continue
    for (const txnId of orderedTxnIds) {
      if (!remainingTxns.has(txnId)) continue
      const t = txnsById.get(txnId)!
      if (matchesPass2(row, t)) {
        matches.push({
          statementRowIndex: row.index,
          transactionId:     txnId,
          pass:              2,
          confidence:        0.80,
        })
        remainingRows.delete(row.index)
        remainingTxns.delete(txnId)
        break
      }
    }
  }

  // ── Pass 3 — weak match (two disjunctive subclauses) ──────────────────
  for (const row of orderedRows) {
    if (!remainingRows.has(row.index)) continue
    for (const txnId of orderedTxnIds) {
      if (!remainingTxns.has(txnId)) continue
      const t = txnsById.get(txnId)!
      if (matchesPass3(row, t)) {
        matches.push({
          statementRowIndex: row.index,
          transactionId:     txnId,
          pass:              3,
          confidence:        0.50,
        })
        remainingRows.delete(row.index)
        remainingTxns.delete(txnId)
        break
      }
    }
  }

  return {
    matches,
    unmatchedRowIndices:     [...remainingRows].sort((a, b) => a - b),
    unmatchedTransactionIds: [...remainingTxns],
  }
}

// ── Pass predicates ─────────────────────────────────────────────────────────

function matchesPass1(row: ParsedStatementRow, t: { amount: number; transaction_date: string; reference: string | null; payee_payer: string | null }): boolean {
  const txnAmountP = poundsToP(Number(t.amount))
  if (txnAmountP !== row.amountP) return false
  if (Math.abs(daysBetween(row.date, t.transaction_date)) > DAYS_2) return false
  // (statement reference contains transaction reference) OR (payees match)
  return refOrPayeeMatch(row, t)
}

function matchesPass2(row: ParsedStatementRow, t: { amount: number; transaction_date: string }): boolean {
  const txnAmountP = poundsToP(Number(t.amount))
  if (txnAmountP !== row.amountP) return false
  return Math.abs(daysBetween(row.date, t.transaction_date)) <= DAYS_7
}

function matchesPass3(row: ParsedStatementRow, t: { amount: number; transaction_date: string }): boolean {
  const txnAmountP = poundsToP(Number(t.amount))
  const days = Math.abs(daysBetween(row.date, t.transaction_date))
  // Subclause A: amount-to-the-penny + ±30 days
  if (txnAmountP === row.amountP && days <= DAYS_30) return true
  // Subclause B: amount within £0.50 + ±7 days (foreign-card-rounding tolerance)
  if (Math.abs(txnAmountP - row.amountP) <= PENCE_50 && days <= DAYS_7) return true
  return false
}

function refOrPayeeMatch(
  row: ParsedStatementRow,
  t: { reference: string | null; payee_payer: string | null },
): boolean {
  // (statement reference contains transaction reference)
  if (t.reference && row.reference) {
    if (norm(row.reference).includes(norm(t.reference))) return true
  }
  // (statement payee_payer matches transaction payee_payer)
  if (t.payee_payer && row.payee) {
    if (norm(row.payee) === norm(t.payee_payer)) return true
  }
  return false
}

function norm(s: string): string {
  return s.trim().toLowerCase()
}

/** Returns (a - b) in days. Both inputs are ISO YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  const aMs = Date.parse(a + 'T00:00:00Z')
  const bMs = Date.parse(b + 'T00:00:00Z')
  return Math.round((aMs - bMs) / (1000 * 60 * 60 * 24))
}
