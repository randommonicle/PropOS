/**
 * @file PaymentAuthorisationsTab.tsx
 * @description Per-property payment authorisations queue. Eighth tab on
 * PropertyDetailPage.
 *
 * Responsible for: listing pending / authorised / rejected `payment_authorisations`
 *                  rows scoped to bank accounts on this property; the
 *                  authorise / reject / cancel actions for each row; the
 *                  client-side self-authorisation guard and role guard;
 *                  insertion of the actual `transactions` row from the
 *                  proposed JSONB snapshot on authorisation; demand
 *                  auto-status update if the authorised payment is linked
 *                  to a demand.
 * NOT responsible for: server-side enforcement of the auth flow (deferred
 *                      to the financial-rules Edge Function); email or
 *                      in-app notifications to authorisers (Phase 5);
 *                      authority-limit enforcement (the column exists but
 *                      is not surfaced — DECISIONS 2026-05-10);
 *                      firm-wide pending-authorisations dashboard (later);
 *                      audit log entries (Phase 5+).
 *
 * Regulatory rules (DECISIONS 2026-05-10 — Payment Authorisations):
 *   1. Self-authorisation is BLOCKED. The authorising user MUST NOT be the
 *      requester. Surfaces an inline error citing RICS Client Money / TPI
 *      segregation of duties. Self-rejection (cancel-by-requester) IS
 *      permitted and is exposed as a separate "Cancel request" action.
 *   2. Role guard. Only `admin` (staff) may authorise or reject. RMC
 *      directors / freeholder representatives — the `director` role — are
 *      CLIENT-side and explicitly excluded from staff finance gates per RICS
 *      Client money handling (1st ed., Oct 2022 reissue): both signatories
 *      must be staff of the regulated firm. Updated in 1i.2 (was admin +
 *      director; the director inclusion was a latent regulatory bug).
 *   3. On authorise, two writes happen client-side: (a) INSERT a transactions
 *      row from the proposed JSONB snapshot; (b) UPDATE the PA row with
 *      transaction_id, status='authorised', authorised_by, authorised_at.
 *      Failure between (a) and (b) leaves the system in a recoverable state
 *      (transaction created, PA still pending — surfaces in the queue).
 *      Atomic transactional wrap deferred to the financial-rules Edge Function.
 *   4. Authorised and rejected PAs are immutable. Action buttons are absent.
 */
import { useEffect, useState, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Badge, Input } from '@/components/ui'
import { CheckCircle2, XCircle, X, AlertTriangle, Clock, Lock } from 'lucide-react'
import { cn, formatDateTime, slugToTitle } from '@/lib/utils'
import { formatPounds, poundsToP } from '@/lib/money'
import { hasAdminRole, hasPmRole, type PaymentAuthStatus, type CriticalActionType } from '@/lib/constants'
import type {
  Database, ProposedTransaction, ProposedClosure,
  ProposedRicsDesignationToggle, ProposedPayeeSetup, ProposedAction,
} from '@/types/database'

type PaymentAuth         = Database['public']['Tables']['payment_authorisations']['Row']
type Transaction         = Database['public']['Tables']['transactions']['Row']
type BankAccount         = Database['public']['Tables']['bank_accounts']['Row']
type Demand              = Database['public']['Tables']['demands']['Row']

const STATUS_BADGE_VARIANT: Record<PaymentAuthStatus, 'amber' | 'green' | 'destructive'> = {
  pending:    'amber',
  authorised: 'green',
  rejected:   'destructive',
}

const SELF_AUTH_TOOLTIP =
  'Self-authorisation is not permitted. The authorising user must be different ' +
  'from the requester (RICS Client Money rules / TPI Code §5 — segregation of ' +
  'duties). Cancel the request instead if you no longer want to proceed.'

const ROLE_GATE_TOOLTIP =
  'Authorisation is restricted to admin staff. Property Managers and RMC ' +
  'directors cannot authorise or reject payment authorisation requests. ' +
  'RICS Client money handling — both signatories must be staff of the firm.'

