import React from 'react'

function formatValue(value: number | null, formatter?: (value: number | null) => string) {
  if (formatter) return formatter(value)
  if (value == null) return 'N/A'
  return new Intl.NumberFormat().format(value)
}

function toneColor(tone: 'positive' | 'warning' | 'critical' | 'neutral') {
  if (tone === 'positive') return 'var(--admin-success)'
  if (tone === 'warning') return 'var(--admin-warn)'
  if (tone === 'critical') return 'var(--admin-danger)'
  return 'var(--admin-muted)'
}

function defaultMetricIcon(accent: string) {
  return (
    <span
      style={{
        width: 20,
        height: 20,
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(26, 111, 212, 0.08)',
        color: accent,
      }}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
        <path d="M4 11.5 7 8.5l2 2L12 6.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

export function AdminMetricCard({
  accent,
  helper,
  icon,
  title,
  trendLabel,
  trendTone = 'neutral',
  value,
  valueFormatter,
}: {
  accent: string
  helper?: string
  icon?: React.ReactNode
  title: string
  trendLabel?: string | null
  trendTone?: 'positive' | 'warning' | 'critical' | 'neutral'
  value: number | null
  valueFormatter?: (value: number | null) => string
}) {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--admin-border)',
        borderRadius: 12,
        padding: '12px 14px',
        minHeight: 92,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        boxShadow: 'var(--admin-shadow)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--admin-muted)', minWidth: 0, overflowWrap: 'anywhere' }}>
          {title}
        </div>
        <div style={{ flexShrink: 0 }}>{icon ?? defaultMetricIcon(accent)}</div>
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 24, lineHeight: 1.05, fontWeight: 800, letterSpacing: '-0.04em', color: 'var(--admin-text)', overflowWrap: 'anywhere' }}>
          {formatValue(value, valueFormatter)}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8, minWidth: 0 }}>
        {trendLabel && (
          <div style={{ fontSize: 10.5, fontWeight: 700, color: toneColor(trendTone), overflowWrap: 'anywhere' }}>
            {trendLabel}
          </div>
        )}
        {helper && (
          <div style={{ fontSize: 10.5, color: 'var(--admin-muted)', overflowWrap: 'anywhere' }}>
            {helper}
          </div>
        )}
      </div>
    </div>
  )
}
