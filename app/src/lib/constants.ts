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

// Invoice extraction confidence threshold below which the AI result is flagged for human review
export const AI_CONFIDENCE_REVIEW_THRESHOLD = 0.75

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
 * Roles authorised to perform bank-account closure and hard-delete (the
 * regulated-finance actions). See DECISIONS 2026-05-09 — bank account closure
 * role gate. Replaced in commit 1f by the full Critical-Action Authorisations
 * dual-auth flow, which will additionally require a second signer.
 */
export const FINANCE_ROLES = ['admin', 'director'] as const satisfies readonly UserRole[]
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
