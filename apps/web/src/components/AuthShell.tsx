import React from 'react'
import { useNavigate } from 'react-router-dom'
import { HIDLogo } from './HIDLogo'
import { PROVIDER_ACCESS_HREF } from '../lib/providerAccess'

const complianceFootnotes = ['HIPAA + NDPC aligned', 'Secure OTP verification'] as const

function ComplianceFootnote() {
  return (
    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', color: '#7d8797', fontSize: 11, marginTop: 22 }}>
      {complianceFootnotes.map(item => (
        <div key={item} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 13, height: 13, borderRadius: '50%', border: '1px solid #2092ff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#2092ff', fontSize: 9 }}>
            +
          </span>
          {item}
        </div>
      ))}
    </div>
  )
}

export function AuthShell({
  title,
  providerLink = true,
  children,
  mode = 'patient',
}: {
  title?: string
  providerLink?: boolean
  children: React.ReactNode
  mode?: 'patient' | 'forgot' | 'provider'
}) {
  const navigate = useNavigate()
  const providerLabel = mode === 'provider' ? 'Patient?' : 'Hospital?'
  const providerActionLabel = 'Sign in here.'

  return (
    <div className="hid-auth-shell" style={{ minHeight: '100vh', background: '#f5f6fa', padding: 'clamp(14px, 4vw, 28px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="hid-auth-card" style={{ width: '100%', maxWidth: 560, background: '#fff', borderRadius: 24, border: '1px solid #eef1f6', boxShadow: '0 18px 40px rgba(25, 46, 86, 0.06)', padding: 'clamp(18px, 5vw, 30px)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', rowGap: 8 }}>
          <HIDLogo size="xs" />
          {providerLink && (
            <button
              onClick={() => {
                if (mode === 'provider') {
                  navigate('/patient')
                  return
                }
                if (/^https?:\/\//i.test(PROVIDER_ACCESS_HREF)) {
                  window.location.assign(PROVIDER_ACCESS_HREF)
                  return
                }
                navigate(PROVIDER_ACCESS_HREF)
              }}
              style={{ textAlign: 'right', fontSize: 10, color: '#9ba7b7', lineHeight: 1.4, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
            >
              {providerLabel}
              <br />
              <span style={{ color: '#1f8cff', textDecoration: 'underline' }}>{providerActionLabel}</span>
            </button>
          )}
        </div>
        {title && <div className="hid-auth-title" style={{ marginTop: 24, fontSize: 28, fontWeight: 700, color: '#111827' }}>{title}</div>}
        <div style={{ marginTop: title ? 22 : 28, display: 'flex', flexDirection: 'column', minHeight: 'min(68vh, 560px)' }}>
          {children}
          <div style={{ marginTop: 'auto' }}>
            <ComplianceFootnote />
          </div>
        </div>
      </div>
    </div>
  )
}
