import React from 'react'
import { HIDLogo } from './HIDLogo'

interface LayoutProps {
  title: string
  subtitle?: string
  children: React.ReactNode
}

export function Layout({ title, subtitle, children }: LayoutProps) {
  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(180deg, #f8fbff 0%, #f2f6fb 100%)' }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 100,
        background: '#fff', borderBottom: '1px solid #e5e7eb',
        padding: '0 24px', height: 56,
        display: 'flex', alignItems: 'center', gap: 16,
      }}>
        <HIDLogo size="sm" />
        <div style={{ width: 1, height: 24, background: '#e5e7eb' }} />
        <div>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#111827' }}>{title}</p>
          {subtitle && <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>{subtitle}</p>}
        </div>
      </div>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 24px' }}>
        {children}
      </div>
    </div>
  )
}
