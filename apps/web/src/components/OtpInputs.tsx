import React, { useRef } from 'react'

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

  function applyDigits(startIndex: number, raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, 6 - startIndex)
    if (!digits) return

    const next = Array.from({ length: 6 }, (_, index) => value[index] ?? '')
    digits.split('').forEach((digit, offset) => {
      next[startIndex + offset] = digit
    })

    const joined = next.join('').slice(0, 6)
    onChange(joined)

    const focusIndex = Math.min(startIndex + digits.length, 5)
    refs.current[focusIndex]?.focus()
    refs.current[focusIndex]?.select()
    if (joined.length === 6) onComplete?.(joined)
  }

  function updateAt(index: number, raw: string) {
    const digits = raw.replace(/\D/g, '')
    if (!digits) {
      const next = value.split('')
      next[index] = ''
      onChange(next.join(''))
      return
    }

    applyDigits(index, digits)
  }

  function pasteAt(index: number, event: React.ClipboardEvent<HTMLInputElement>) {
    const digits = event.clipboardData.getData('text').replace(/\D/g, '')
    if (!digits) return

    event.preventDefault()
    applyDigits(digits.length >= 6 ? 0 : index, digits)
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
