/**
 * @file payeeSetup.ts
 * @description Pure helper for the contractor payee-setup function-split (1i.3).
 *
 * RICS Client money handling (1st ed., Oct 2022 reissue) — segregation of
 * duties between staff who establish payee bank details and staff who
 * authorise money-out payments to that payee. ContractorsPage uses this
 * helper on contractor add and on bank-detail edit to assemble the
 * `payment_payee_setup` payment_authorisations row that an admin then
 * authorises (stamping `contractors.approved_by` + `approved_at`).
 *
 * Pure: no DB / network access. Caller does the INSERT + flag flip.
 */
import type { ProposedPayeeSetup } from '@/types/database'

export interface PayeeSetupBankDetails {
  sort_code?:      string | null
  account_number?: string | null
  account_name?:   string | null
  iban?:           string | null
  bic?:            string | null
}

export interface PayeeSetupContractor {
  id:           string
  firm_id:      string
  company_name: string
}

export interface PayeeSetupPaRow {
  firm_id:      string
  requested_by: string
  status:       'pending'
  action_type:  'payment_payee_setup'
  proposed:     ProposedPayeeSetup
}

/**
 * Build the payment_authorisations row to INSERT for a contractor payee
 * setup. Caller does the INSERT and the contractor.approved=false flag flip
 * (the latter only on bank-detail edit; contractor-add already starts
 * approved=false per the column default).
 *
 * @param contractor          The contractor being approved or re-approved.
 * @param proposedBankDetails The bank details the authoriser will commit
 *                            onto the contractor row on PA authorise.
 * @param requesterId         The accounts/admin staff member raising the PA.
 * @param isReApproval        True iff this is a re-approval triggered by
 *                            editing bank details on an already-approved
 *                            contractor. Drives copy + smoke assertions.
 */
export function buildPayeeSetupPA(
  contractor: PayeeSetupContractor,
  proposedBankDetails: PayeeSetupBankDetails,
  requesterId: string,
  isReApproval = false,
): PayeeSetupPaRow {
  return {
    firm_id:      contractor.firm_id,
    requested_by: requesterId,
    status:       'pending',
    action_type:  'payment_payee_setup',
    proposed: {
      contractor_id:    contractor.id,
      contractor_label: contractor.company_name,
      proposed_bank_details: {
        sort_code:      proposedBankDetails.sort_code      ?? null,
        account_number: proposedBankDetails.account_number ?? null,
        account_name:   proposedBankDetails.account_name   ?? null,
        iban:           proposedBankDetails.iban           ?? null,
        bic:            proposedBankDetails.bic            ?? null,
      },
      is_re_approval:   isReApproval,
    },
  }
}

/**
 * Application-side validation of the ProposedPayeeSetup JSONB shape. The
 * DB CHECK on payment_authorisations.proposed only verifies presence; this
 * function asserts at the field level. Returns null on success or a
 * human-readable reason string on failure (used in both inline UI errors
 * and audit-log notes — statutory-citation-as-test-anchor pattern).
 */
export function validateProposedPayeeSetup(p: unknown): string | null {
  if (!p || typeof p !== 'object') return 'Proposed payee-setup payload missing.'
  const o = p as Record<string, unknown>
  if (typeof o.contractor_id    !== 'string' || !o.contractor_id)    return 'contractor_id is required.'
  if (typeof o.contractor_label !== 'string' || !o.contractor_label) return 'contractor_label is required.'
  if (typeof o.is_re_approval   !== 'boolean')                       return 'is_re_approval flag is required.'
  const bd = o.proposed_bank_details as Record<string, unknown> | undefined
  if (!bd || typeof bd !== 'object') return 'proposed_bank_details object is required.'
  // At least one of {sort_code+account_number} or {iban} must be present —
  // a payee-setup with no bank details serves no purpose.
  const ukOk  = typeof bd.sort_code      === 'string' && typeof bd.account_number === 'string' &&
                bd.sort_code !== '' && bd.account_number !== ''
  const intOk = typeof bd.iban === 'string' && bd.iban !== ''
  if (!ukOk && !intOk) {
    return (
      'At least one of (sort_code + account_number) or iban must be set. ' +
      'RICS Client money handling — segregation of duties presupposes a ' +
      'distinct payee account.'
    )
  }
  return null
}
