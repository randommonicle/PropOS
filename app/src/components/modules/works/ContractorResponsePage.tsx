/**
 * @file ContractorResponsePage.tsx
 * @description Public page — shown to contractors after clicking Accept/Decline
 * in a dispatch email. No authentication required.
 *
 * Colours follow the visitor's OS dark/light preference via matchMedia —
 * independent of whatever theme the PropOS app is set to.
 *
 * Query params (set by the contractor-response Edge Function redirect):
 *   status — accepted | declined | already_responded | expired | invalid | error
 */
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

type Status = 'accepted' | 'declined' | 'already_responded' | 'expired' | 'invalid' | 'error'

const CONFIG: Record<Status, {
  icon: string
  colour: string
  title: string
  message: string
}> = {
  accepted: {
    icon: '✓',
    colour: '#16a34a',
    title: 'Works Order Accepted',
    message: 'Thank you — you have accepted this works order. Your project manager will be in touch shortly to confirm the schedule and access arrangements.',
  },
  declined: {
    icon: '✕',
    colour: '#6b7280',
    title: 'Works Order Declined',
    message: 'You have declined this works order. Thank you for letting us know — the project manager will re-assign the job.',
  },
  already_responded: {
    icon: 'i',
    colour: '#2563eb',
    title: 'Already Responded',
    message: 'You have already responded to this works order. No further action is needed.',
  },
  expired: {
    icon: '!',
    colour: '#dc2626',
    title: 'Link Expired',
    message: 'This link has expired (tokens are valid for 7 days). Please contact your project manager to request a new dispatch.',
  },
  invalid: {
    icon: '!',
    colour: '#dc2626',
    title: 'Link Not Found',
    message: 'This link is not valid or has already been removed. Please contact your project manager.',
  },
  error: {
    icon: '!',
    colour: '#dc2626',
    title: 'Something Went Wrong',
    message: 'An error occurred processing your response. Please try again or contact your project manager.',
  },
}

function useDarkMode(): boolean {
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return dark
}

export function ContractorResponsePage() {
  const [params] = useSearchParams()
  const status = (params.get('status') ?? 'invalid') as Status
  const cfg    = CONFIG[status] ?? CONFIG.invalid
  const dark   = useDarkMode()

  const colours = dark
    ? { page: '#0f172a', card: '#1e293b', border: '#334155', title: '#f1f5f9', body: '#94a3b8', rule: '#334155', footer: '#64748b' }
    : { page: '#f4f4f5', card: '#ffffff',  border: '#e4e4e7', title: '#111827', body: '#6b7280', rule: '#f1f5f9',  footer: '#94a3b8' }

  return (
    <div style={{
      fontFamily: 'Arial, Helvetica, sans-serif',
      background: colours.page,
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '48px 16px',
    }}>
      <div style={{
        background: colours.card,
        borderRadius: 10,
        border: `1px solid ${colours.border}`,
        padding: '48px 40px',
        maxWidth: 480,
        width: '100%',
        textAlign: 'center',
      }}>
        {/* Icon circle */}
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 72,
          height: 72,
          borderRadius: '50%',
          background: cfg.colour,
          marginBottom: 20,
        }}>
          <span style={{ color: '#fff', fontSize: 32, lineHeight: 1, fontWeight: 700 }}>
            {cfg.icon}
          </span>
        </div>

        {/* Title */}
        <h1 style={{ margin: '0 0 14px', fontSize: 22, color: colours.title, fontWeight: 700 }}>
          {cfg.title}
        </h1>

        {/* Message */}
        <p style={{ margin: 0, fontSize: 15, color: colours.body, lineHeight: 1.7 }}>
          {cfg.message}
        </p>

        <hr style={{ border: 'none', borderTop: `1px solid ${colours.rule}`, margin: '32px 0 20px' }} />
        <p style={{ margin: 0, fontSize: 12, color: colours.footer }}>
          PropOS &middot; Property Management Platform
        </p>
      </div>
    </div>
  )
}
