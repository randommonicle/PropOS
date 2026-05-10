/**
 * @file auditLog.ts
 * @description Helper for writing rows to reconciliation_audit_log.
 *
 * Spec §5.3 "Audit Requirements": "every reconciliation action (auto-match,
 * manual match, suspense, reject, completion) writes a row to a
 * reconciliation_audit_log table with: who, when, what action, before-state,
 * after-state. RICS Rule 3.7 evidence trail; 6-year retention minimum."
 *
 * Responsible for: shaping the INSERT payload from action context;
 *                  centralising the action vocabulary so callers can't
 *                  accidentally write a non-CHECK-permitted action.
 * NOT responsible for: enforcing INSERT-only semantics (PROD-GATE — must
 *                      become an Edge Function with append-only RLS), 6-year
 *                      retention archival cron (PROD-GATE), tamper-evidence
 *                      (Phase 5 audit-log work — see Data-integrity /
 *                      auto-protect pass DECISIONS entry).
 *
 * FORWARD: PROD-GATE — actor_id is currently stamped from the client. Server
 * stamping (from auth context) is the production requirement so a leaked
 * publishable key cannot impersonate another user. Anchor: DECISIONS
 * 2026-05-10 — Production-grade gate manifest item 6.
 */
import { supabase } from '@/lib/supabase'
import type { ReconciliationAuditAction } from '@/lib/constants'
import type { Database } from '@/types/database'

type Json = Database['public']['Tables']['reconciliation_audit_log']['Insert']['before_state']

export interface RecordActionParams {
  firmId:                  string
  bankAccountId:           string
  reconciliationPeriodId?: string | null
  bankStatementImportId?:  string | null
  action:                  ReconciliationAuditAction
  actorId:                 string
  beforeState?:            Json
  afterState?:             Json
  notes?:                  string | null
}

export async function recordAction(p: RecordActionParams): Promise<void> {
  const { error } = await supabase.from('reconciliation_audit_log').insert({
    firm_id:                  p.firmId,
    bank_account_id:          p.bankAccountId,
    reconciliation_period_id: p.reconciliationPeriodId ?? null,
    bank_statement_import_id: p.bankStatementImportId ?? null,
    action:                   p.action,
    actor_id:                 p.actorId,
    before_state:             p.beforeState ?? null,
    after_state:              p.afterState ?? null,
    notes:                    p.notes ?? null,
  })
  if (error) {
    // Audit-log write failures are not silently swallowed — they break the
    // reconciliation flow loudly so the PM knows the audit chain isn't intact.
    // Spec §5.3 RICS RULE: "the reconciliation engine ... is the system
    // component that demonstrates compliance, so its audit log is itself a
    // compliance artefact".
    throw new Error(`Failed to write reconciliation audit log: ${error.message}`)
  }
}
