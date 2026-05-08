/**
 * @file dispatch-engine/index.ts
 * @description Supabase Edge Function — sends dispatch notification email via Resend.
 * Called by the frontend immediately after a dispatch_log record is created.
 * Uses the caller's JWT so RLS applies; email failure does NOT roll back the dispatch.
 *
 * POST body: { dispatch_log_id: string }
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Resend } from 'https://esm.sh/resend@3'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  try {
    const { dispatch_log_id } = await req.json()
    if (!dispatch_log_id) {
      return json({ error: 'dispatch_log_id required' }, 400)
    }

    // Use the caller's JWT — RLS ensures they can only read their own firm's data
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const authHeader = req.headers.get('Authorization') ?? ''
    const supabase = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )

    // Fetch dispatch log + related data in a single query
    const { data: log, error: fetchErr } = await supabase
      .from('dispatch_log')
      .select(`
        id, token, response_deadline,
        contractor:contractors ( company_name, contact_name, email ),
        works_order:works_orders (
          description, priority, estimated_cost, required_by,
          property:properties ( address_line1, town, postcode )
        )
      `)
      .eq('id', dispatch_log_id)
      .single()

    if (fetchErr || !log) {
      return json({ error: fetchErr?.message ?? 'Dispatch log not found' }, 404)
    }

    const contractor = log.contractor as {
      company_name: string; contact_name: string | null; email: string | null
    } | null

    if (!contractor?.email) {
      return json({ error: 'Contractor has no email address on file. Dispatch saved; email not sent.' }, 422)
    }

    // Build accept / decline URLs pointing at the contractor-response Edge Function
    const fnBase = `${supabaseUrl}/functions/v1/contractor-response`
    const acceptUrl  = `${fnBase}?token=${log.token}&action=accept`
    const declineUrl = `${fnBase}?token=${log.token}&action=decline`

    const wo = log.works_order as {
      description: string; priority: string; estimated_cost: number | null; required_by: string | null
      property: { address_line1: string | null; town: string | null; postcode: string | null } | null
    } | null

    const propParts = [wo?.property?.address_line1, wo?.property?.town, wo?.property?.postcode]
    const propertyLine = propParts.filter(Boolean).join(', ') || 'See project manager for details'

    const deadline = new Date(log.response_deadline).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    })

    const contactName = contractor.contact_name ?? contractor.company_name

    // Send via Resend
    const resend = new Resend(Deno.env.get('RESEND_API_KEY')!)
    const { error: sendErr } = await resend.emails.send({
      from: 'PropOS Works <works@propos.app>',
      to: contractor.email,
      subject: `Works order — ${wo?.description ?? 'New dispatch'}`,
      html: buildEmail({
        contactName,
        description: wo?.description ?? 'No description provided',
        propertyLine,
        priority: wo?.priority ?? 'normal',
        estimatedCost: wo?.estimated_cost ?? null,
        requiredBy: wo?.required_by ?? null,
        deadline,
        acceptUrl,
        declineUrl,
      }),
    })

    if (sendErr) {
      console.error('Resend error:', sendErr)
      return json({ error: sendErr.message }, 500)
    }

    return json({ ok: true, email_sent_to: contractor.email })

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('dispatch-engine error:', msg)
    return json({ error: msg }, 500)
  }
})

// ── helpers ──────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function buildEmail(p: {
  contactName: string
  description: string
  propertyLine: string
  priority: string
  estimatedCost: number | null
  requiredBy: string | null
  deadline: string
  acceptUrl: string
  declineUrl: string
}): string {
  const priorityColour: Record<string, string> = {
    emergency: '#dc2626', high: '#d97706', normal: '#2563eb', low: '#6b7280',
  }
  const pColour = priorityColour[p.priority] ?? '#2563eb'

  const costLine = p.estimatedCost
    ? `<p style="margin:0 0 4px;font-size:13px;color:#6b7280"><strong>Estimated cost:</strong> £${Number(p.estimatedCost).toFixed(2)}</p>`
    : ''
  const reqByLine = p.requiredBy
    ? `<p style="margin:0 0 4px;font-size:13px;color:#6b7280"><strong>Required by:</strong> ${new Date(p.requiredBy).toLocaleDateString('en-GB')}</p>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f4f4f5">
<table width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding:32px 16px">
    <table width="600" cellpadding="0" cellspacing="0"
           style="background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e4e4e7">

      <!-- Header -->
      <tr><td style="background:#1e293b;padding:24px 32px">
        <p style="margin:0;color:#ffffff;font-size:20px;font-weight:bold">PropOS &mdash; Works Dispatch</p>
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:32px">
        <p style="margin:0 0 16px;font-size:16px;color:#111827">Dear ${escHtml(p.contactName)},</p>
        <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.6">
          A works order has been assigned to your company. Please review the details and respond by the deadline below.
        </p>

        <!-- Job details -->
        <table width="100%" cellpadding="0" cellspacing="0"
               style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:24px">
          <tr><td style="padding:20px">
            <p style="margin:0 0 4px;font-size:11px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:0.08em">Works Description</p>
            <p style="margin:0 0 16px;font-size:16px;color:#111827;font-weight:600">${escHtml(p.description)}</p>
            <p style="margin:0 0 4px;font-size:13px;color:#6b7280"><strong>Property:</strong> ${escHtml(p.propertyLine)}</p>
            <p style="margin:0 0 4px;font-size:13px;color:#6b7280">
              <strong>Priority:</strong>
              <span style="color:${pColour};font-weight:600;text-transform:capitalize">${escHtml(p.priority)}</span>
            </p>
            ${costLine}
            ${reqByLine}
            <p style="margin:0;font-size:13px;color:#6b7280">
              <strong>Respond by:</strong>
              <span style="font-weight:600;color:#111827">${escHtml(p.deadline)}</span>
            </p>
          </td></tr>
        </table>

        <p style="margin:0 0 20px;font-size:14px;color:#374151">
          Please click one of the buttons below. If you do not respond by the deadline the order may be re-assigned.
        </p>

        <!-- CTA buttons -->
        <table cellpadding="0" cellspacing="0" style="margin-bottom:28px">
          <tr>
            <td style="padding-right:12px">
              <a href="${p.acceptUrl}"
                 style="display:inline-block;background:#16a34a;color:#ffffff;font-size:15px;font-weight:700;padding:13px 32px;border-radius:6px;text-decoration:none">
                &#10003;&nbsp; Accept
              </a>
            </td>
            <td>
              <a href="${p.declineUrl}"
                 style="display:inline-block;background:#dc2626;color:#ffffff;font-size:15px;font-weight:700;padding:13px 32px;border-radius:6px;text-decoration:none">
                &#10007;&nbsp; Decline
              </a>
            </td>
          </tr>
        </table>

        <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6">
          This link expires 7&nbsp;days after dispatch. If you have already responded, you can ignore this email.<br>
          Do not forward this email &mdash; the links are unique to this dispatch.
        </p>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e4e4e7">
        <p style="margin:0;font-size:12px;color:#9ca3af">Sent by PropOS &middot; Property Management Platform</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
