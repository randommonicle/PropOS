/**
 * @file statusTransitions.ts
 * @description Invoice state-machine helpers — locks the spec §5.7 / §6.4
 * status flow client-side. The CHECK constraint at 00028 locks the canonical
 * six values; this module locks the legal *edges* between them.
 *
 * Responsible for: edge legality (canTransition), role-tier gating per edge
 *                  (canPMTransition / canAccountsTransition), terminal-lock
 *                  detection, the human-readable rejection message used
 *                  client-side AND in the audit-log.
 * NOT responsible for: server-side enforcement (FORWARD: PROD-GATE — financial-
 *                      rules Edge Function, 00028 manifest item 5); the
 *                      actual mutation (the consuming component runs the
 *                      supabase-js update); audit-log inserts (Phase 5).
 *
 * Role-tier semantics (regulatory anchor: RICS Client money handling 1st ed.,
 * Oct 2022 reissue):
 *   - PM (`property_manager` or `senior_pm`) drives received → approved (and
 *     the disputed/rejected → received re-review path). PM CANNOT drive
 *     approved → queued or queued → paid — those require staff with finance
 *     authority (post-1i.3: admin OR accounts via hasAnyFinanceRole).
 *   - Finance role (`hasAnyFinanceRole`, post-1i.3 admin OR accounts) drives
 *     approved → queued (queue for payment, creates the dual-auth PA row).
 *     The queued → paid edge is driven by the PA authorise flow itself, never
 *     by a direct edit, so it is NOT exposed here as a callable transition.
 *   - Both role-tiers can drive any → disputed and any → rejected (terminal).
 *   - This module consumes the user_roles[] array claim via the typed helpers
 *     in `@/lib/constants` (1i.3 phase 3 — replaces the legacy singular
 *     UserRole signature).
 *
 * State machine reference (DECISIONS 2026-05-10 — Invoices CRUD, §UX rule 4):
 *
 *     received ──confirm──▶ approved ──queue──▶ queued ══PA-auth══▶ paid ✦
 *        ▲                     │                   │
 *        │                     ├──dispute──▶ disputed
 *        │                     └──reject──▶  rejected ✦
 *        │
 *     re-review (disputed/rejected → received, PM only)
 *
 *  ✦ terminal: only `notes` editable. Mirrors demands paid lock (1d) +
 *    reconciliation completed lock (1h.3).
 */
import type { InvoiceStatus, UserRole } from '@/lib/constants'
import { hasAnyFinanceRole, hasPmRole, hasSeniorPmRole } from '@/lib/constants'

/** Statuses that lock all fields except `notes`. Surface as a "Lock" banner
 *  on the drawer; mirrors the demand paid lock. */
export const INVOICE_TERMINAL_STATUSES: readonly InvoiceStatus[] =
  ['paid', 'rejected'] as const

export function isInvoiceTerminal(status: InvoiceStatus): boolean {
  return INVOICE_TERMINAL_STATUSES.includes(status)
}

/** Canonical legal edges. Source of truth for the UI dropdown options + the
 *  guards in canPMTransition / canAccountsTransition. */
const LEGAL_EDGES: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  received:  ['approved', 'disputed', 'rejected'],
  approved:  ['queued',   'disputed', 'rejected'],
  queued:    ['disputed', 'rejected'],            // queued → paid is PA-auth-only
  paid:      [],                                  // terminal
  disputed:  ['received', 'rejected'],            // re-review or escalate
  rejected:  ['received'],                        // re-review only
}

export function legalNextStatuses(from: InvoiceStatus): readonly InvoiceStatus[] {
  return LEGAL_EDGES[from]
}

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return LEGAL_EDGES[from].includes(to)
}

/**
 * PM (`property_manager`) edges. PMs drive:
 *   - received → approved   (Confirm action, after AI extraction or manual entry)
 *   - any      → disputed   (raise a dispute on the invoice)
 *   - any      → rejected   (reject — terminal)
 *   - disputed → received   (re-review path)
 *   - rejected → received   (re-review path)
 *
 * PMs explicitly CANNOT drive approved → queued or anything → paid.
 */
