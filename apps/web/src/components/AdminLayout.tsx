import React, { useEffect, useState } from 'react'
import { HIDLogo } from './HIDLogo'

export type AdminSidebarSection = {
  id: string
  label: string
  href?: string
}

const themeVars = {
  '--admin-accent': '#1a6fd4',
  '--admin-accent-soft': 'rgba(26, 111, 212, 0.12)',
  '--admin-bg': '#f5f7fb',
  '--admin-border': '#e7edf5',
  '--admin-card-bg': '#ffffff',
  '--admin-danger': '#ef4444',
  '--admin-muted': '#7a8899',
  '--admin-panel-bg': '#ffffff',
  '--admin-shadow': '0 8px 24px rgba(15, 23, 42, 0.05)',
  '--admin-sidebar-bg': '#0f1724',
  '--admin-sidebar-border': '#1f2937',
  '--admin-sidebar-text': '#94a3b8',
  '--admin-sidebar-text-active': '#ffffff',
  '--admin-soft': '#f8fbff',
  '--admin-success': '#22c55e',
  '--admin-text': '#111827',
  '--admin-warn': '#f59e0b',
} as const

function sidebarIcon(id: string, active: boolean) {
  const color = active ? 'var(--admin-sidebar-text-active)' : 'var(--admin-sidebar-text)'
  const common = { stroke: color, strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

  switch (id) {
    case 'dashboard':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.1" {...common} />
          <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.1" {...common} />
          <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.1" {...common} />
          <rect x="9" y="9" width="4.5" height="4.5" rx="1.1" {...common} />
        </svg>
      )
    case 'users':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="6" cy="5.5" r="2.2" {...common} />
          <path d="M2.8 12.5c.4-1.8 1.8-2.9 3.2-2.9 1.4 0 2.8 1.1 3.2 2.9" {...common} />
          <path d="M11.2 6.2c1 0 1.8.8 1.8 1.8" {...common} />
          <path d="M10.8 12.4c.2-1 .8-1.7 1.8-2" {...common} />
        </svg>
      )
    case 'records':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="3" y="2.5" width="10" height="11" rx="1.6" {...common} />
          <path d="M5.5 5.5h5" {...common} />
          <path d="M5.5 8h5" {...common} />
          <path d="M5.5 10.5h3.2" {...common} />
        </svg>
      )
    case 'providers':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M3 13V6.5L8 3l5 3.5V13" {...common} />
          <path d="M6.2 13V9.4h3.6V13" {...common} />
        </svg>
      )
    case 'security':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M8 2.5 12.5 4v3.1c0 2.7-1.7 4.7-4.5 6.4-2.8-1.7-4.5-3.7-4.5-6.4V4L8 2.5Z" {...common} />
          <path d="M8 6.2v2.3" {...common} />
          <circle cx="8" cy="10.4" r=".5" fill={color} />
        </svg>
      )
    case 'analytics':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M3 12.5h10" {...common} />
          <path d="M5 11V8.5" {...common} />
          <path d="M8 11V5.5" {...common} />
          <path d="M11 11V7" {...common} />
        </svg>
      )
    case 'billing':
    case 'billing-overview':
    case 'subscriptions':
    case 'invoices':
    case 'payments':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="2.5" y="3.5" width="11" height="9" rx="1.7" {...common} />
          <path d="M2.8 6.5h10.4M5 10h2.4" {...common} />
        </svg>
      )
    case 'ai-processing':
    case 'migrate-overview':
    case 'routing':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="4" y="4" width="8" height="8" rx="2" {...common} />
          <path d="M6.5 8h3M8 6.5v3M2.5 6h1.5M2.5 10h1.5M12 6h1.5M12 10h1.5M6 2.5V4M10 2.5V4M6 12v1.5M10 12v1.5" {...common} />
        </svg>
      )
    case 'settings':
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="2" {...common} />
          <path d="M8 2.8v1.1M8 12.1v1.1M12.1 8h1.1M2.8 8h1.1M11.6 4.4l-.8.8M5.2 10.8l-.8.8M11.6 11.6l-.8-.8M5.2 5.2l-.8-.8" {...common} />
        </svg>
      )
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="4.5" {...common} />
        </svg>
      )
  }
}

