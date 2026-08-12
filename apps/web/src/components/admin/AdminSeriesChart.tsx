import React from 'react'
import type { AdminMetricPoint } from '../../types/admin'

function formatAxisLabel(timestamp: string) {
  const date = new Date(timestamp)
  return `${date.toLocaleString(undefined, { month: 'short' })} ${date.getDate()}`
}

function sampleAxisLabels(points: AdminMetricPoint[]) {
  if (points.length <= 6) return points
  const step = Math.ceil(points.length / 6)
  return points.filter((_, index) => index % step === 0 || index === points.length - 1)
}

export function AdminSeriesChart({
  points,
  tone = 'var(--admin-accent)',
  type,
}: {
  points: AdminMetricPoint[]
  tone?: string
  type: 'bar' | 'line'
}) {
  if (!points.length) {
    return (
      <div
        style={{
          height: 240,
          borderRadius: 12,
          border: '1px dashed var(--admin-border)',
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          color: 'var(--admin-muted)',
        }}
      >
        No chart data in this window
      </div>
    )
  }

  const max = Math.max(...points.map(point => point.value), 1)
  const labels = sampleAxisLabels(points)

  if (type === 'bar') {
    return (
      <div
        style={{
          border: '1px solid var(--admin-border)',
          borderRadius: 12,
          background: '#fff',
          padding: '14px 14px 10px',
        }}
      >
        <div style={{ height: 220, display: 'grid', gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))`, alignItems: 'end', gap: 8 }}>
          {points.map(point => (
            <div key={point.timestamp} style={{ height: '100%', display: 'flex', alignItems: 'flex-end' }}>
              <div
                title={`${formatAxisLabel(point.timestamp)}: ${point.value}`}
                style={{
                  width: '100%',
                  minHeight: 8,
                  height: `${Math.max((point.value / max) * 190, 8)}px`,
                  borderRadius: '4px 4px 0 0',
                  background: 'linear-gradient(180deg, #22c55e 0%, #16a34a 100%)',
                }}
              />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, rowGap: 4, marginTop: 10, fontSize: 10.5, color: 'var(--admin-muted)' }}>
          {labels.map(point => (
            <span key={`${point.timestamp}-label`}>{formatAxisLabel(point.timestamp)}</span>
          ))}
        </div>
      </div>
    )
  }

  const width = 100
  const height = 44
  const pointsPath = points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width
    const y = height - (point.value / max) * height
    return `${x},${y}`
  }).join(' ')

  const areaPath = `${points.length ? `0,${height} ` : ''}${pointsPath}${points.length ? ` ${width},${height}` : ''}`

  return (
    <div
      style={{
        border: '1px solid var(--admin-border)',
        borderRadius: 12,
        background: '#fff',
        padding: '12px 12px 10px',
      }}
    >
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height: 220, display: 'block' }}>
        <defs>
          <linearGradient id="hid-admin-line-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity="0.18" />
            <stop offset="100%" stopColor={tone} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map(line => {
          const y = (line / 3) * height
          return (
            <line
              key={line}
              x1="0"
              y1={y}
              x2={width}
              y2={y}
              stroke="#edf2f7"
              strokeWidth="0.4"
            />
          )
        })}
        <polygon points={areaPath} fill="url(#hid-admin-line-fill)" />
        <polyline fill="none" stroke={tone} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" points={pointsPath} />
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, rowGap: 4, marginTop: 6, fontSize: 10.5, color: 'var(--admin-muted)' }}>
        {labels.map(point => (
          <span key={`${point.timestamp}-label`}>{formatAxisLabel(point.timestamp)}</span>
        ))}
      </div>
    </div>
  )
}
