/**
 * @file ContractorResponsePage.tsx
 * @description Public page — shown to contractors after clicking Accept/Decline
 * in a dispatch email. No authentication required.
 *
 * Query params (set by the contractor-response Edge Function redirect):
 *   status — accepted | declined | already_responded | expired | invalid | error
 */
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

export function ContractorResponsePage() {
  const [params] = useSearchParams()
  const status = (params.get('status') ?? 'invalid') as Status
  const cfg = CONFIG[status] ?? CONFIG.invalid

  return (
    <div style={{
      fontFamily: 'Arial, Helvetica, sans-serif',
      background: '#f4f4f5',
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '48px 16px',
    }}>
      <div style={{
        background: '#ffffff',
        borderRadius: 10,
        border: '1px solid #e4e4e7',
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
        <h1 style={{ margin: '0 0 14px', fontSize: 22, color: '#111827', fontWeight: 700 }}>
          {cfg.title}
        </h1>

        {/* Message */}
        <p style={{ margin: 0, fontSize: 15, color: '#6b7280', lineHeight: 1.7 }}>
          {cfg.message}
        </p>

        <hr style={{ border: 'none', borderTop: '1px solid #f1f5f9', margin: '32px 0 20px' }} />
        <p style={{ margin: 0, fontSize: 12, color: '#94a3b8' }}>
          PropOS &middot; Property Management Platform
        </p>
      </div>
    </div>
  )
}