export function AdminLayout({
  activeSection,
  children,
  darkMode: _darkMode,
  notificationsCount,
  onNotificationsClick,
  onLogout,
  onSearchChange,
  onToggleTheme: _onToggleTheme,
  searchQuery,
  sections,
  title,
  userName,
}: {
  activeSection: string
  children: React.ReactNode
  darkMode: boolean
  notificationsCount: number
  onNotificationsClick?: () => void
  onLogout?: () => void
  onSearchChange: (value: string) => void
  onToggleTheme: () => void
  searchQuery: string
  sections: AdminSidebarSection[]
  title: string
  userName?: string | null
}) {
  const [isCompact, setIsCompact] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth < 980 : false
  ))
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const handleResize = () => setIsCompact(window.innerWidth < 980)
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  function openSection(section: AdminSidebarSection) {
    if (section.href) {
      window.location.assign(section.href)
      return
    }
    const { id } = section
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setMenuOpen(false)
  }

  return (
    <div
      style={{
        ...themeVars,
        display: 'flex',
        flexDirection: isCompact ? 'column' : 'row',
        minHeight: '100vh',
        background: 'var(--admin-bg)',
        color: 'var(--admin-text)',
      }}
    >
      <aside
        style={{
          width: isCompact ? '100%' : 92,
          minHeight: isCompact ? 'auto' : '100vh',
          background: 'var(--admin-sidebar-bg)',
          borderRight: isCompact ? 'none' : '1px solid var(--admin-sidebar-border)',
          borderBottom: isCompact ? '1px solid var(--admin-sidebar-border)' : 'none',
          position: isCompact ? 'relative' : 'fixed',
          top: isCompact ? 'auto' : 0,
          left: isCompact ? 'auto' : 0,
          zIndex: 40,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          padding: isCompact ? '14px 10px' : '10px 8px 12px',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: isCompact ? 'flex-start' : 'center', padding: isCompact ? '2px 4px 10px' : '8px 4px 14px' }}>
          {isCompact ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <HIDLogo size="xs" theme="white" />
              <div style={{ color: '#fff', fontSize: 12, fontWeight: 700 }}>Admin</div>
            </div>
          ) : (
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 12,
                background: 'rgba(255,255,255,0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <img src="/hid-logo.png" alt="HID" style={{ width: 22, height: 22, display: 'block' }} />
            </div>
          )}
        </div>

        {(!isCompact || menuOpen) && (
          <>
        <nav
          style={{
            display: 'grid',
            gridTemplateColumns: isCompact ? 'repeat(auto-fit, minmax(110px, 1fr))' : '1fr',
            gap: 6,
            flex: 1,
          }}
        >
          {sections.map(section => {
            const active = activeSection === section.id
            return (
              <button
                key={section.id}
                onClick={() => openSection(section)}
                style={{
                  border: 'none',
                  borderRadius: 12,
                  background: active ? 'rgba(26, 111, 212, 0.18)' : 'transparent',
                  color: active ? 'var(--admin-sidebar-text-active)' : 'var(--admin-sidebar-text)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: isCompact ? 'row' : 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: isCompact ? 8 : 6,
                  padding: isCompact ? '10px 12px' : '10px 6px',
                  minHeight: isCompact ? 42 : 52,
                  fontSize: 10.5,
                  fontWeight: active ? 700 : 600,
                  textAlign: 'center',
                }}
              >
                {sidebarIcon(section.id, active)}
                <span>{section.label}</span>
              </button>
            )
          })}
        </nav>

        {onLogout && (
          <button
            onClick={onLogout}
            style={{
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 12,
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--admin-sidebar-text)',
              cursor: 'pointer',
              padding: isCompact ? '10px 12px' : '10px 6px',
              fontSize: 10.5,
              fontWeight: 700,
            }}
          >
            Sign out
          </button>
        )}
          </>
        )}
      </aside>

      <main style={{ flex: 1, marginLeft: isCompact ? 0 : 92, minHeight: '100vh' }}>
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 30,
            background: 'rgba(245, 247, 251, 0.92)',
            backdropFilter: 'blur(10px)',
            borderBottom: '1px solid var(--admin-border)',
          }}
        >
          <div
            style={{
              padding: isCompact ? '14px 16px' : '14px 18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 14,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 280px' }}>
              {isCompact && (
                <button
                  type="button"
                  aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen(open => !open)}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    border: '1px solid var(--admin-border)',
                    background: '#fff',
                    color: '#8a94a6',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    {menuOpen ? (
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    ) : (
                      <path d="M3 4.5h10M3 8h10M3 11.5h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    )}
                  </svg>
                </button>
              )}
              <div className="hid-admin-search" style={{ position: 'relative', minWidth: 220, flex: '1 1 320px', maxWidth: 360 }}>
                <input
                  value={searchQuery}
                  onChange={event => onSearchChange(event.target.value)}
                  placeholder="Search..."
                  style={{
                    width: '100%',
                    height: 34,
                    borderRadius: 10,
                    border: '1px solid var(--admin-border)',
                    background: '#fff',
                    color: 'var(--admin-text)',
                    padding: '0 12px 0 34px',
                    fontSize: 12,
                    outline: 'none',
                  }}
                />
                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9aa5b5' }}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <circle cx="7" cy="7" r="4.7" stroke="currentColor" strokeWidth="1.4" />
                    <path d="M10.5 10.5 13.2 13.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={onNotificationsClick}
                style={{
                  position: 'relative',
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  border: '1px solid var(--admin-border)',
                  background: '#fff',
                  color: '#8a94a6',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 18 18" fill="none">
                  <path d="M9 2.5a3.5 3.5 0 0 1 3.5 3.5v1.4c0 .6.2 1.2.5 1.7l1 1.5c.5.8-.1 1.9-1.1 1.9H5.1c-1 0-1.6-1.1-1.1-1.9l1-1.5c.3-.5.5-1.1.5-1.7V6A3.5 3.5 0 0 1 9 2.5Z" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M7.3 14.5a1.9 1.9 0 0 0 3.4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                {notificationsCount > 0 && (
                  <span
                    style={{
                      position: 'absolute',
                      top: -3,
                      right: -3,
                      minWidth: 16,
                      height: 16,
                      borderRadius: 999,
                      background: 'var(--admin-danger)',
                      color: '#fff',
                      fontSize: 9,
                      fontWeight: 800,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 4px',
                    }}
                  >
                    {notificationsCount}
                  </span>
                )}
              </button>

              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  background: 'rgba(26, 111, 212, 0.12)',
                  color: 'var(--admin-accent)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 800,
                }}
                title={userName ?? 'Admin'}
              >
                {(userName ?? 'AD').slice(0, 2).toUpperCase()}
              </div>
            </div>
          </div>
        </div>

        <div style={{ padding: isCompact ? 16 : 18 }}>
          <div style={{ marginBottom: 14 }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.04em', marginBottom: 3 }}>{title}</h1>
            <div style={{ fontSize: 12, color: 'var(--admin-muted)' }}>HID System Overview</div>
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}
