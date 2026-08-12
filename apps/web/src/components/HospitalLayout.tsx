import React, { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { HIDLogo } from './HIDLogo'
import { StaffNotificationWatcher } from './StaffNotificationWatcher'
import { usePortalSession } from '../lib/auth'
import { prefetchHospitalRouteData } from '../lib/experienceWarmup'
import {
  HOSPITAL_ACCESS_PATH,
  HOSPITAL_DASHBOARD_PATH,
  HOSPITAL_EMERGENCY_PATH,
  HOSPITAL_HISTORY_PATH,
} from '../lib/hospitalRoutes'
import { preloadPath } from '../lib/routePreload'

type HospitalSection = 'dashboard' | 'access' | 'history' | 'emergency'

const hospitalNav = [
  {
    section: 'dashboard' as const,
    path: HOSPITAL_DASHBOARD_PATH,
    label: 'Dashboard',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M2 7l7-6 7 6v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7z" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M7 17v-5h4v5" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    section: 'access' as const,
    path: HOSPITAL_ACCESS_PATH,
    label: 'Patient Access',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="3" y="2" width="12" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M6 7h6M6 10h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M6 4h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    section: 'history' as const,
    path: HOSPITAL_HISTORY_PATH,
    label: 'Access Logs',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M9 1a8 8 0 1 0 0 16A8 8 0 0 0 9 1z" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M9 5v4l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    section: 'emergency' as const,
    path: HOSPITAL_EMERGENCY_PATH,
    label: 'Emergency',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path d="M9 2.2 15.4 14a1 1 0 0 1-.88 1.5H3.48A1 1 0 0 1 2.6 14L9 2.2Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M9 6.2v4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="9" cy="13.2" r=".9" fill="currentColor" />
      </svg>
    ),
  },
]

function scheduleWarmup(task: () => void, timeoutMs = 600) {
  if (typeof window === 'undefined') return () => undefined

  const idleWindow = window as Window & {
    cancelIdleCallback?: (id: number) => void
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  }

  if (typeof idleWindow.requestIdleCallback === 'function') {
    const idleId = idleWindow.requestIdleCallback(task, { timeout: timeoutMs })
    return () => idleWindow.cancelIdleCallback?.(idleId)
  }

  const timer = window.setTimeout(task, Math.min(timeoutMs, 250))
  return () => window.clearTimeout(timer)
}

