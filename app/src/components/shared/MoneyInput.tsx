/**
 * @file MoneyInput.tsx
 * @description Currency input with integer-pence canonical value. The single component
 * every PropOS form uses to capture monetary amounts. Per Section 6.4 of the spec,
 * financial values are stored and computed as integer pence in memory; this component
 * is the boundary that converts free-form user input into that representation.
 *
 * Contract (recorded in docs/DECISIONS.md, 2026-05-09):
 *   - `value` is integer pence (or null).
 *   - `onChange(pence | null)` fires on every keystroke that produces a parseable value.
 *     Invalid in-progress strokes (e.g. "1.2.3") emit null.
 *   - On blur, the visible draft is reformatted to canonical "1,234.56".
 *   - £ prefix is rendered visually outside the input (so it never enters the value).
 *   - `allowNegative` defaults to false. Bank balances and dual-auth thresholds are
 *     non-negative; `transactions` will pass `allowNegative` for refunds.
 *   - `disabled`: when true, the field renders as read-only with a tooltip slot
 *     (`title` is forwarded). Used for trigger-maintained values like
 *     `bank_accounts.current_balance` per spec §5.6.
 *
 * NOT responsible for: business validation (min/max thresholds, currency conversion).
 */
import * as React from 'react'
import { Input } from '@/components/ui'
import { cn } from '@/lib/utils'
import { parseMoneyInput, formatPenceForInput } from '@/lib/money'

export interface MoneyInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: number | null
  onChange: (pence: number | null) => void
  allowNegative?: boolean
}

export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(
  ({ value, onChange, allowNegative = false, className, onBlur, disabled, ...rest }, ref) => {
    const [draft, setDraft] = React.useState(() => formatPenceForInput(value))

    // Keep the visible draft in sync with the canonical value when the parent
    // mutates it externally (form reset, fetched data arriving). We avoid
    // rewriting the draft mid-typing by only syncing when the parsed equivalent
    // diverges from `value`.
    React.useEffect(() => {
      const draftPence = parseMoneyInput(draft, { allowNegative })
      if (draftPence !== value) {
        setDraft(formatPenceForInput(value))
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value])

    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
      const next = e.target.value
      setDraft(next)
      onChange(parseMoneyInput(next, { allowNegative }))
    }

    function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
      const pence = parseMoneyInput(draft, { allowNegative })
      if (pence == null) {
        setDraft('')
        onChange(null)
      } else {
        setDraft(formatPenceForInput(pence))
        onChange(pence)
      }
      onBlur?.(e)
    }

    return (
      <div className={cn('relative', className)}>
        <span
          aria-hidden="true"
          className={cn(
            'absolute left-3 top-1/2 -translate-y-1/2 text-sm select-none pointer-events-none',
            disabled ? 'text-muted-foreground/60' : 'text-muted-foreground'
          )}
        >
          £
        </span>
        <Input
          {...rest}
          ref={ref}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className="pl-7"
          value={draft}
          disabled={disabled}
          onChange={handleChange}
          onBlur={handleBlur}
        />
      </div>
    )
  }
)
MoneyInput.displayName = 'MoneyInput'
