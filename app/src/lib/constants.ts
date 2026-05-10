/**
 * @file constants.ts
 * @description All magic numbers, magic strings, and statutory values used across PropOS.
 * Responsible for: single source of truth for all constants.
 * NOT responsible for: runtime configuration (use environment variables for that).
 *
 * Every constant that has a statutory or regulatory origin includes a comment citing the source.
 */

// LTA 1985 s.20 — Section 20 consultation threshold per leaseholder
export const SECTION_20_THRESHOLD_GBP = 250

// LTA 1985 s.20B — Maximum age of costs for which a service charge demand can be issued
// without override. 18 months from the date costs were incurred.
export const S20B_MAX_AGE_MONTHS = 18

// Dispatch engine response deadlines (in hours) per priority level
// Source: PropOS Handoff Document v1.1 Section 5.1
export const DISPATCH_DEADLINE_HOURS: Record<string, number> = {
  emergency: 1,
  high: 4,
  normal: 24,
  low: 48,
}

// Dispatch engine cron interval (minutes)
// Source: PropOS Handoff Document v1.1 Section 5.1
export const DISPATCH_TIMEOUT_CHECK_INTERVAL_MINUTES = 15

// Compliance item reminder thresholds (days before expiry)
// Source: PropOS Handoff Document v1.1 Section 4.4 default
export const COMPLIANCE_REMINDER_DAYS_DEFAULT = [90, 30, 14]

// Section 20 observation period (calendar days from notice date)
// Source: LTA 1985 s.20
export const SECTION_20_OBSERVATION_PERIOD_DAYS = 30

// Invoice extraction confidence threshold below which the AI result is flagged
// for human review with an amber banner. INFORMATIONAL ONLY — PM confirmation
// is mandatory regardless of confidence (DECISIONS 2026-05-10 — Invoices CRUD
// with AI extraction). A confidence of 1.00 still requires explicit PM confirm.
export const AI_CONFIDENCE_REVIEW_THRESHOLD = 0.75

// Invoice statuses — matches invoices_status_chk (00028) and 00005:204.
// State machine + role-gating documented in app/src/lib/invoices/statusTransitions.ts.
export const INVOICE_STATUSES = [
  'received',
  'approved',
  'queued',
  'paid',
  'disputed',
  'rejected',
] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

// User roles — matches the role column in the users table
export const USER_ROLES = [
  'admin',
  'property_manager',
  'director',
  'leaseholder',
  'contractor',
  'read_only',
] as const
export type UserRole = (typeof USER_ROLES)[number]

/**
 * Roles authorised to perform regulated-finance actions: bank-account closure
 * authorisation, payment authorisation, invoice queue-for-payment, and the
 * RICS-designation toggle. RICS Client money handling (1st ed., Oct 2022
 * reissue) requires both signatories on a managing-agent client-account
 * withdrawal to be staff of the regulated firm. The `director` role represents
 * RMC directors / freeholder representatives — a CLIENT-side role with portal
 * access, not staff — and is therefore explicitly excluded.
 *
 * Regulatory anchor: RICS Client money handling §X.X (verify exact section
 * when wired into smoke audit-trail strings) + RICS Service Charge Residential
 * Management Code, 4th edition (effective 7 April 2026) + TPI Consumer Charter
 * & Standards Edition 3 (effective 1 January 2025).
 *
 * Role-tier asymmetry (e.g. accounts-initiates / partner-releases) is good
 * practice, not a regulatory mandate. The binding rule is "two distinct
 * people; segregation of payee-setup vs payment-release functions". Tier
 * asymmetry + a dedicated `accounts` role land in 1i.3 alongside multi-role
 * membership.
 *
 * FORWARD: PROD-GATE — when 1i.3 lands, FINANCE_ROLES expands to a function
 * (or splits into hasAccountsRole / hasAdminRole helpers consuming the
 * user_roles[] JWT claim) and the role-tier-asymmetric dual-auth gate
 * activates in PaymentAuthorisationsTab + InvoicesTab queue handler.
 */
export const FINANCE_ROLES = ['admin'] as const satisfies readonly UserRole[]
export function isFinanceRole(role: UserRole | null | undefined): boolean {
  return role != null && (FINANCE_ROLES as readonly UserRole[]).includes(role)
}

// Demand types — matches demand_type column in the demands table
export const DEMAND_TYPES = [
  'service_charge',
  'ground_rent',
  'reserve_fund',
  'admin_charge',
  'ad_hoc',
] as const
export type DemandType = (typeof DEMAND_TYPES)[number]

// Works order statuses
export const WORKS_ORDER_STATUSES = [
  'draft',
  'dispatching',
  'accepted',
  'in_progress',
  'complete',
  'cancelled',
  'disputed',
  'dispatch_failed',
] as const
export type WorksOrderStatus = (typeof WORKS_ORDER_STATUSES)[number]