export function HospitalLayout({
  activeSection,
  children,
  title,
  subtitle,
  onLogout,
  userName,
  organizationName,
  onAccessRevoked,
}: {
  activeSection: HospitalSection
  children: React.ReactNode
  title: string
  subtitle?: string
  onLogout?: () => void
  userName?: string | null
  organizationName?: string | null
  onAccessRevoked?: () => void
}) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [isCompact, setIsCompact] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 820 : false))
  const [menuOpen, setMenuOpen] = useState(false)
  const { staff: session } = usePortalSession()
  const likelyWarmPaths = React.useMemo(() => {
    const currentIndex = hospitalNav.findIndex(item => item.path === pathname || (item.section === 'access' && pathname.startsWith('/hospital/patient-records/')))
    const paths: string[] = []

    if (currentIndex >= 0) {
      const nextItem = hospitalNav[currentIndex + 1]
      const previousItem = hospitalNav[currentIndex - 1]
      if (nextItem?.path && nextItem.path !== pathname) paths.push(nextItem.path)
      if (previousItem?.path && previousItem.path !== pathname) paths.push(previousItem.path)
    } else if (hospitalNav[0]?.path) {
      paths.push(hospitalNav[0].path)
    }

    return Array.from(new Set(paths)).slice(0, 2)
  }, [pathname])

  function warmPath(path: string) {
    preloadPath(path)
    if (session) {
      prefetchHospitalRouteData(path, session)
    }
  }

  useEffect(() => {
    const handleResize = () => setIsCompact(window.innerWidth < 820)
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  useEffect(() => {
    if (likelyWarmPaths.length === 0) return () => undefined

    return scheduleWarmup(() => {
      likelyWarmPaths.forEach(path => warmPath(path))
    })
  }, [likelyWarmPaths, session])

  return (
    <div style={{ display: 'flex', flexDirection: isCompact ? 'column' : 'row', minHeight: '100vh' }}>
      <aside
        style={{
          width: isCompact ? '100%' : 228,
          minHeight: isCompact ? 'auto' : '100vh',
          background: '#fff',
          borderRight: isCompact ? 'none' : '1px solid #e5e7eb',
          borderBottom: isCompact ? '1px solid #e5e7eb' : 'none',
          display: 'flex',
          flexDirection: 'column',
          padding: isCompact ? '14px 12px' : '20px 12px',
          position: isCompact ? 'relative' : 'fixed',
          top: isCompact ? 'auto' : 0,
          left: isCompact ? 'auto' : 0,
          zIndex: 50,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: isCompact ? '4px 4px 10px' : '4px 8px 24px' }}>
          <div
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => warmPath(HOSPITAL_DASHBOARD_PATH)}
            onClick={() => navigate(HOSPITAL_DASHBOARD_PATH)}
          >
            <HIDLogo size="sm" />
          </div>
          {isCompact && (
            <button
              type="button"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(open => !open)}
              style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 10, width: 40, height: 40, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#111827', cursor: 'pointer' }}
            >
              {menuOpen ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              )}
            </button>
          )}
        </div>

        {(!isCompact || menuOpen) && (
        <nav
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            flex: isCompact ? 'none' : 1,
            alignContent: 'start',
          }}
        >
          {hospitalNav.map(item => {
            const active = activeSection === item.section || (item.section === 'access' && pathname.startsWith('/hospital/patient-records/'))
            return (
              <button
                key={item.path}
                onClick={() => { navigate(item.path); setMenuOpen(false) }}
                onMouseEnter={() => warmPath(item.path)}
                onFocus={() => warmPath(item.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: 'none',
                  background: active ? '#e8f1fc' : 'transparent',
                  color: active ? '#1a6fd4' : '#374151',
                  fontWeight: active ? 600 : 400,
                  fontSize: 14,
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  width: '100%',
                }}
              >
                <span style={{ opacity: active ? 1 : 0.6 }}>{item.icon}</span>
                {item.label}
              </button>
            )
          })}
        </nav>
        )}

        {(!isCompact || menuOpen) && (
        <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 16, marginTop: 10 }}>
          {userName && (
            <div style={{ fontSize: 11, color: '#6b7280', padding: '0 8px 10px', lineHeight: 1.6, overflowWrap: 'anywhere' }}>
              <strong style={{ color: '#374151' }}>{userName}</strong>
              {organizationName && organizationName !== userName && (
                <>
                  <br />
                  <span>{organizationName}</span>
                </>
              )}
            </div>
          )}
          {onLogout && (
            <button
              onClick={onLogout}
              style={{
                width: '100%',
                border: '1px solid #e5e7eb',
                background: '#fff5f5',
                color: '#b91c1c',
                borderRadius: 8,
                padding: '9px 12px',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Logout
            </button>
          )}
          <div style={{ fontSize: 11, color: '#9ca3af', padding: '12px 8px 0', lineHeight: 1.6 }}>
            <strong style={{ color: '#6b7280' }}>HID</strong>
            <br />
            Health Identity Directory
          </div>
        </div>
        )}
      </aside>

      <main style={{ marginLeft: isCompact ? 0 : 228, flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <div
          style={{
            minHeight: 64,
            background: '#fff',
            borderBottom: '1px solid #e5e7eb',
            display: 'flex',
            alignItems: 'center',
            padding: isCompact ? '14px 16px' : '0 32px',
            justifyContent: 'space-between',
            position: 'sticky',
            top: 0,
            zIndex: 40,
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.3px', overflowWrap: 'anywhere' }}>{title}</h1>
            {subtitle && <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 1, overflowWrap: 'anywhere' }}>{subtitle}</p>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <HIDLogo size="xs" />
          </div>
        </div>

        <div style={{ flex: 1, padding: isCompact ? 16 : 32, background: '#f3f4f6' }}>
          <StaffNotificationWatcher onAccessRevoked={onAccessRevoked} />
          {children}
        </div>
      </main>
    </div>
  )
}