export function PaymentAuthorisationsTab({
  firmId,
  propertyId,
}: {
  firmId: string
  propertyId: string
}) {
  const userId = useAuthStore(s => s.user?.id ?? null)
  const roles = useAuthStore(s => s.firmContext?.roles ?? null)
  const canAuthorise = hasAdminRole(roles)

  const [auths,    setAuths]    = useState<PaymentAuth[]>([])
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [demands,  setDemands]  = useState<Demand[]>([])
  const [loading,  setLoading]  = useState(true)

  const [actionErr,    setActionErr]    = useState<string | null>(null)
  const [rejectingId,  setRejectingId]  = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState<string>('')

  const load = useCallback(async () => {
    // payment_authorisations don't carry property_id directly; we need to filter
    // through the linked bank account (proposed.bank_account_id for pending,
    // transaction.bank_account_id for authorised). Easiest: fetch all PAs for
    // this firm and filter in memory by bank accounts on this property.
    const [paRes, accRes, demRes] = await Promise.all([
      supabase.from('payment_authorisations').select('*')
        .eq('firm_id', firmId).order('requested_at', { ascending: false }),
      supabase.from('bank_accounts').select('*')
        .eq('property_id', propertyId).order('account_name'),
      supabase.from('demands').select('*')
        .eq('property_id', propertyId),
    ])
    setAccounts(accRes.data ?? [])
    setDemands(demRes.data ?? [])

    const propertyAccountIds = new Set((accRes.data ?? []).map(a => a.id))
    // Need transaction.bank_account_id for authorised payment rows; fetch the
    // txns referenced by authorised payment-type PAs in this firm.
    const authorisedTxnIds = (paRes.data ?? [])
      .map(p => p.transaction_id)
      .filter((id): id is string => !!id)
    let txnAccountById = new Map<string, string>()
    if (authorisedTxnIds.length) {
      const { data: txns } = await supabase
        .from('transactions').select('id, bank_account_id')
        .in('id', authorisedTxnIds)
      txnAccountById = new Map(
        (txns ?? []).map(t => [t.id, t.bank_account_id]),
      )
    }
    // Filter by property:
    //  - payment_release / close_bank_account / toggle_rics_designation:
    //    proposed (or the linked transaction) carries a bank_account_id;
    //    keep the row only when that account is on this property.
    //  - payment_payee_setup: contractor-scoped, not bank-account-scoped.
    //    Show on every property tab so admins have a UI surface to authorise
    //    (firm-level PA dashboard is FORWARD: PROD-GATE — Phase 5 admin
    //    module). PoC compromise; not regulatory-load-bearing.
    const filtered = (paRes.data ?? []).filter(p => {
      if (p.action_type === 'payment_payee_setup') return true
      const proposedAccId =
        (p.proposed as Exclude<ProposedAction, ProposedPayeeSetup> | null)?.bank_account_id
      const accId = proposedAccId
        ?? (p.transaction_id ? txnAccountById.get(p.transaction_id) : undefined)
      return accId ? propertyAccountIds.has(accId) : false
    })
    setAuths(filtered)
    setLoading(false)
  }, [firmId, propertyId])

  useEffect(() => { load() }, [load])

  const accountMap = useMemo(() => new Map(accounts.map(a => [a.id, a.account_name])), [accounts])
  const demandMap  = useMemo(() => new Map(demands.map(d => [d.id, d])), [demands])

  async function handleAuthorise(pa: PaymentAuth) {
    setActionErr(null)
    if (!userId) { setActionErr('User session missing.'); return }
    if (!canAuthorise) { setActionErr(ROLE_GATE_TOOLTIP); return }
    if (pa.requested_by === userId) { setActionErr(SELF_AUTH_TOOLTIP); return }
    if (pa.status !== 'pending') { setActionErr('Only pending requests can be authorised.'); return }
    if (!pa.proposed) { setActionErr('Authorisation has no proposed snapshot.'); return }

    const actionType = (pa.action_type as CriticalActionType) ?? 'payment_release'
    if (actionType === 'payment_release') {
      // Segregation gate: payee-setter ≠ release-authoriser. If the proposed
      // links to a contractor whose bank details were stamped by THIS admin
      // (contractors.approved_by === userId), block the authorise. RICS
      // Client money handling — segregation of duties.
      const txn = pa.proposed as ProposedTransaction
      const contractorId = txn.contractor_id ?? null
      if (contractorId) {
        const { data: contractor } = await supabase
          .from('contractors')
          .select('approved_by, company_name')
          .eq('id', contractorId)
          .single()
        if (contractor?.approved_by && contractor.approved_by === userId) {
          setActionErr(
            `Segregation of duties: you stamped ${contractor.company_name ?? 'this contractor'}'s ` +
            'bank details (payee_setup), so a different admin must authorise the ' +
            'payment_release. RICS Client money handling — segregation of duties.',
          )
          return
        }
      }
      await authorisePayment(pa, txn)
    } else if (actionType === 'payment_payee_setup') {
      await authorisePayeeSetup(pa, pa.proposed as ProposedPayeeSetup)
    } else if (actionType === 'close_bank_account') {
      await authoriseClosure(pa, pa.proposed as ProposedClosure)
    } else if (actionType === 'toggle_rics_designation') {
      await authoriseRicsToggle(pa, pa.proposed as ProposedRicsDesignationToggle)
    } else {
      setActionErr(`Unknown action type: ${actionType}`)
      return
    }
  }

  /**
   * Authorise a payment_payee_setup PA — the function-split first leg.
   * Effect: stamp `contractors.approved_by` + `approved_at` with the
   * authorising user; flip `contractors.approved=true`; commit the proposed
   * bank details onto the contractor row. Then mark the PA authorised.
   *
   * Self-auth guard already applied by handleAuthorise. The same admin who
   * stamps `approved_by` here will subsequently be BLOCKED from authorising
   * a payment_release whose proposed.contractor_id = this contractor — see
   * the gate in handleAuthorise above. RICS Client money handling —
   * segregation of duties.
   */
  async function authorisePayeeSetup(pa: PaymentAuth, proposed: ProposedPayeeSetup) {
    if (!userId) return
    if (!proposed.contractor_id) {
      setActionErr('Proposed payee-setup has no contractor_id.'); return
    }
    const bd = proposed.proposed_bank_details
    // Bank details aren't first-class columns on contractors today (PoC).
    // Stash on `notes` as a structured prefix so the smoke can assert
    // round-trip; production model lands in the data-integrity pass with
    // dedicated encrypted columns. FORWARD: PROD-GATE — contractor bank
    // details schema (encryption + first-class columns).
    const bdLine = JSON.stringify({
      sort_code: bd.sort_code, account_number: bd.account_number,
      account_name: bd.account_name, iban: bd.iban, bic: bd.bic,
    })
    const contractorPatch = {
      approved:    true,
      approved_by: userId,
      approved_at: new Date().toISOString(),
      notes:       `[PAYEE_SETUP_AUTHORISED ${new Date().toISOString()}] ${bdLine}`,
    }

    const { error: cErr } = await supabase
      .from('contractors').update(contractorPatch).eq('id', proposed.contractor_id)
    if (cErr) {
      setActionErr(`Failed to stamp contractor: ${cErr.message}`); return
    }
    const { error: paErr } = await supabase
      .from('payment_authorisations').update({
        status:        'authorised',
        authorised_by: userId,
        authorised_at: new Date().toISOString(),
      }).eq('id', pa.id)
    if (paErr) {
      setActionErr(
        `Contractor stamped but PA link failed: ${paErr.message}. Refresh — ` +
        'authorise again to retry the link.',
      )
      return
    }
    await load()
  }

  async function authorisePayment(pa: PaymentAuth, proposed: ProposedTransaction) {
    if (!userId) return
    // (a) Insert the transaction from the proposed snapshot. invoice_id from
    // the snapshot lands on the transactions row when present (1i.2 — invoice-
    // queue-for-payment flow). transactions.invoice_id FK is at 00005:227.
    const { data: inserted, error: txErr } = await supabase
      .from('transactions').insert({
        firm_id:          firmId,
        property_id:      propertyId,
        bank_account_id:  proposed.bank_account_id,
        transaction_type: 'payment',
        transaction_date: proposed.transaction_date,
        amount:           proposed.amount,
        description:      proposed.description,
        payee_payer:      proposed.payee_payer,
        reference:        proposed.reference,
        demand_id:        proposed.demand_id,
        invoice_id:       proposed.invoice_id ?? null,
        created_by:       pa.requested_by,
      })
      .select('id, demand_id, invoice_id')
      .single()
    if (txErr || !inserted) {
      setActionErr(`Failed to create transaction: ${txErr?.message ?? 'no row returned'}`)
      return
    }
    // (b) Link + mark authorised.
    const { error: paErr } = await supabase
      .from('payment_authorisations')
      .update({
        transaction_id: inserted.id,
        status: 'authorised',
        authorised_by: userId,
        authorised_at: new Date().toISOString(),
      })
      .eq('id', pa.id)
    if (paErr) {
      setActionErr(
        `Transaction created but PA link failed: ${paErr.message}. Refresh — ` +
        'the PA row will appear under pending; authorise again to retry the link.'
      )
      return
    }
    if (inserted.demand_id) {
      await applyDemandReceiptStatus(inserted.demand_id)
    }
    // (c) If this PA pays an invoice, flip invoice → paid + link transaction.
    // Non-atomic with (a) and (b); recoverable because re-running the authorise
    // path is blocked (PA is now `authorised`) but a manual repair is cheap:
    // an admin can `UPDATE invoices SET status='paid', transaction_id=...` for
    // the invoice referenced in the PA's proposed snapshot. The FORWARD: PROD-
    // GATE wrap (financial-rules Edge Function) makes this atomic.
    if (inserted.invoice_id) {
      const { error: invErr } = await supabase
        .from('invoices')
        .update({
          status: 'paid',
          transaction_id: inserted.id,
        })
        .eq('id', inserted.invoice_id)
      if (invErr) {
        setActionErr(
          `Transaction + PA authorised but invoice link failed: ${invErr.message}. ` +
          'The payment is recorded; the invoice may still show as queued. Refresh; ' +
          'manual repair: an admin can flip invoices.status=paid + transaction_id=' +
          `${inserted.id} for invoice ${inserted.invoice_id}.`,
        )
        return
      }
    }
    load()
  }

  /**
   * 1g.5 — apply a RICS-designation toggle from the proposed snapshot. Two
   * writes (non-atomic, recoverable): (a) UPDATE bank_accounts.rics_designated
   * to proposed.new_value; (b) UPDATE the PA row to authorised. transaction_id
   * stays null. The snapshot's new_value is applied verbatim (not "negate
   * current"), so a re-authorise where the row already matches is idempotent.
   * See DECISIONS 2026-05-10 1g.5.
   */
  async function authoriseRicsToggle(
    pa: PaymentAuth, proposed: ProposedRicsDesignationToggle,
  ) {
    if (!userId) return
    const { error: baErr } = await supabase
      .from('bank_accounts')
      .update({ rics_designated: proposed.new_value })
      .eq('id', proposed.bank_account_id)
    if (baErr) {
      setActionErr(`Failed to update RICS designation: ${baErr.message}`)
      return
    }
    const { error: paErr } = await supabase
      .from('payment_authorisations')
      .update({
        status: 'authorised',
        authorised_by: userId,
        authorised_at: new Date().toISOString(),
      })
      .eq('id', pa.id)
    if (paErr) {
      setActionErr(
        `Designation updated but PA link failed: ${paErr.message}. Refresh — ` +
        'the toggle landed; the PA row may still show pending until refresh.'
      )
      return
    }
    load()
  }

  async function authoriseClosure(pa: PaymentAuth, proposed: ProposedClosure) {
    if (!userId) return
    // (a) Mark the bank account closed. Trigger-maintained current_balance is
    // unaffected — no transactions move; we just flip is_active and stamp the
    // closed_date. The application sets closed_date to the proposed value
    // (snapshot from the moment of request), not "now", so the audit trail
    // reflects the requester's intent.
    const { error: baErr } = await supabase
      .from('bank_accounts')
      .update({
        is_active: false,
        closed_date: proposed.closed_date,
      })
      .eq('id', proposed.bank_account_id)
    if (baErr) {
      setActionErr(`Failed to close account: ${baErr.message}`)
      return
    }
    // (b) Mark the PA authorised. transaction_id stays null for closure rows.
    const { error: paErr } = await supabase
      .from('payment_authorisations')
      .update({
        status: 'authorised',
        authorised_by: userId,
        authorised_at: new Date().toISOString(),
      })
      .eq('id', pa.id)
    if (paErr) {
      setActionErr(
        `Account closed but PA link failed: ${paErr.message}. Refresh — ` +
        'the closure landed; the PA row may still show pending until refresh.'
      )
      return
    }
    load()
  }

  async function handleReject(pa: PaymentAuth, reason: string, asRequester: boolean) {
    setActionErr(null)
    if (!userId) { setActionErr('User session missing.'); return }
    if (pa.status !== 'pending') { setActionErr('Only pending requests can be rejected.'); return }
    // Requester can always cancel their own request. Non-requesters need the role gate.
    if (!asRequester && !canAuthorise) { setActionErr(ROLE_GATE_TOOLTIP); return }

    const { error } = await supabase
      .from('payment_authorisations')
      .update({
        status: 'rejected',
        rejected_by: userId,
        rejected_at: new Date().toISOString(),
        rejection_reason: reason || (asRequester ? 'Cancelled by requester' : null),
      })
      .eq('id', pa.id)
    if (error) { setActionErr(error.message); return }
    // 1i.2 — invoice-linked PA cancel/reject reverts the invoice from queued
    // back to approved so an accounts user can re-queue (or the PM can dispute
    // / reject the invoice). Without this, a rejected PA leaves the invoice
    // stranded in `queued` with no path forward.
    const proposedInvoiceId =
      (pa.proposed as ProposedTransaction | null)?.invoice_id ?? null
    if (proposedInvoiceId && pa.action_type === 'payment_release') {
      await supabase
        .from('invoices')
        .update({ status: 'approved' })
        .eq('id', proposedInvoiceId)
        .eq('status', 'queued')
    }
    setRejectingId(null)
    setRejectReason('')
    load()
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading payment authorisations…</div>
  }

  return (
    <section aria-label="Payment authorisations">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">
          Payment authorisations ({auths.length})
        </h2>
        {!canAuthorise && hasPmRole(roles) && (
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Lock className="h-3 w-3" />
            Authorisation actions are restricted to admin and director roles.
          </span>
        )}
      </div>

      {actionErr && (
        <div className="mb-3 flex items-start gap-2 text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1" data-testid="action-error">{actionErr}</span>
          <button onClick={() => setActionErr(null)} aria-label="Dismiss error">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="text-left px-4 py-2 font-medium">Requested</th>
              <th className="text-left px-4 py-2 font-medium">Account</th>
              <th className="text-left px-4 py-2 font-medium">Description</th>
              <th className="text-left px-4 py-2 font-medium">Payee</th>
              <th className="text-right px-4 py-2 font-medium">Amount</th>
              <th className="text-left px-4 py-2 font-medium">Demand</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {auths.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  No payment authorisation requests pending.
                </td>
              </tr>
            ) : (
              auths.map(pa => (
                <PaymentAuthRow
                  key={pa.id}
                  pa={pa}
                  accountMap={accountMap}
                  demandMap={demandMap}
                  currentUserId={userId}
                  canAuthorise={canAuthorise}
                  isRejecting={rejectingId === pa.id}
                  rejectReason={rejectingId === pa.id ? rejectReason : ''}
                  onRejectReasonChange={setRejectReason}
                  onAuthorise={() => handleAuthorise(pa)}
                  onAskReject={() => { setRejectingId(pa.id); setRejectReason(''); setActionErr(null) }}
                  onConfirmReject={(reason, asRequester) => handleReject(pa, reason, asRequester)}
                  onCancelReject={() => { setRejectingId(null); setRejectReason('') }}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ── Single row ────────────────────────────────────────────────────────────────
function PaymentAuthRow({
  pa, accountMap, demandMap, currentUserId, canAuthorise, isRejecting,
  rejectReason, onRejectReasonChange,
  onAuthorise, onAskReject, onConfirmReject, onCancelReject,
}: {
  pa: PaymentAuth
  accountMap: Map<string, string>
  demandMap: Map<string, Demand>
  currentUserId: string | null
  canAuthorise: boolean
  isRejecting: boolean
  rejectReason: string
  onRejectReasonChange: (v: string) => void
  onAuthorise: () => void
  onAskReject: () => void
  onConfirmReject: (reason: string, asRequester: boolean) => void
  onCancelReject: () => void
}) {
  const status = pa.status as PaymentAuthStatus
  const actionType = (pa.action_type as CriticalActionType) ?? 'payment_release'
  const proposed = pa.proposed
  const isClosure       = actionType === 'close_bank_account'
  const isRicsToggle    = actionType === 'toggle_rics_designation'
  const isPayeeSetup    = actionType === 'payment_payee_setup'
  const isPayment       = !isClosure && !isRicsToggle && !isPayeeSetup
  // ProposedPayeeSetup has no bank_account_id (payee setup is contractor-
  // scoped, not bank-account-scoped); read the regular accessor only for
  // the action types that DO carry it.
  const accountId = isPayeeSetup
    ? null
    : (proposed as { bank_account_id?: string } | null)?.bank_account_id ?? null
  const accountName = accountId ? (accountMap.get(accountId) ?? '—') : '—'
  const txnProposed = isPayment ? (proposed as ProposedTransaction | null) : null
  const ricsProposed = isRicsToggle ? (proposed as ProposedRicsDesignationToggle | null) : null
  const payeeProposed = isPayeeSetup ? (proposed as ProposedPayeeSetup | null) : null
  const amount = Number(txnProposed?.amount ?? 0)
  const demand = txnProposed?.demand_id ? demandMap.get(txnProposed.demand_id) : null
  const isRequester = !!currentUserId && pa.requested_by === currentUserId
  const isPending = status === 'pending'
  return (
    <>
      <tr className={cn('border-t hover:bg-muted/30', !isPending && 'opacity-80')}>
        <td className="px-4 py-2">
          <Badge variant={STATUS_BADGE_VARIANT[status] ?? 'secondary'}>
            {slugToTitle(status)}
          </Badge>
        </td>
        <td className="px-4 py-2 text-xs text-muted-foreground">
          {formatDateTime(pa.requested_at)}
        </td>
        <td className="px-4 py-2">{accountName}</td>
        <td className="px-4 py-2">
          {isClosure ? (
            <span className="text-amber-700 font-medium">
              Close: {accountName}
            </span>
          ) : isRicsToggle ? (
            <span className="text-amber-700 font-medium">
              RICS designation: {accountName} → {ricsProposed?.new_value ? 'Designate' : 'Remove'}
            </span>
          ) : isPayeeSetup ? (
            <span className="text-blue-700 font-medium">
              Payee setup: {payeeProposed?.contractor_label ?? '—'}
              {payeeProposed?.is_re_approval ? ' (re-approval)' : ''}
            </span>
          ) : (
            txnProposed?.description ?? '—'
          )}
        </td>
        <td className="px-4 py-2 text-muted-foreground">
          {isPayment ? (txnProposed?.payee_payer ?? '—') : '—'}
        </td>
        <td className="px-4 py-2 text-right font-mono tabular-nums text-destructive">
          {isPayment ? formatPounds(Math.abs(amount)) : '—'}
        </td>
        <td className="px-4 py-2 text-xs text-muted-foreground">
          {isPayment
            ? (demand
              ? `Demand £${Math.abs(Number(demand.amount)).toFixed(2)}`
              : '—')
            : '—'}
        </td>
        <td className="px-4 py-2">
          {isPending && (
            <div className="flex gap-1 justify-end">
              <Button
                variant="ghost" size="sm"
                className="text-green-700 hover:text-green-800"
                onClick={onAuthorise}
                disabled={!canAuthorise || isRequester}
                title={
                  isRequester ? SELF_AUTH_TOOLTIP
                    : !canAuthorise ? ROLE_GATE_TOOLTIP
                    : undefined
                }
                aria-label={`Authorise request ${pa.id}`}
              >
                <CheckCircle2 className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost" size="sm"
                className="text-destructive hover:text-destructive"
                onClick={onAskReject}
                disabled={!canAuthorise && !isRequester}
                title={!canAuthorise && !isRequester ? ROLE_GATE_TOOLTIP : undefined}
                aria-label={isRequester ? `Cancel request ${pa.id}` : `Reject request ${pa.id}`}
              >
                <XCircle className="h-4 w-4" />
              </Button>
            </div>
          )}
          {!isPending && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
              <Clock className="h-3 w-3" />
              {status === 'authorised' ? 'Authorised' : 'Rejected'}
            </span>
          )}
        </td>
      </tr>
      {isRejecting && (
        <tr className="border-t bg-destructive/5">
          <td colSpan={8} className="px-4 py-3">
            <div className="flex items-start gap-3 text-sm flex-wrap">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-[18rem] space-y-2">
                <p>
                  {isRequester
                    ? 'Cancel your own pending request? It will be marked as rejected with reason "Cancelled by requester".'
                    : 'Reject this payment authorisation request? Provide a reason — it will be visible to the requester.'}
                </p>
                {!isRequester && (
                  <Input
                    autoFocus
                    placeholder="Reason for rejection (required)"
                    value={rejectReason}
                    onChange={e => onRejectReasonChange(e.target.value)}
                    aria-label="Rejection reason"
                  />
                )}
              </div>
              <Button
                size="sm" variant="destructive"
                disabled={!isRequester && !rejectReason.trim()}
                onClick={() => onConfirmReject(rejectReason.trim(), isRequester)}
              >
                {isRequester ? 'Confirm cancel' : 'Confirm reject'}
              </Button>
              <Button size="sm" variant="outline" onClick={onCancelReject}>
                Back
              </Button>
            </div>
          </td>
        </tr>
      )}
      {!isPending && (pa.rejection_reason || pa.authorised_at) && (
        <tr className="border-t bg-muted/20">
          <td colSpan={8} className="px-4 py-2 text-xs text-muted-foreground">
            {status === 'authorised' && pa.authorised_at && (
              <>Authorised {formatDateTime(pa.authorised_at)}</>
            )}
            {status === 'rejected' && pa.rejected_at && (
              <>
                Rejected {formatDateTime(pa.rejected_at)}
                {pa.rejection_reason && <> — {pa.rejection_reason}</>}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Mirror of the helper in TransactionsTab — kept inline here to avoid a
 * cross-component import. Forward-only: never reverts a paid demand.
 */
async function applyDemandReceiptStatus(demandId: string): Promise<void> {
  const { data: dem } = await supabase
    .from('demands').select('amount, status').eq('id', demandId).single()
  if (!dem) return
  const { data: receipts } = await supabase
    .from('transactions')
    .select('amount')
    .eq('demand_id', demandId)
    .eq('transaction_type', 'receipt')
  const totalReceiptsP = (receipts ?? []).reduce(
    (sum, r) => sum + poundsToP(Number(r.amount)),
    0,
  )
  const demandP = poundsToP(Number(dem.amount))
  const nextStatus = totalReceiptsP >= demandP ? 'paid' : 'part_paid'
  if (dem.status !== nextStatus && totalReceiptsP > 0) {
    await supabase.from('demands').update({ status: nextStatus }).eq('id', demandId)
  }
}

// Suppress unused-imports warnings for types only referenced by JSDoc above.
export type { ProposedTransaction, Transaction }
