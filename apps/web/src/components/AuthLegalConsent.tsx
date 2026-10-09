import React, { useState } from 'react'
import { LegalDocumentsModal } from './LegalDocumentsModal'

const inlineLinkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: '#1f8cff',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
}

export function AuthLegalConsent({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <label
        style={{
          marginTop: 14,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          color: '#4b5563',
          fontSize: 11,
          lineHeight: 1.6,
          textAlign: 'left',
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={event => onChange(event.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          I agree to the{' '}
          <button type="button" onClick={() => setOpen(true)} style={inlineLinkStyle}>
            Terms of Service
          </button>{' '}
          and{' '}
          <button type="button" onClick={() => setOpen(true)} style={inlineLinkStyle}>
            Privacy Policy
          </button>
        </span>
      </label>
      <LegalDocumentsModal open={open} onClose={() => setOpen(false)} />
    </>
  )
}
