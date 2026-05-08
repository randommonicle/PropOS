/**
 * @file contractor-response/index.ts
 * @description Public Supabase Edge Function — handles contractor accept/decline via token link.
 * No JWT required (deploy with --no-verify-jwt; config.toml verify_jwt=false is unreliable).
 * Called when a contractor clicks Accept or Decline in the dispatch email.
 *
 * Query params:
 *   token  — the UUID token from dispatch_log.token
 *   action — "accept" | "decline"
 *
 * On all outcomes: redirects to APP_URL/contractor-response?status=<status>
 * The React app renders the confirmation page — avoids Supabase gateway Content-Type issues.
 *
 * APP_URL must be set as a Supabase Edge Function secret:
 *   supabase secrets set APP_URL=https://your-app.vercel.app --project-ref <ref>
 *   (For local dev: http://localhost:5173)
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const APP_URL = (Deno.env.get('APP_URL') ?? 'http://localhost:5173').replace(/\/$/, '')

function redirect(status: string): Response {
  return new Response(null, {
    status: 302,
    headers: new Headers({ 'Location': `${APP_URL}/contractor-response?status=${status}` }),
  })
}

Deno.serve(async (req: Request) => {
  const url    = new URL(req.url)
  const token  = url.searchParams.get('token')?.trim()
  const action = url.searchParams.get('action')?.trim() as 'accept' | 'decline' | undefined

  // Basic validation
  if (!token || !['accept', 'decline'].includes(action ?? '')) {
    return redirect('invalid')
  }

  // Service-role client — this endpoint is unauthenticated, RLS bypassed intentionally
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Look up the dispatch by token
  const { data: log, error: fetchErr } = await supabase
    .from('dispatch_log')
    .select('id, works_order_id, response, response_deadline, token_expires_at')
    .eq('token', token)
    .maybeSingle()

  if (fetchErr) {
    console.error('contractor-response fetch error:', fetchErr)
    return redirect('error')
  }

  if (!log) {
    return redirect('invalid')
  }

  // Already responded?
  if (log.response && log.response !== 'no_response') {
    return redirect('already_responded')
  }

  // Token expired?
  if (new Date(log.token_expires_at) < new Date()) {
    return redirect('expired')
  }

  const response  = action === 'accept' ? 'accepted' : 'declined'
  const newStatus = action === 'accept' ? 'accepted' : 'draft'
  const now       = new Date().toISOString()

  // Record contractor response
  const { error: logErr } = await supabase
    .from('dispatch_log')
    .update({ response, response_received_at: now })
    .eq('id', log.id)

  if (logErr) {
    console.error('dispatch_log update error:', logErr)
    return redirect('error')
  }

  // Update works order status
  const { error: orderErr } = await supabase
    .from('works_orders')
    .update({ status: newStatus })
    .eq('id', log.works_order_id)

  if (orderErr) {
    console.error('works_order update error:', orderErr)
    // Response was recorded — redirect as success with a note the PM will handle status
    return redirect(action === 'accept' ? 'accepted' : 'declined')
  }

  return redirect(action === 'accept' ? 'accepted' : 'declined')
})
