import React, { useRef } from 'react'

/** Keep the code contiguous so a partial paste cannot reuse stale trailing digits. */
export function nextOtpValue(value: string, index: number, raw: string, paste = false) {
  const digits = raw.replace(/\D/g, '').slice(0, 6)
  if (!digits) return value.slice(0, index)
  if (paste || digits.length > 1) {
    const prefix = digits.length === 6 || value.length < index ? '' : value.slice(0, index)
    return (prefix + digits).slice(0, 6)
  }
  const position = Math.min(index, value.length)
  return (value.slice(0, position) + digits + value.slice(position + 1)).slice(0, 6)
}

export function shouldCompleteOtp(next: string, raw: string, paste = false) {
  return next.length === 6 && (!paste || raw.replace(/\D/g, '').length >= 6)
}

export function OtpInputs({
  value,
  onChange,
  onComplete,
}: {
  value: string
  onChange: (next: string) => void
  onComplete?: (next: string) => void
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([])

  function applyDigits(startIndex: number, raw: string, paste = false) {
    const next = nextOtpValue(value, startIndex, raw, paste)
    if (next === value && !raw.replace(/\D/g, '')) return
    onChange(next)

    const focusIndex = Math.min(next.length, 5)
    refs.current[focusIndex]?.focus()
    refs.current[focusIndex]?.select()
    // A short paste is still a partial entry, even if a pre-existing prefix
    // happens to make the combined value six digits long.
    if (shouldCompleteOtp(next, raw, paste)) onComplete?.(next)
  }

  function updateAt(index: number, raw: string) {
    const digits = raw.replace(/\D/g, '')
    applyDigits(index, digits)
  }

  function pasteAt(index: number, event: React.ClipboardEvent<HTMLInputElement>) {
    const digits = event.clipboardData.getData('text').replace(/\D/g, '')
    if (!digits) return

    event.preventDefault()
    applyDigits(index, digits, true)
  }

  return (
    <div style={{ display: 'flex', gap: 'clamp(6px, 2vw, 10px)', justifyContent: 'center' }}>
      {Array.from({ length: 6 }).map((_, index) => (
        <input
          key={index}
          ref={element => { refs.current[index] = element }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          aria-label={`Verification code digit ${index + 1}`}
          value={value[index] ?? ''}
          onChange={event => updateAt(index, event.target.value)}
          onPaste={event => pasteAt(index, event)}
          onKeyDown={event => {
            if (event.key === 'Backspace' && !value[index] && index > 0) refs.current[index - 1]?.focus()
            if (event.key === 'ArrowLeft' && index > 0) refs.current[index - 1]?.focus()
            if (event.key === 'ArrowRight' && index < 5) refs.current[index + 1]?.focus()
          }}
          style={{
            width: 'clamp(36px, 9vw, 42px)',
            height: 'clamp(40px, 10vw, 42px)',
            borderRadius: 10,
            border: '1px solid #d6deea',
            textAlign: 'center',
            fontSize: 'clamp(16px, 4vw, 18px)',
            color: '#111827',
            background: '#fff',
          }}
        />
      ))}
    </div>
  )
}
