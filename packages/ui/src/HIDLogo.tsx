import React from 'react'

interface Props {
  size?: 'xs' | 'sm' | 'md' | 'lg'
  theme?: 'dark' | 'light' | 'white'
}

const S = {
  xs: { img: 24, name: 13, sub: 6.5, gap: 8 },
  sm: { img: 30, name: 16, sub: 7.5, gap: 9 },
  md: { img: 38, name: 19, sub: 8.5, gap: 11 },
  lg: { img: 52, name: 26, sub: 10,  gap: 14 },
}

export function HIDLogo({ size = 'md', theme = 'dark' }: Props) {
  const s = S[size]
  const nameColor = theme === 'white' ? '#fff' : '#111827'
  const subColor  = theme === 'white' ? 'rgba(255,255,255,0.7)' : '#9ca3af'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: s.gap, flexShrink: 0 }}>
      <img
        src="/hid-logo.png"
        alt="HID"
        style={{ width: s.img, height: 'auto', display: 'block', flexShrink: 0 }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
        <span style={{ fontSize: s.name, fontWeight: 800, color: nameColor, letterSpacing: '-0.4px' }}>
          HID
        </span>
        <span style={{
          fontSize: s.sub, fontWeight: 700, color: subColor,
          letterSpacing: '0.5px', marginTop: 3,
          textTransform: 'uppercase' as const, lineHeight: 1
        }}>
          Health Identity Directory
        </span>
      </div>
    </div>
  )
}
