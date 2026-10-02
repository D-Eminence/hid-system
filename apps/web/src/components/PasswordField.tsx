import React, { useState } from 'react'

export function PasswordField({
  id, label, value, onChange, autoComplete, minLength, maxLength = 256,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: 'current-password' | 'new-password'
  minLength?: number
  maxLength?: number
}) {
  const [visible, setVisible] = useState(false)

  return <div style={{ display: 'grid', gap: 6 }}>
    <label htmlFor={id} style={{ fontSize: 14, fontWeight: 700 }}>{label}</label>
    <div style={{ display: 'flex', alignItems: 'stretch', width: '100%' }}>
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        minLength={minLength}
        maxLength={maxLength}
        required
        value={value}
        onChange={event => onChange(event.target.value)}
        style={{ flex: 1, minWidth: 0, minHeight: 46, border: '1px solid #bdc9da', borderRadius: '10px 0 0 10px', padding: '10px 13px', font: 'inherit' }}
      />
      <button
        type="button"
        aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
        aria-pressed={visible}
        onClick={() => setVisible(current => !current)}
        style={{ minWidth: 64, border: '1px solid #bdc9da', borderLeft: 0, borderRadius: '0 10px 10px 0', background: '#f8fbff', color: '#1254a8', font: 'inherit', cursor: 'pointer' }}
      >{visible ? 'Hide' : 'Show'}</button>
    </div>
  </div>
}