export function canPMTransition(
  from: InvoiceStatus, to: InvoiceStatus,
): boolean {
  if (!canTransition(from, to)) return false
  // PM cannot reach `paid` directly — only via PA authorise.
  if (to === 'paid') return false
  // PM cannot queue for payment.
  if (from === 'approved' && to === 'queued') return false
  return true
}

/**
 * Finance-role edges (today: admin only; 1i.3 expands to accounts + admin).
 * Finance roles drive:
 *   - approved → queued     (Queue for payment — creates dual-auth PA row)
 *   - any      → disputed
 *   - any      → rejected
 *
 * Finance roles do NOT drive received → approved (PM Confirm gate is the
 * regulatory anchor — PM is the property-manager-of-record). Finance roles
 * also do not drive the re-review path; only PMs can re-open a disputed or
 * rejected invoice (preserves the audit trail of the original decision).
 *
 * The queued → paid edge is reached ONLY by the PA authorise flow, never
 * by a direct status edit; it is therefore not callable from this helper.
 */
export function canAccountsTransition(
  from: InvoiceStatus, to: InvoiceStatus,
): boolean {
  if (!canTransition(from, to)) return false
  // Same prohibition as PM on the paid edge — PA authorise only.
  if (to === 'paid') return false
  // Re-review path is PM-only.
  if ((from === 'disputed' || from === 'rejected') && to === 'received') return false
  // Confirm action is PM-only.
  if (from === 'received' && to === 'approved') return false
  return true
}

/**
 * Single entry point used by the InvoicesTab — combines the legality check
 * with the role-gate. Returns null on success or a human-readable rejection
 * message on failure (the same string used in the inline error AND in the
 * audit-log notes — statutory-citation-as-test-anchor pattern from LESSONS
 * Phase 3 session 2). Consumes the user_roles[] array claim via the typed
 * helpers (1i.3).
 */
export function rejectionMessageForTransition(
  roles: readonly UserRole[] | null | undefined,
  from: InvoiceStatus, to: InvoiceStatus,
): string | null {
  if (!canTransition(from, to)) {
    return `Illegal status transition: ${from} → ${to}.`
  }
  if (to === 'paid') {
    return (
      'Invoice cannot be marked paid directly. Payment is released by ' +
      'authorising the dual-auth payment authorisation request. ' +
      'RICS Client money handling — segregation of duties.'
    )
  }
  // PM-tier (property_manager OR senior_pm) — same edge-set today; senior_pm
  // overrides land in a follow-on commit (FORWARD: senior_pm reconciliation
  // re-open UI is the first override surface).
  if (hasPmRole(roles) || hasSeniorPmRole(roles)) {
    if (from === 'approved' && to === 'queued') {
      return (
        'Property Managers cannot queue invoices for payment. Queue-for-payment ' +
        'is restricted to staff with finance authority (admin or accounts). ' +
        'RICS Client money handling — segregation of duties.'
      )
    }
    return null
  }
  if (hasAnyFinanceRole(roles)) {
    if (from === 'received' && to === 'approved') {
      return (
        'Confirming an invoice is the Property Manager\'s action. ' +
        'Finance staff cannot confirm AI-extracted invoices on a PM\'s behalf.'
      )
    }
    if ((from === 'disputed' || from === 'rejected') && to === 'received') {
      return (
        'Re-opening a disputed or rejected invoice is the Property Manager\'s ' +
        'action — preserves the audit trail of the original decision.'
      )
    }
    return null
  }
  return (
    'You do not have permission to drive invoice status transitions. ' +
    'Contact a Property Manager or finance-authorised staff member.'
  )
}

/**
 * Convenience for the UI — returns the subset of `legalNextStatuses(from)`
 * that the given roles can actually drive. Used to populate the status
 * dropdown so a PM never sees a `queued` option, etc. A multi-role user
 * (e.g. admin who also holds accounts) sees the union.
 */
export function statusOptionsForRole(
  roles: readonly UserRole[] | null | undefined,
  from: InvoiceStatus,
): readonly InvoiceStatus[] {
  return legalNextStatuses(from).filter(to => {
    if (hasPmRole(roles) || hasSeniorPmRole(roles)) {
      if (canPMTransition(from, to)) return true
    }
    if (hasAnyFinanceRole(roles)) {
      if (canAccountsTransition(from, to)) return true
    }
    return false
  })
}
