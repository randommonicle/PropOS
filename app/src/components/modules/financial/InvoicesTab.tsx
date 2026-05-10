/**
 * @file InvoicesTab.tsx
 * @description Per-property invoices list + create/edit/delete + AI extraction
 * + queue-for-payment dual-auth bridge. Tenth tab on PropertyDetailPage. Closes
 * the Phase 3 spec §7 deliverable "invoice management with AI extraction".
 *
 * Responsible for: full CRUD on `invoices` rows scoped to a single property;
 *                  PDF / PNG / JPG upload to Storage; client invocation of
 *                  the `document_processing` Edge Function (spec §5.7); the
 *                  PM-confirmation gate (mandatory regardless of AI
 *                  confidence); the role-tier-asymmetric status state machine
 *                  (PM Confirm, finance Queue-for-payment) per RICS Client
 *                  money handling; FK-safe delete with friendly error
 *                  surfacing.
 * NOT responsible for: PDF preview rendering inside the drawer (Phase 6
 *                      reporting); per-property invoice spend cap
 *                      (FORWARD: PROD-GATE — DECISIONS 2026-05-10);
 *                      director-approval queue for over-cap invoices
 *                      (FORWARD: PROD-GATE — extends payment_authorisations
 *                      .action_type); INSERT trigger on documents row firing
 *                      the Edge Function automatically (FORWARD: PROD-GATE);
 *                      DAILY_AI_COST_CAP_GBP enforcement (FORWARD: PROD-GATE);
 *                      INSERT-only invoices_audit_log (FORWARD: PROD-GATE);
 *                      contractor_id FK constraint (FORWARD: Phase 5
 *                      contractor onboarding revisit).
 *
 * Regulatory rules baked in (DECISIONS 2026-05-10 — Invoices CRUD with AI
 * extraction; RICS Client money handling 1st ed., Oct 2022 reissue + RICS
 * Service Charge Residential Management Code 4th ed., effective 7 April 2026):
 *   1. PM-confirmation gate is MANDATORY. Invoices arrive at status
 *      'received' (post-AI-extraction or post-manual-create). The PM clicks
 *      "Confirm invoice" to move to 'approved' — confidence < 1.00 OR =
 *      1.00 makes no difference; the click is the gate. Without confirmation
 *      no further state edges (queue / pay) are reachable.
 *   2. Role-tier asymmetry. PM drives received → approved (and the re-
 *      review path). Finance staff (admin only — RMC directors are CLIENT-
 *      side and excluded per RICS Client money handling: both signatories
 *      must be staff of the regulated firm) drive approved → queued. The
 *      queued → paid edge is reached ONLY by the dual-auth PA authorise
 *      flow in PaymentAuthorisationsTab — never via direct status edit.
 *   3. AI confidence is informational ONLY. The amber banner under
 *      AI_CONFIDENCE_REVIEW_THRESHOLD (0.75) is a nudge to the PM, not a
 *      gate. PM Confirm is the only gate.
 *   4. Status terminal locks (paid, rejected) restrict editing to `notes`.
 *      Mirrors the demand paid lock (1d) + reconciliation completed lock
 *      (1h.3) + SCA finalised lock (1c).
 *   5. Delete policy: hard-delete is permitted ONLY when no transactions
 *      row references the invoice (FK 23503 surfaces the friendly error
 *      naming the audit-trail rationale).
 *   6. Manual edit after AI extraction APPENDS a "PM-overrode <field>
 *      <ISO-date>" line to extraction_notes — preserves the AI's original
 *      claim alongside the PM's correction (audit trail).
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import {
  Card, CardContent, Button, Badge, Input,
} from '@/components/ui'
import { MoneyInput } from '@/components/shared/MoneyInput'
import {
  Plus, Pencil, Trash2, X, AlertTriangle, Lock, Upload, FileText,
  CheckCircle2, Send, Sparkles,
} from 'lucide-react'
import { formatDate, slugToTitle, todayISODate } from '@/lib/utils'
import { poundsToP, pToPounds, formatPounds } from '@/lib/money'
import {
  AI_CONFIDENCE_REVIEW_THRESHOLD, INVOICE_STATUSES,
  STORAGE_BUCKETS, hasAnyFinanceRole, hasPmRole, hasSeniorPmRole,
  type InvoiceStatus, type UserRole,
} from '@/lib/constants'
import {
  isInvoiceTerminal, statusOptionsForRole,
  rejectionMessageForTransition,
} from '@/lib/invoices/statusTransitions'
import { runAiExtraction } from '@/lib/invoices/aiExtraction'
import type { Database, ProposedTransaction } from '@/types/database'

type Invoice     = Database['public']['Tables']['invoices']['Row']
type BankAccount = Database['public']['Tables']['bank_accounts']['Row']

const SELECT_CLASS = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60'

const ACCEPT_MIMES = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg'
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB; UX rule 1

const STATUS_BADGE_VARIANT: Record<InvoiceStatus, 'secondary' | 'amber' | 'green' | 'destructive'> = {
  received:  'secondary',
  approved:  'amber',
  queued:    'amber',
  paid:      'green',
  disputed:  'destructive',
  rejected:  'destructive',
}

// ════════════════════════════════════════════════════════════════════════════
// Tab root
// ════════════════════════════════════════════════════════════════════════════
export function InvoicesTab({
  firmId,
  propertyId,
}: {
  firmId: string
  propertyId: string
}) {
  const userId = useAuthStore(s => s.user?.id ?? null)
  const roles = useAuthStore(s => s.firmContext?.roles ?? null)
  const canFinance = hasAnyFinanceRole(roles)

  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [loading,  setLoading]  = useState(true)

  const [showForm,   setShowForm]   = useState(false)
  const [editing,    setEditing]    = useState<Invoice | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteErr,  setDeleteErr]  = useState<string | null>(null)

  // Upload state
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploadStage, setUploadStage] =
    useState<'idle' | 'uploading' | 'processing'>('idle')
  const [uploadErr, setUploadErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [invRes, accRes] = await Promise.all([
      supabase.from('invoices').select('*')
        .eq('property_id', propertyId)
        .order('created_at', { ascending: false }),
      supabase.from('bank_accounts').select('*')
        .eq('property_id', propertyId).eq('is_active', true)
        .order('account_name'),
    ])
    setInvoices(invRes.data ?? [])
    setAccounts(accRes.data ?? [])
    setLoading(false)
  }, [propertyId])

  useEffect(() => { load() }, [load])

  // ── File upload + AI extraction flow ───────────────────────────────────────
  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (fileRef.current) fileRef.current.value = ''

    setUploadErr(null)
    if (file.size > MAX_FILE_BYTES) {
      setUploadErr(`File exceeds the ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB limit.`)
      return
    }

    setUploadStage('uploading')

    // (a) Upload bytes to Storage at firm-scoped path.
    const path = `${firmId}/invoices/${Date.now()}_${file.name}`
    const { error: storageErr } = await supabase.storage
      .from(STORAGE_BUCKETS.DOCUMENTS).upload(path, file)
    if (storageErr) {
      setUploadStage('idle')
      setUploadErr(`Storage upload failed: ${storageErr.message}`)
      return
    }

    // (b) Insert documents row scoped to this property + as document_type='invoice'.
    const { data: doc, error: docErr } = await supabase
      .from('documents').insert({
        firm_id:         firmId,
        property_id:     propertyId,
        document_type:   'invoice',
        filename:        file.name,
        storage_path:    path,
        mime_type:       file.type || 'application/pdf',
        file_size_bytes: file.size,
        uploaded_by:     userId,
      }).select('id').single()
    if (docErr || !doc) {
      setUploadStage('idle')
      setUploadErr(`Document record failed: ${docErr?.message ?? 'no row returned'}`)
      return
    }

    // (c) Invoke AI extraction Edge Function.
    setUploadStage('processing')
    const result = await runAiExtraction(doc.id)
    setUploadStage('idle')

    if (!result.ok) {
      setUploadErr(
        `AI extraction failed at stage: ${result.stage}. ${result.message}`,
      )
      // Re-load so the documents row is at least visible on next refresh of
      // the docs vault; the invoices row was not created so the failure is
      // recoverable by re-uploading or by manual create.
      await load()
      return
    }

    // (d) Re-load and open the drawer for PM review of the extracted invoice.
    await load()
    const { data: createdInvoice } = await supabase
      .from('invoices').select('*').eq('id', result.invoice_id).single()
    if (createdInvoice) {
      setEditing(createdInvoice)
      setShowForm(true)
    }
  }

  // ── Delete (hard-delete; FK-guarded) ───────────────────────────────────────
  async function handleDelete(id: string) {
    setDeleteErr(null)
    const { error } = await supabase.from('invoices').delete().eq('id', id)
    if (error) {
      setDeleteErr(
        error.code === '23503'
          ? 'Cannot delete — a transaction references this invoice. The audit trail must be preserved (RICS Client money handling).'
          : error.message,
      )
      return
    }
    setDeletingId(null)
    await load()
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading invoices…</div>
  }

  const showRoleHint = !canFinance && (hasPmRole(roles) || hasSeniorPmRole(roles))

  return (
    <section aria-label="Invoices">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h2 className="font-semibold">Invoices ({invoices.length})</h2>
        <div className="flex items-center gap-2 flex-wrap">
          {showRoleHint && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Lock className="h-3 w-3" />
              Queue-for-payment is restricted to admin staff.
            </span>
          )}
          <Button
            size="sm" variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={uploadStage !== 'idle'}
          >
            <Upload className="h-4 w-4 mr-1" />
            {uploadStage === 'uploading' ? 'Uploading…'
              : uploadStage === 'processing' ? 'Processing AI…'
              : 'Upload invoice'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT_MIMES}
            onChange={handleFileSelected}
            className="hidden"
            data-testid="invoice-file-input"
          />
          <Button
            size="sm"
            onClick={() => { setEditing(null); setShowForm(true); setUploadErr(null) }}
          >
            <Plus className="h-4 w-4 mr-1" /> Create blank invoice
          </Button>
        </div>
      </div>

      {uploadErr && (
        <InlineError message={uploadErr} onDismiss={() => setUploadErr(null)} />
      )}
      {deleteErr && (
        <InlineError message={deleteErr} onDismiss={() => setDeleteErr(null)} />
      )}

      {showForm && (
        <InvoiceForm
          firmId={firmId}
          propertyId={propertyId}
          accounts={accounts}
          initial={editing}
          roles={roles}
          userId={userId}
          onSaved={async () => { setShowForm(false); setEditing(null); await load() }}
          onCancel={() => { setShowForm(false); setEditing(null) }}
        />
      )}

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Invoice #</th>
              <th className="text-left px-4 py-2 font-medium">Description</th>
              <th className="text-right px-4 py-2 font-medium">Gross</th>
              <th className="text-left px-4 py-2 font-medium">Date</th>
              <th className="text-left px-4 py-2 font-medium">AI</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {invoices.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  No invoices for this property yet. Upload a scan/PDF or create blank.
                </td>
              </tr>
            ) : (
              invoices.map(inv => (
                <InvoiceRow
                  key={inv.id}
                  inv={inv}
                  onEdit={() => { setEditing(inv); setShowForm(true); setUploadErr(null) }}
                  onDelete={() => { setDeletingId(inv.id); setDeleteErr(null) }}
                  isDeleting={deletingId === inv.id}
                  onConfirmDelete={() => handleDelete(inv.id)}
                  onCancelDelete={() => setDeletingId(null)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Invoice row
// ════════════════════════════════════════════════════════════════════════════
function InvoiceRow({
  inv, onEdit, onDelete, isDeleting, onConfirmDelete, onCancelDelete,
}: {
  inv: Invoice
  onEdit: () => void
  onDelete: () => void
  isDeleting: boolean
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  const status = inv.status as InvoiceStatus
  const terminal = isInvoiceTerminal(status)
  return (
    <>
      <tr className="border-t hover:bg-muted/30" data-testid={`invoice-row-${inv.id}`}>
        <td className="px-4 py-2 font-medium">{inv.invoice_number ?? '—'}</td>
        <td className="px-4 py-2">{inv.description ?? '—'}</td>
        <td className="px-4 py-2 text-right">
          {inv.amount_gross != null ? formatPounds(inv.amount_gross) : '—'}
        </td>
        <td className="px-4 py-2">{formatDate(inv.invoice_date)}</td>
        <td className="px-4 py-2">
          <ConfidencePill
            extracted={inv.extracted_by_ai}
            confidence={inv.extraction_confidence}
          />
        </td>
        <td className="px-4 py-2">
          <Badge variant={STATUS_BADGE_VARIANT[status]} data-testid={`invoice-status-${inv.id}`}>
            {slugToTitle(status)}
          </Badge>
        </td>
        <td className="px-4 py-2">
          <div className="flex gap-1 justify-end">
            <Button variant="ghost" size="sm" onClick={onEdit} aria-label="Edit invoice">
              {terminal ? <Lock className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost" size="sm"
              className="text-destructive hover:text-destructive"
              onClick={onDelete}
              aria-label="Delete invoice"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </td>
      </tr>

      {isDeleting && (
        <tr className="border-t bg-destructive/5">
          <td colSpan={7} className="px-4 py-3">
            <div className="flex items-center gap-3 text-sm flex-wrap">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
              <span>Delete this invoice? This cannot be undone.</span>
              <Button size="sm" variant="destructive" onClick={onConfirmDelete}>Confirm delete</Button>
              <Button size="sm" variant="outline" onClick={onCancelDelete}>Cancel</Button>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Confidence pill (UX rule 2 — informational only)
// ════════════════════════════════════════════════════════════════════════════
function ConfidencePill({
  extracted, confidence,
}: {
  extracted: boolean | null
  confidence: number | null
}) {
  if (!extracted) return <span className="text-xs text-muted-foreground">Manual</span>
  if (confidence == null) return <span className="text-xs text-muted-foreground">AI</span>
  const pct = Math.round(confidence * 100)
  if (confidence >= 0.9) {
    return <Badge variant="green" data-testid="ai-confidence-pill"><Sparkles className="h-3 w-3 mr-1" />{pct}%</Badge>
  }
  if (confidence >= AI_CONFIDENCE_REVIEW_THRESHOLD) {
    return <Badge variant="amber" data-testid="ai-confidence-pill"><Sparkles className="h-3 w-3 mr-1" />{pct}%</Badge>
  }
  return <Badge variant="destructive" data-testid="ai-confidence-pill"><Sparkles className="h-3 w-3 mr-1" />{pct}%</Badge>
}

// ════════════════════════════════════════════════════════════════════════════
// Invoice form (create + edit drawer)
// ════════════════════════════════════════════════════════════════════════════
function InvoiceForm({
  firmId, propertyId, accounts, initial, roles, userId, onSaved, onCancel,
}: {
  firmId: string
  propertyId: string
  accounts: BankAccount[]
  initial: Invoice | null
  roles: UserRole[] | null
  userId: string | null
  onSaved: () => void | Promise<void>
  onCancel: () => void
}) {
  const isEdit = !!initial
  const status = (initial?.status ?? 'received') as InvoiceStatus
  const terminal = isInvoiceTerminal(status)

  const [values, setValues] = useState({
    invoice_number: initial?.invoice_number ?? '',
    invoice_date:   initial?.invoice_date ?? '',
    due_date:       initial?.due_date ?? '',
    amount_net:     initial?.amount_net != null ? poundsToP(initial.amount_net) : null as number | null,
    vat_amount:     initial?.vat_amount != null ? poundsToP(initial.vat_amount) : null as number | null,
    amount_gross:   initial?.amount_gross != null ? poundsToP(initial.amount_gross) : null as number | null,
    description:    initial?.description ?? '',
  })
  // Snapshot of original values used to detect PM-overrides for AI-extracted
  // rows. Frozen at form open; not updated during the edit session.
  const aiOriginal = useMemo(() => ({
    invoice_number: initial?.invoice_number ?? null,
    invoice_date:   initial?.invoice_date ?? null,
    due_date:       initial?.due_date ?? null,
    amount_net:     initial?.amount_net ?? null,
    vat_amount:     initial?.vat_amount ?? null,
    amount_gross:   initial?.amount_gross ?? null,
    description:    initial?.description ?? null,
  }), [initial?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  const [saving, setSaving] = useState(false)
  const [actionErr, setActionErr] = useState<string | null>(null)

  // Queue-for-payment side-state (finance only, for approved invoices)
  const [queueAccountId, setQueueAccountId] = useState<string>(accounts[0]?.id ?? '')

  function set<K extends keyof typeof values>(k: K, v: (typeof values)[K]) {
    setValues(prev => ({ ...prev, [k]: v }))
  }

  // Determine if PM has overridden any AI-extracted field — append-to-notes pattern.
  function buildOverrideAppend(): string | null {
    if (!initial?.extracted_by_ai) return null
    const today = todayISODate()
    const overrides: string[] = []
    const checks: Array<[string, unknown, unknown]> = [
      ['invoice_number', aiOriginal.invoice_number, values.invoice_number || null],
      ['invoice_date',   aiOriginal.invoice_date,   values.invoice_date   || null],
      ['due_date',       aiOriginal.due_date,       values.due_date       || null],
      ['amount_net',     aiOriginal.amount_net,     values.amount_net != null ? pToPounds(values.amount_net) : null],
      ['vat_amount',     aiOriginal.vat_amount,     values.vat_amount != null ? pToPounds(values.vat_amount) : null],
      ['amount_gross',   aiOriginal.amount_gross,   values.amount_gross != null ? pToPounds(values.amount_gross) : null],
      ['description',    aiOriginal.description,    values.description    || null],
    ]
    for (const [field, before, after] of checks) {
      if (before !== after && !(before == null && after == null)) {
        overrides.push(`PM-overrode ${field} ${today}`)
      }
    }
    return overrides.length ? overrides.join('; ') : null
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setActionErr(null)

    const overrideNote = buildOverrideAppend()
    const newNotes = overrideNote
      ? (initial?.extraction_notes ? `${initial.extraction_notes} | ${overrideNote}` : overrideNote)
      : initial?.extraction_notes ?? null

    const payload: Database['public']['Tables']['invoices']['Update'] = {
      invoice_number:   values.invoice_number || null,
      invoice_date:     values.invoice_date   || null,
      due_date:         values.due_date       || null,
      amount_net:       values.amount_net   != null ? pToPounds(values.amount_net)   : null,
      vat_amount:       values.vat_amount   != null ? pToPounds(values.vat_amount)   : null,
      amount_gross:     values.amount_gross != null ? pToPounds(values.amount_gross) : null,
      description:      values.description || null,
      extraction_notes: newNotes,
    }

    if (isEdit) {
      const { error } = await supabase.from('invoices').update(payload).eq('id', initial!.id)
      if (error) { setActionErr(error.message); setSaving(false); return }
    } else {
      const { error } = await supabase.from('invoices').insert({
        firm_id:               firmId,
        property_id:           propertyId,
        invoice_number:        payload.invoice_number,
        invoice_date:          payload.invoice_date,
        due_date:              payload.due_date,
        amount_net:            payload.amount_net,
        vat_amount:            payload.vat_amount,
        amount_gross:          payload.amount_gross,
        description:           payload.description,
        extracted_by_ai:       false,  // manual create
        extraction_confidence: null,   // null mandated by invoices_extraction_pair_chk
        status:                'received',
      })
      if (error) { setActionErr(error.message); setSaving(false); return }
    }
    setSaving(false)
    await onSaved()
  }

  // PM Confirm action (received → approved). Mandatory regardless of confidence.
  async function handleConfirm() {
    if (!initial) return
    setActionErr(null)
    const reject = rejectionMessageForTransition(roles, status, 'approved')
    if (reject) { setActionErr(reject); return }
    const { error } = await supabase.from('invoices').update({
      status: 'approved',
      approved_by: userId,
      approved_at: new Date().toISOString(),
    }).eq('id', initial.id)
    if (error) { setActionErr(error.message); return }
    await onSaved()
  }

  // Status transition (other than the PM Confirm path — disputed, rejected,
  // re-review). Drawer dropdown reflects role-filtered legal next statuses.
  async function handleStatusChange(next: InvoiceStatus) {
    if (!initial) return
    setActionErr(null)
    const reject = rejectionMessageForTransition(roles, status, next)
    if (reject) { setActionErr(reject); return }
    const { error } = await supabase.from('invoices').update({ status: next }).eq('id', initial.id)
    if (error) { setActionErr(error.message); return }
    await onSaved()
  }

  // Finance action: queue an approved invoice for payment. Inserts a payment_
  // authorisations row with action_type='payment_release' + proposed.invoice_id;
  // the invoice flips to 'queued' atomically (two writes, recoverable).
  async function handleQueueForPayment() {
    if (!initial || !userId) return
    setActionErr(null)
    if (!hasAnyFinanceRole(roles)) {
      setActionErr(
        'Queue-for-payment is restricted to staff with finance authority ' +
        '(admin or accounts). RICS Client money handling — segregation of duties.',
      )
      return
    }
    if (status !== 'approved') {
      setActionErr('Only approved invoices can be queued for payment.')
      return
    }
    if (!queueAccountId) {
      setActionErr('Select a bank account to pay from.')
      return
    }
    if (initial.amount_gross == null) {
      setActionErr('Invoice amount is missing. Edit the invoice and set the gross amount before queueing.')
      return
    }

    // Build the proposed snapshot. Sign convention: a payment is negative
    // (1e — TRANSACTION_TYPES). The `amount` field on the proposed JSONB
    // matches transactions.amount column shape: NUMERIC(14,2) in pounds
    // (DECISIONS 2026-05-07 — DB stores pounds, frontend computes in pence).
    // transaction_date defaults to today; the authorising admin can revise
    // via TransactionsTab if the invoice is paid on a different date.
    const proposed: ProposedTransaction = {
      bank_account_id:  queueAccountId,
      amount:           -Math.abs(initial.amount_gross),  // pounds, negative
      transaction_date: todayISODate(),
      description:      initial.description ?? `Invoice ${initial.invoice_number ?? initial.id.slice(0, 8)}`,
      payee_payer:      null,  // contractor payee FK not yet wired (FORWARD: Phase 5)
      reference:        initial.invoice_number,
      demand_id:        null,
      invoice_id:       initial.id,
      // Populate the contractor link when the invoice has one — drives the
      // payee-setter ≠ release-authoriser segregation gate on PA authorise.
      // RICS Client money handling — segregation of duties.
      contractor_id:    initial.contractor_id ?? null,
    }

    const { error: paErr } = await supabase.from('payment_authorisations').insert({
      firm_id:      firmId,
      requested_by: userId,
      status:       'pending',
      action_type:  'payment_release',
      proposed:     proposed as unknown as Database['public']['Tables']['payment_authorisations']['Insert']['proposed'],
    })
    if (paErr) { setActionErr(paErr.message); return }

    const { error: invErr } = await supabase.from('invoices')
      .update({ status: 'queued' }).eq('id', initial.id)
    if (invErr) {
      setActionErr(
        `Authorisation request created but invoice status not updated: ${invErr.message}. ` +
        'Refresh; an admin can complete by re-opening this invoice.',
      )
      return
    }
    await onSaved()
  }

  const statusOptions = useMemo(
    () => statusOptionsForRole(roles, status).filter(s => s !== 'queued'),  // queue is its own button
    [roles, status],
  )

  return (
    <Card className="mb-4 max-w-3xl">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-4 gap-2">
          <div>
            <h3 className="font-semibold">{isEdit ? 'Invoice details' : 'New invoice'}</h3>
            {isEdit && initial?.extracted_by_ai && (
              <p className="text-xs text-muted-foreground mt-0.5">
                AI-extracted on {formatDate(initial.created_at?.slice(0, 10))} ·
                confidence {Math.round((initial.extraction_confidence ?? 0) * 100)}%
              </p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-4 w-4" /></Button>
        </div>

        {/* AI confidence banner — informational ONLY (UX rule 2 / regulatory rule 3) */}
        {isEdit && initial?.extracted_by_ai
            && initial.extraction_confidence != null
            && initial.extraction_confidence < AI_CONFIDENCE_REVIEW_THRESHOLD && (
          <div
            data-testid="ai-low-confidence-banner"
            className="mb-4 flex items-start gap-2 text-sm border border-amber-300 bg-amber-50 text-amber-900 rounded-md px-3 py-2"
          >
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>
              <strong>Low confidence — verify all fields.</strong> AI extraction
              returned {Math.round((initial.extraction_confidence ?? 0) * 100)}%
              confidence. Review every field before confirming.
            </span>
          </div>
        )}

        {/* Terminal lock banner */}
        {terminal && (
          <div className="mb-4 flex items-start gap-2 text-sm border border-muted-foreground/30 bg-muted/40 rounded-md px-3 py-2">
            <Lock className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>
              This invoice is <strong>{slugToTitle(status)}</strong>. Fields are
              locked; only notes can be amended.
            </span>
          </div>
        )}

        <form onSubmit={handleSave} className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label htmlFor="inv-number" className="text-sm font-medium">Invoice number</label>
            <Input
              id="inv-number"
              value={values.invoice_number}
              onChange={e => set('invoice_number', e.target.value)}
              disabled={terminal}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="inv-date" className="text-sm font-medium">Invoice date</label>
            <Input
              id="inv-date"
              type="date"
              value={values.invoice_date}
              onChange={e => set('invoice_date', e.target.value)}
              disabled={terminal}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="inv-due" className="text-sm font-medium">Due date</label>
            <Input
              id="inv-due"
              type="date"
              value={values.due_date}
              onChange={e => set('due_date', e.target.value)}
              disabled={terminal}
            />
          </div>
          <div /> {/* spacer */}

          <div className="space-y-1">
            <label className="text-sm font-medium">Net £</label>
            <MoneyInput
              value={values.amount_net}
              onChange={v => set('amount_net', v)}
              disabled={terminal}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">VAT £</label>
            <MoneyInput
              value={values.vat_amount}
              onChange={v => set('vat_amount', v)}
              disabled={terminal}
            />
          </div>
          <div className="space-y-1 col-span-2">
            <label className="text-sm font-medium">Gross £ (= net + VAT)</label>
            <MoneyInput
              value={values.amount_gross}
              onChange={v => set('amount_gross', v)}
              disabled={terminal}
            />
          </div>

          <div className="col-span-2 space-y-1">
            <label htmlFor="inv-desc" className="text-sm font-medium">Description</label>
            <Input
              id="inv-desc"
              value={values.description}
              onChange={e => set('description', e.target.value)}
              disabled={terminal}
            />
          </div>

          {actionErr && (
            <p className="col-span-2 text-sm text-destructive" data-testid="invoice-action-err">{actionErr}</p>
          )}

          <div className="col-span-2 flex flex-wrap gap-2 justify-end pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            {!terminal && (
              <Button type="submit" disabled={saving} data-testid="invoice-save">
                {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save invoice'}
              </Button>
            )}
          </div>
        </form>

        {/* ── Action lane (only on edit; shows current-status-appropriate actions) ── */}
        {isEdit && !terminal && (
          <div className="mt-5 border-t pt-4 flex flex-wrap items-end gap-3">
            {/* PM Confirm (received → approved). Mandatory gate per regulatory rule 1. */}
            {status === 'received' && (
              <Button
                onClick={handleConfirm}
                data-testid="invoice-confirm"
              >
                <CheckCircle2 className="h-4 w-4 mr-1" /> Confirm invoice
              </Button>
            )}

            {/* Finance Queue-for-payment (approved → queued). */}
            {status === 'approved' && hasAnyFinanceRole(roles) && (
              <>
                <div className="space-y-1">
                  <label htmlFor="queue-account" className="text-sm font-medium">
                    Pay from account
                  </label>
                  <select
                    id="queue-account"
                    className={SELECT_CLASS}
                    value={queueAccountId}
                    onChange={e => setQueueAccountId(e.target.value)}
                  >
                    <option value="">Select account…</option>
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>{a.account_name}</option>
                    ))}
                  </select>
                </div>
                <Button
                  onClick={handleQueueForPayment}
                  data-testid="invoice-queue-for-payment"
                >
                  <Send className="h-4 w-4 mr-1" /> Queue for payment
                </Button>
              </>
            )}

            {/* Other status edges (disputed, rejected, re-review) */}
            {statusOptions.length > 0 && status !== 'queued' && (
              <div className="ml-auto flex items-end gap-2">
                <div className="space-y-1">
                  <label htmlFor="status-next" className="text-sm font-medium">
                    Other action
                  </label>
                  <select
                    id="status-next"
                    className={SELECT_CLASS}
                    defaultValue=""
                    onChange={e => {
                      const next = e.target.value as InvoiceStatus
                      if (next && (INVOICE_STATUSES as readonly string[]).includes(next)) {
                        handleStatusChange(next)
                        e.currentTarget.value = ''
                      }
                    }}
                  >
                    <option value="" disabled>Select…</option>
                    {statusOptions.map(s => (
                      <option key={s} value={s}>{slugToTitle(s)}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Queued state — informational. Authorisation lives on the PA tab. */}
            {status === 'queued' && (
              <div className="text-sm text-muted-foreground flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Awaiting payment authorisation. Authorise via the Payment authorisations tab.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Shared
// ════════════════════════════════════════════════════════════════════════════
function InlineError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      className="mb-3 flex items-start gap-2 text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded-md px-3 py-2"
      data-testid="invoice-inline-error"
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
      <span className="flex-1">{message}</span>
      <button onClick={onDismiss} aria-label="Dismiss error">
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
