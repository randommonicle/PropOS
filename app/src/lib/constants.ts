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

// User roles — matches the user_roles_role_chk constraint on the user_roles
// junction table (00029). Single-column users.role was dropped in 1i.3.
// Multi-role membership is now first-class: a partner who acts as both admin
// and accounts staff holds two rows in user_roles and the JWT carries both.
export const USER_ROLES = [
  'admin',
  'accounts',          // staff finance — first-leg authorisation tier (1i.3)
  'senior_pm',         // staff PM-tier with override authority (1i.3)
  'property_manager',
  'auditor',           // staff read-only including audit-log tables (1i.3)
  'inspector',         // staff scaffold — Phase 7 inspection app (1i.3)
  'director',
  'leaseholder',
  'contractor',
  'read_only',
] as const
export type UserRole = (typeof USER_ROLES)[number]

/**
 * Typed role-membership helpers — every role gate consumes the user_roles[]
 * array claim emitted by the JWT custom_access_token_hook (00029). The
 * legacy `firmContext.role: UserRole` is still populated for the transition
 * (priority-picked first role) so unswept call-sites keep working; new code
 * should consume `firmContext.roles: UserRole[]` via these helpers.
 *
 * Semantics-preserving in 1i.3 phase 2: each helper gates on the same role
 * its singular predecessor did. Role widening (admin → admin OR accounts on
 * the queue-for-payment gate, etc.) lands in phase 3 with the function-split
 * + tier-asymmetric flip-on.
 */
function has(role: UserRole, roles: readonly UserRole[] | null | undefined): boolean {
  return roles != null && roles.includes(role)
}
function hasAny(needed: readonly UserRole[], roles: readonly UserRole[] | null | undefined): boolean {
  return roles != null && roles.some(r => needed.includes(r))
}

export const hasAdminRole     = (roles: readonly UserRole[] | null | undefined) => has('admin', roles)
export const hasAccountsRole  = (roles: readonly UserRole[] | null | undefined) => has('accounts', roles)
export const hasSeniorPmRole  = (roles: readonly UserRole[] | null | undefined) => has('senior_pm', roles)
export const hasPmRole        = (roles: readonly UserRole[] | null | undefined) => has('property_manager', roles)
export const hasAuditorRole   = (roles: readonly UserRole[] | null | undefined) => has('auditor', roles)
export const hasInspectorRole = (roles: readonly UserRole[] | null | undefined) => has('inspector', roles)
export const hasDirectorRole  = (roles: readonly UserRole[] | null | undefined) => has('director', roles)

/**
 * Any staff PM-tier role (admin OR accounts OR senior_pm OR property_manager).
 * Mirrors the post-1i.3 is_pm_or_admin() SQL helper — used for write paths
 * across financial / properties / leaseholders / works tables in the UI.
 */
export const isStaffPmTier = (roles: readonly UserRole[] | null | undefined) =>
  hasAny(['admin','accounts','senior_pm','property_manager'], roles)

/**
 * Any role authorised on a regulated-finance action (today: admin only —
 * semantics preserved through 1i.3 phase 2). Phase 3 introduces the
 * tier-asymmetric flip-on: queue-for-payment requires accounts OR admin;
 * authorise-payment requires admin (with self-auth guard); payee-setup
 * authoriser ≠ release authoriser. Until phase 3 lands, this remains the
 * admin-only gate from 1i.2.
 *
 * RICS Client money handling (1st ed., Oct 2022 reissue) — both signatories
 * on a managing-agent client-account withdrawal must be staff of the
 * regulated firm. `director` is client-side (RMC directors / freeholder
 * representatives) and explicitly excluded.
 */
export const hasAnyFinanceRole = (roles: readonly UserRole[] | null | undefined) =>
  hasAdminRole(roles)

/**
 * Legacy single-role finance gate. Kept as a thin shim over the new array
 * helper for one transitional commit so unswept call-sites keep working;
 * removed in the cleanup commit alongside the legacy `user_role` JWT claim
 * (FORWARD: PROD-GATE — see 00029 step 4).
 *
 * @deprecated since 1i.3 phase 2 — use `hasAdminRole(firmContext.roles)`.
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
 * Matches the CHECK constraint set by 00029 (renamed `payment` →
 * `payment_release`, added `payment_payee_setup` for the RICS function-split).
 *
 * 'payment_release'          — money-out auth (was `payment` pre-1i.3); uses
 *                              transaction_id + proposed (ProposedTransaction).
 * 'payment_payee_setup'      — 1i.3 flow; establishes / changes a contractor's
 *                              bank details. Authorise stamps contractor
 *                              .approved_by + .approved_at. The same admin
 *                              cannot then authorise a payment_release to
 *                              that contractor (RICS Client money handling —
 *                              segregation of duties; payee-setter ≠
 *                              release-authoriser). UI surface for inserting
 *                              this PA lands in 1i.3 phase 3.
 * 'close_bank_account'       — 1g flow; uses proposed (ProposedClosure); on
 *                              authorise the application updates
 *                              bank_accounts.is_active=false + closed_date.
 * 'toggle_rics_designation'  — 1g.5 flow; uses proposed (ProposedRicsDesignationToggle);
 *                              on authorise the application updates
 *                              bank_accounts.rics_designated. Direction-gated:
 *                              only true→false is gated; false→true is direct.
 */
export const CRITICAL_ACTION_TYPES = [
  'payment_release',
  'payment_payee_setup',
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
