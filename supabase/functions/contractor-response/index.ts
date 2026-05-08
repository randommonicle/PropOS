/**
 * @file contractor-response/index.ts
 * @description Public Supabase Edge Function — handles contractor accept/decline via token link.
 * No JWT required (verify_jwt = false in config.toml).
 * Called when a contractor clicks Accept or Decline in the dispatch email.
 *
 * Query params:
 *   token  — the UUID token from dispatch_log.token
 *   action — "accept" | "decline"
 *
 * On success: updates dispatch_log.response + works_orders.status, returns HTML confirmation.
 * Error cases: expired token, already responded, invalid token — all return styled HTML pages.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req: Request) => {
  const url    = new URL(req.url)
  const token  = url.searchParams.get('token')?.trim()
  const action = url.searchParams.get('action')?.trim() as 'accept' | 'decline' | undefined

  // Basic validation
  if (!token || !['accept', 'decline'].includes(action ?? '')) {
    return html(errorPage(
      'Invalid Link',
      'This link appears to be malformed or incomplete. Please contact your project manager.',
    ))
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
    return html(errorPage('Error', 'An error occurred looking up your dispatch. Please contact your project manager.'))
  }

  if (!log) {
    return html(errorPage(
      'Link Not Found',
      'This link is not valid or has already been removed. Please contact your project manager.',
    ))
  }

  // Already responded?
  if (log.response && log.response !== 'no_response') {
    const label = log.response === 'accepted' ? 'accepted' : 'declined'
    return html(infoPage(
      'Already Responded',
      `You have already ${label} this works order. No further action is needed.`,
    ))
  }

  // Token expired?
  if (new Date(log.token_expires_at) < new Date()) {
    return html(errorPage(
      'Link Expired',
      'This link has expired (tokens are valid for 7 days). Please contact your project manager to request a new dispatch.',
    ))
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
    return html(errorPage(
      'Error Recording Response',
      'An error occurred saving your response. Please try again or contact your project manager.',
    ))
  }

  // Update works order status
  const { error: orderErr } = await supabase
    .from('works_orders')
    .update({ status: newStatus })
    .eq('id', log.works_order_id)

  if (orderErr) {
    // Response was recorded — works order status failed, but that's recoverable
    console.error('works_order update error:', orderErr)
    return html(infoPage(
      'Response Recorded',
      'Your response was recorded, but the order status could not be updated automatically. Your project manager has been notified.',
    ))
  }

  if (action === 'accept') {
    return html(successPage(
      'Works Order Accepted',
      'Thank you — you have accepted this works order. Your project manager will be in touch shortly to confirm the schedule and access arrangements.',
      true,
    ))
  } else {
    return html(successPage(
      'Works Order Declined',
      'You have declined this works order. Thank you for letting us know — the project manager will re-assign the job.',
      false,
    ))
  }
})

// ── HTML page builders ────────────────────────────────────────────────────────

function html(body: string): Response {
  return new Response(body, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

function page(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} &mdash; PropOS</title>
</head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f4f4f5;min-height:100vh">
  <table width="100%" height="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" valign="middle" style="padding:48px 16px">
      <div style="background:#ffffff;border-radius:10px;border:1px solid #e4e4e7;padding:48px 40px;max-width:480px;width:100%;text-align:center">
        ${content}
        <hr style="border:none;border-top:1px solid #f1f5f9;margin:32px 0 20px">
        <p style="margin:0;font-size:12px;color:#94a3b8">PropOS &middot; Property Management Platform</p>
      </div>
    </td></tr>
  </table>
</body>
</html>`
}

function successPage(title: string, message: string, accepted: boolean): string {
  const bg   = accepted ? '#16a34a' : '#6b7280'
  const icon = accepted ? '&#10003;' : '&#10007;'
  return page(title, `
    <div style="display:inline-flex;align-items:center;justify-content:center;
                width:72px;height:72px;border-radius:50%;background:${bg};margin-bottom:20px">
      <span style="color:#fff;font-size:32px;line-height:1">${icon}</span>
    </div>
    <h1 style="margin:0 0 14px;font-size:22px;color:#111827;font-weight:700">${title}</h1>
    <p style="margin:0;font-size:15px;color:#6b7280;line-height:1.7">${message}</p>
  `)
}

function errorPage(title: string, message: string): string {
  return page(title, `
    <div style="display:inline-flex;align-items:center;justify-content:center;
                width:72px;height:72px;border-radius:50%;background:#dc2626;margin-bottom:20px">
      <span style="color:#fff;font-size:32px;line-height:1;font-weight:700">!</span>
    </div>
    <h1 style="margin:0 0 14px;font-size:22px;color:#111827;font-weight:700">${title}</h1>
    <p style="margin:0;font-size:15px;color:#6b7280;line-height:1.7">${message}</p>
  `)
}

function infoPage(title: string, message: string): string {
  return page(title, `
    <div style="display:inline-flex;align-items:center;justify-content:center;
                width:72px;height:72px;border-radius:50%;background:#2563eb;margin-bottom:20px">
      <span style="color:#fff;font-size:32px;line-height:1;font-weight:700">i</span>
    </div>
    <h1 style="margin:0 0 14px;font-size:22px;color:#111827;font-weight:700">${title}</h1>
    <p style="margin:0;font-size:15px;color:#6b7280;line-height:1.7">${message}</p>
  `)
}
