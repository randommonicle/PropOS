/**
 * @file document_processing/index.ts
 * @description Supabase Edge Function — runs Claude over an uploaded invoice
 * PDF/image and populates `documents.ai_extracted_data` + creates/updates the
 * linked `invoices` row with the 8 spec §5.7 fields. Called from the
 * InvoicesTab via `supabase.functions.invoke('document_processing', { body:
 * { document_id } })` immediately after a documents row is inserted.
 *
 * Responsible for: load document; download bytes from Storage; call Anthropic
 *                  with a JSON-mode prompt; persist extracted data + invoices
 *                  row; surface stage-tagged errors per ExtractionStage.
 * NOT responsible for: Storage upload (client does it); PM confirmation gate
 *                      (client renders drawer for PM after this resolves);
 *                      DAILY_AI_COST_CAP_GBP enforcement (FORWARD: PROD-GATE);
 *                      INSERT-trigger invocation (FORWARD: PROD-GATE — today
 *                      this is client-invoked).
 *
 * Regulatory: spec §6.4 integer-pence — amounts are stored as NUMERIC(14,2)
 * in DB but the JSON returned to the client carries pounds-decimal (e.g.
 * 1234.56) per the existing 1d / 1e convention; UI converts on save.
 *
 * FORWARD: PROD-GATE — INSERT trigger on documents row firing this function
 * automatically. Today the client invokes after documents.insert succeeds.
 * Anchor: docs/DECISIONS.md 2026-05-10 — Invoices CRUD with AI extraction.
 *
 * FORWARD: PROD-GATE — DAILY_AI_COST_CAP_GBP per-firm enforcement (spec §5.7
 * AI COST CONTROL). Requires firm-cost-tracking table not yet built. Phase 5+.
 *
 * POST body: { document_id: string }
 * Response (success): { ok: true, document_id, invoice_id, confidence, extracted_data }
 * Response (failure): { ok: false, stage: ExtractionStage, message: string }
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.32'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Spec §5.7 — runtime model from env, defaulting to claude-sonnet-4-6.
const RUNTIME_MODEL = Deno.env.get('ANTHROPIC_RUNTIME_MODEL') ?? 'claude-sonnet-4-6'

// Single bucket for PoC (DECISIONS 2026-05-07 + DocumentsPage); spec §5.7
// suggests a per-firm bucket — FORWARD: Phase 8 self-host package.
const BUCKET = 'documents'

const EXTRACTION_PROMPT = `You are extracting structured data from a UK property-management invoice (a contractor invoice or supplier bill for a residential service-charge account).

Return ONLY a JSON object matching this exact shape — no prose, no markdown fences:

{
  "invoice_number":  string | null,    // the supplier's invoice number
  "invoice_date":    string | null,    // ISO 8601 date YYYY-MM-DD
  "due_date":        string | null,    // ISO 8601 date YYYY-MM-DD; null if not stated
  "amount_net":      number | null,    // pounds decimal (e.g. 1234.56), excluding VAT
  "vat_amount":      number | null,    // pounds decimal; 0 if no VAT shown
  "amount_gross":    number | null,    // pounds decimal; net + VAT
  "payee":           string | null,    // supplier company name (the entity to be paid)
  "description":     string | null,    // 1-line summary of what the invoice is for
  "confidence":      number,           // 0.000 to 1.000 — your stated confidence in the extraction
  "notes":           string | null     // optional free-text caveats (e.g. "VAT not itemised; gross only")
}

Rules:
- Amounts are pounds decimal (NOT pence). amount_gross = amount_net + vat_amount when all three are present.
- Dates strictly ISO 8601 (YYYY-MM-DD). Convert UK formats (DD/MM/YYYY, "12 March 2026") to ISO.
- Confidence reflects your honest assessment. Use ≥0.9 only when every field is clearly visible. Use 0.5-0.7 when fields are inferred from context. Use <0.5 when material fields are unreadable.
- If a field is genuinely absent or unreadable, return null — do NOT guess.
- Strip currency prefixes (£, $) from amounts.
- Notes is for caveats only; do NOT repeat fields here.`

interface ExtractedInvoice {
  invoice_number: string | null
  invoice_date:   string | null
  due_date:       string | null
  amount_net:     number | null
  vat_amount:     number | null
  amount_gross:   number | null
  payee:          string | null
  description:    string | null
  confidence:     number
  notes:          string | null
}

type Stage =
  | 'invoke' | 'document_load' | 'storage_download'
  | 'anthropic_call' | 'extraction_parse'
  | 'documents_update' | 'invoices_upsert'

function fail(stage: Stage, message: string, status = 500) {
  return new Response(
    JSON.stringify({ ok: false, stage, message }),
    { status, headers: { ...CORS, 'Content-Type': 'application/json' } },
  )
}

function ok(payload: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ ok: true, ...payload }),
    { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
  )
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  // ── 1. Parse body + auth client ────────────────────────────────────────────
  let documentId: string
  try {
    const body = await req.json()
    documentId = body?.document_id
    if (!documentId || typeof documentId !== 'string') {
      return fail('invoke', 'document_id required (string)', 400)
    }
  } catch {
    return fail('invoke', 'Invalid JSON body', 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const authHeader  = req.headers.get('Authorization') ?? ''
  const supabase = createClient(
    supabaseUrl,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )

  // ── 2. Load document row (RLS enforces firm scope) ─────────────────────────
  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .select('id, firm_id, property_id, document_type, storage_path, mime_type, filename')
    .eq('id', documentId)
    .single()
  if (docErr || !doc) {
    return fail('document_load', docErr?.message ?? 'document not found', 404)
  }
  if (doc.document_type !== 'invoice') {
    return fail('document_load',
      `document_type='${doc.document_type}' — this Edge Function only handles 'invoice'.`,
      400)
  }

  // ── 3. Download file bytes from Storage ────────────────────────────────────
  const { data: blob, error: dlErr } = await supabase.storage
    .from(BUCKET)
    .download(doc.storage_path)
  if (dlErr || !blob) {
    return fail('storage_download', dlErr?.message ?? 'failed to download bytes')
  }

  const bytes = new Uint8Array(await blob.arrayBuffer())
  const base64 = encodeBase64(bytes)
  const mediaType = doc.mime_type ?? 'application/octet-stream'

  // ── 4. Anthropic call (vision + JSON-mode prompt) ──────────────────────────
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!anthropicKey) {
    return fail('anthropic_call', 'ANTHROPIC_API_KEY not configured on the Edge Function. Set via `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`')
  }

  const anthropic = new Anthropic({ apiKey: anthropicKey })
  let raw: string
  try {
    const resp = await anthropic.messages.create({
      model: RUNTIME_MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          isPdfMime(mediaType)
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } } as never
            : { type: 'image',    source: { type: 'base64', media_type: mediaType,        data: base64 } } as never,
          { type: 'text', text: EXTRACTION_PROMPT },
        ],
      }],
    })
    const textBlock = resp.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
    if (!textBlock) {
      return fail('anthropic_call', 'Anthropic returned no text block')
    }
    raw = textBlock.text
  } catch (err) {
    return fail('anthropic_call', err instanceof Error ? err.message : String(err))
  }

  // ── 5. Parse Anthropic JSON response ───────────────────────────────────────
  let extracted: ExtractedInvoice
  try {
    extracted = JSON.parse(stripCodeFences(raw)) as ExtractedInvoice
  } catch {
    return fail('extraction_parse',
      `Anthropic response was not valid JSON. First 200 chars: ${raw.slice(0, 200)}`)
  }
  if (typeof extracted.confidence !== 'number'
      || extracted.confidence < 0 || extracted.confidence > 1) {
    return fail('extraction_parse',
      `confidence must be a number 0-1; got ${JSON.stringify(extracted.confidence)}`)
  }

  // ── 6. Persist to documents.ai_extracted_data ──────────────────────────────
  const { error: docUpdErr } = await supabase
    .from('documents')
    .update({
      ai_extracted_data: extracted as unknown as Record<string, unknown>,
      ai_processed_at: new Date().toISOString(),
    })
    .eq('id', doc.id)
  if (docUpdErr) {
    return fail('documents_update', docUpdErr.message)
  }

  // ── 7. Upsert linked invoices row ──────────────────────────────────────────
  // The CHECK constraints from 00028 require: extracted_by_ai=true ⇔ confidence
  // not null; gross = net + vat when all three present; status in canonical six.
  // The amount-coherence check is satisfied iff Claude returned consistent
  // amounts; we trust extraction here and let the CHECK reject any inconsistent
  // triple (the stage 'invoices_upsert' surfaces it to the client).

  const invoicePayload = {
    firm_id:               doc.firm_id,
    property_id:           doc.property_id ?? '', // documents.property_id is nullable for firm-level uploads; invoices.property_id is NOT NULL
    document_id:           doc.id,
    invoice_number:        extracted.invoice_number,
    invoice_date:          extracted.invoice_date,
    due_date:              extracted.due_date,
    amount_net:            extracted.amount_net,
    vat_amount:            extracted.vat_amount,
    amount_gross:          extracted.amount_gross,
    description:           extracted.description ?? extracted.payee ?? doc.filename,
    extracted_by_ai:       true,
    extraction_confidence: round3(extracted.confidence),
    extraction_notes:      buildExtractionNotes(extracted),
    status:                'received' as const,
  }

  if (!invoicePayload.property_id) {
    return fail('invoices_upsert',
      'documents.property_id is null but invoices.property_id is required. Upload from a per-property context (the InvoicesTab) rather than a firm-level upload.')
  }

  // Idempotent: if an invoices row already exists for this document_id (e.g.
  // re-running extraction) we update it; otherwise insert.
  const { data: existing } = await supabase
    .from('invoices')
    .select('id')
    .eq('document_id', doc.id)
    .maybeSingle()

  let invoiceId: string
  if (existing?.id) {
    const { error } = await supabase
      .from('invoices').update(invoicePayload).eq('id', existing.id)
    if (error) return fail('invoices_upsert', error.message)
    invoiceId = existing.id
  } else {
    const { data, error } = await supabase
      .from('invoices').insert(invoicePayload).select('id').single()
    if (error || !data) return fail('invoices_upsert', error?.message ?? 'no row returned')
    invoiceId = data.id
  }

  return ok({
    document_id:    doc.id,
    invoice_id:     invoiceId,
    confidence:     round3(extracted.confidence),
    extracted_data: extracted as unknown as Record<string, unknown>,
  })
})

// ── helpers ──────────────────────────────────────────────────────────────────

function isPdfMime(m: string): boolean {
  return m === 'application/pdf' || m.endsWith('/pdf')
}

function stripCodeFences(s: string): string {
  // Anthropic occasionally wraps JSON in ```json fences despite the prompt; strip them.
  return s.trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim()
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function buildExtractionNotes(e: ExtractedInvoice): string {
  const parts: string[] = []
  parts.push(`AI extraction (${RUNTIME_MODEL}) on ${new Date().toISOString().slice(0, 10)} — confidence ${round3(e.confidence)}.`)
  if (e.payee) parts.push(`Payee: ${e.payee}.`)
  if (e.notes) parts.push(`Notes: ${e.notes}`)
  return parts.join(' ')
}

function encodeBase64(bytes: Uint8Array): string {
  // Deno: btoa requires latin-1 string; chunk to avoid call-stack overflow on large files.
  let bin = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(bin)
}
