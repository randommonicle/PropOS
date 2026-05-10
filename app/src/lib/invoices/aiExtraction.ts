/**
 * @file aiExtraction.ts
 * @description Thin client wrapper over the `document_processing` Edge
 * Function. Used by InvoicesTab after a file has been uploaded to Storage
 * and a `documents` row has been inserted with `document_type='invoice'`.
 *
 * Responsible for: invoking the Edge Function, surfacing structured errors
 *                  with a `stage` field so the UI can distinguish between
 *                  "the function failed to reach Anthropic", "Anthropic
 *                  failed to extract", and "DB write failed after extraction".
 * NOT responsible for: the Storage upload itself (consumer does that);
 *                      polling for ai_processed_at (consumer re-queries the
 *                      documents row + invoices row after this resolves);
 *                      retry on transient failure (consumer decides);
 *                      cost-cap enforcement (FORWARD: PROD-GATE — Edge
 *                      Function reads DAILY_AI_COST_CAP_GBP per firm).
 */
import { supabase } from '@/lib/supabase'

export type ExtractionStage =
  | 'invoke'
  | 'document_load'
  | 'storage_download'
  | 'anthropic_call'
  | 'extraction_parse'
  | 'documents_update'
  | 'invoices_upsert'

export interface ExtractionResult {
  ok: true
  document_id:    string
  invoice_id:     string
  confidence:     number
  extracted_data: Record<string, unknown>
}

export interface ExtractionError {
  ok: false
  stage:   ExtractionStage
  message: string
}

/**
 * Run AI extraction over a previously-uploaded `documents` row. The Edge
 * Function handles: load document + verify mime; download bytes from Storage;
 * call the Anthropic API with a JSON-mode prompt for the 8 invoice fields +
 * a confidence + a notes blob; write back to documents.ai_extracted_data +
 * ai_processed_at; INSERT or UPDATE the linked `invoices` row stamping
 * extracted_by_ai=true and extraction_confidence per spec §5.7.
 *
 * Returns either an ExtractionResult (consumer re-queries the invoices row
 * to populate the drawer for PM review) or an ExtractionError with a `stage`
 * field surfaced to the UI for the failure-stage smoke (LESSONS Phase 3
 * session 2 — modal-vs-DB-query race; here, extraction-stage-vs-toast race).
 */
export async function runAiExtraction(
  documentId: string,
): Promise<ExtractionResult | ExtractionError> {
  const { data, error } = await supabase.functions.invoke<
    ExtractionResult | ExtractionError
  >('document_processing', { body: { document_id: documentId } })

  if (error) {
    return {
      ok: false,
      stage: 'invoke',
      message: error.message ?? 'Edge Function invocation failed',
    }
  }
  if (!data) {
    return {
      ok: false,
      stage: 'invoke',
      message: 'Edge Function returned no body',
    }
  }
  return data
}