// Service charge account statuses
export const SERVICE_CHARGE_ACCOUNT_STATUSES = [
  'draft',
  'active',
  'reconciling',
  'finalised',
] as const
export type ServiceChargeAccountStatus = (typeof SERVICE_CHARGE_ACCOUNT_STATUSES)[number]

// Demand statuses — matches status column in the demands table
export const DEMAND_STATUSES = [
  'draft',
  'issued',
  'part_paid',
  'paid',
  'overdue',
  'disputed',
  'withdrawn',
] as const
export type DemandStatus = (typeof DEMAND_STATUSES)[number]

/**
 * Transaction types — matches transaction_type column in the transactions table.
 * `inter_account_transfer` is in the schema enum but NOT surfaced by the 1e UI;
 * paired-row creation (one debit + one credit on different accounts, atomically
 * linked) requires its own commit.
 */
export const TRANSACTION_TYPES = [
  'receipt',
  'payment',
  'journal',
  'inter_account_transfer',
] as const
export type TransactionType = (typeof TRANSACTION_TYPES)[number]

/** Statuses for which a demand may still receive a receipt allocation. */
export const DEMAND_OPEN_STATUSES: readonly DemandStatus[] =
  ['issued', 'part_paid', 'overdue'] as const

// Payment authorisation statuses — matches status column on payment_authorisations.
export const PAYMENT_AUTH_STATUSES = [
  'pending',
  'authorised',
  'rejected',
] as const
export type PaymentAuthStatus = (typeof PAYMENT_AUTH_STATUSES)[number]

/**
 * Critical action types — discriminator on payment_authorisations.action_type.
 * 'payment'                  — original 1f flow; uses transaction_id + proposed (ProposedTransaction).
 * 'close_bank_account'       — 1g flow; uses proposed (ProposedClosure); on authorise the
 *                              application updates bank_accounts.is_active=false + closed_date.
 * 'toggle_rics_designation'  — 1g.5 flow; uses proposed (ProposedRicsDesignationToggle); on
 *                              authorise the application updates bank_accounts.rics_designated.
 *                              Direction-gated: only true→false is gated; false→true is direct.
 */
export const CRITICAL_ACTION_TYPES = [
  'payment',
  'close_bank_account',
  'toggle_rics_designation',
] as const
export type CriticalActionType = (typeof CRITICAL_ACTION_TYPES)[number]

/**
 * Reconciliation matching pass labels — spec §5.3 Matching Algorithm.
 * Confidence values are spec-mandated. Labels are user-facing.
 */
export const RECONCILIATION_PASS_LABELS = {
  1: { label: 'Auto-matched',       confidence: 1.00 },
  2: { label: 'Suggested match',    confidence: 0.80 },
  3: { label: 'Review carefully',   confidence: 0.50 },
} as const
export type ReconciliationPass = keyof typeof RECONCILIATION_PASS_LABELS

/**
 * Reconciliation audit-log action vocabulary — must match the CHECK
 * constraint on reconciliation_audit_log.action (00025).
 * RICS Rule 3.7 evidence trail; every PM action on the review screen
 * writes one of these.
 */
export const RECONCILIATION_AUDIT_ACTIONS = [
  'auto_match',
  'manual_match',
  'suspense',
  'reject',
  'completion',
  'suspense_resolve',
] as const
export type ReconciliationAuditAction = (typeof RECONCILIATION_AUDIT_ACTIONS)[number]

// Section 20 consultation statuses (state machine)
export const SECTION_20_STATUSES = [
  'stage1_pending',
  'stage1_issued',
  'stage1_observation_period',
  'stage1_closed',
  'stage2_pending',
  'stage2_issued',
  'stage2_observation_period',
  'stage2_closed',
  'awarded',
  'dispensation_applied',
  'dispensation_granted',
  'complete',
  'withdrawn',
] as const
export type Section20Status = (typeof SECTION_20_STATUSES)[number]

// Compliance item types
export const COMPLIANCE_ITEM_TYPES = [
  'eicr',
  'fra',
  'gas_safety',
  'asbestos_management',
  'asbestos_refurb',
  'lift_thorough',
  'lift_service',
  'insurance',
  'health_safety',
  'water_hygiene',
  'legionella',
  'pat_testing',
  'fire_suppression',
  'emergency_lighting',
  'planning',
  'building_regs',
  'other',
] as const

// RAG status thresholds for compliance items (days until expiry)
export const COMPLIANCE_RAG = {
  RED_THRESHOLD_DAYS: 14,   // expired or expiring within 14 days
  AMBER_THRESHOLD_DAYS: 90, // expiring within 90 days
} as const

// Supabase storage bucket names
export const STORAGE_BUCKETS = {
  DOCUMENTS: 'documents',
  LOGOS: 'logos',
  INSPECTION_REPORTS: 'inspection-reports',
} as const

// Claude model to use for AI features
export const CLAUDE_MODEL = 'claude-sonnet-4-6'
