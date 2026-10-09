import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { HIDLogo } from './HIDLogo'
import { PatientNotificationWatcher } from './PatientNotificationWatcher'
import { ShareProfileModal } from './ShareProfileModal'
import { Button } from './ui'
import { countUnreadNotifications } from '../lib/hidApi'
import { getPersonInitials } from '../lib/utils'
import { preloadPath } from '../lib/routePreload'
import { subscribeToNotifications } from '../lib/notificationsRealtime'
import { prefetchPatientRouteData } from '../lib/experienceWarmup'

interface NavItem {
  path: string
  label: string
}

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

function BellBadge({ hasUnread, onClick }: { hasUnread: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick} style={{ position: 'relative', width: 42, height: 42, borderRadius: 999, border: '1px solid #eef1f5', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', cursor: onClick ? 'pointer' : 'default' }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M12 4a4 4 0 0 0-4 4v2.1c0 .7-.2 1.4-.6 2L6 14.5h12l-1.4-2.4c-.4-.6-.6-1.3-.6-2V8a4 4 0 0 0-4-4Z" stroke="#111827" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10 18a2 2 0 0 0 4 0" stroke="#111827" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {hasUnread && <span style={{ position: 'absolute', top: 8, right: 9, width: 8, height: 8, borderRadius: '50%', background: '#9b1128', boxShadow: '0 0 0 2px #fff' }} />}
    </button>
  )
}

function ProfilePill({
  initials,
  photoUrl,
  open,
  onClick,
}: {
  initials: string
  photoUrl?: string | null
  open: boolean
  onClick: () => void
}) {
  return (
    <button onClick={onClick} style={{ height: 42, padding: '0 12px', borderRadius: 999, border: '1px solid #eef1f5', display: 'inline-flex', alignItems: 'center', gap: 10, background: '#fff', cursor: 'pointer' }}>
      {photoUrl ? (
        <img src={photoUrl} alt="Profile" style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover' }} />
      ) : (
        <span style={{ width: 24, height: 24, borderRadius: '50%', background: '#f0f7ff', color: '#1f8cff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>
          {initials}
        </span>
      )}
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d={open ? 'M2 6.5 5 3.5 8 6.5' : 'M2 3.5 5 6.5 8 3.5'} stroke="#9aa6b2" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

function HomeIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 11.5 12 4l8 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 10.5V19a1 1 0 0 0 1 1h3v-5h4v5h3a1 1 0 0 0 1-1v-8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RecordsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7a2 2 0 0 1 2-2h3.5l2 2H18a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function HistoryIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 8v4l2.5 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function NotificationsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4a4 4 0 0 0-4 4v2.1c0 .7-.2 1.4-.6 2L6 14.5h12l-1.4-2.4c-.4-.6-.6-1.3-.6-2V8a4 4 0 0 0-4-4Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 18a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function ShareIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 14V3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 7l4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function EditIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 6.5l3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function BioDataIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 19.5c0-3 3-5 7-5s7 2 7 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function getNavIcon(path: string) {
  if (path.includes('/notifications')) return <NotificationsIcon />
  if (path.includes('/records')) return <RecordsIcon />
  if (path.includes('/history')) return <HistoryIcon />
  if (path.includes('/biodata')) return <BioDataIcon />
  return <HomeIcon />
}

export function PortalShell({
  title,
  subtitle,
  items,
  onLogout,
  userName,
  avatarInitials,
  avatarUrl,
  notificationPath,
  notificationHidCode,
  onAvatarUpload,
  onShareSuccess,
  children,
}: {
  title: string
  subtitle?: string
  items: NavItem[]
  onLogout: () => void
  userName?: string
  avatarInitials?: string
  avatarUrl?: string | null
  notificationPath?: string
  notificationHidCode?: string
  onAvatarUpload?: (file: File) => void
  onShareSuccess?: () => void
  children: React.ReactNode
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const menuRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const initials = useMemo(() => {
    if (avatarInitials?.trim()) return avatarInitials.trim().slice(0, 2).toUpperCase()
    return getPersonInitials(userName?.trim() || title)
  }, [avatarInitials, title, userName])
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [hasUnreadNotifications, setHasUnreadNotifications] = useState(false)
  const [isCompact, setIsCompact] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 720 : false))
  const [navOpen, setNavOpen] = useState(false)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const activeLabel = items.find(item => item.path === location.pathname)?.label ?? 'Menu'
  const likelyWarmPaths = useMemo(() => {
    const currentIndex = items.findIndex(item => item.path === location.pathname)
    const paths: string[] = []

    if (currentIndex >= 0) {
      const nextItem = items[currentIndex + 1]
      const previousItem = items[currentIndex - 1]
      if (nextItem?.path && nextItem.path !== location.pathname) paths.push(nextItem.path)
      if (previousItem?.path && previousItem.path !== location.pathname) paths.push(previousItem.path)
    } else if (items[0]?.path) {
      paths.push(items[0].path)
    }

    if (notificationPath && notificationPath !== location.pathname) {
      paths.push(notificationPath)
    }

    return Array.from(new Set(paths)).slice(0, 2)
  }, [items, location.pathname, notificationPath])

  function warmPath(path: string) {
    preloadPath(path)
    if (notificationHidCode) {
      prefetchPatientRouteData(path, notificationHidCode)
    }
  }

  useEffect(() => {
    if (!notificationPath) return
    let active = true

    async function loadUnread() {
      try {
        const count = await countUnreadNotifications({ forceRefresh: true })
        if (!active) return
        setHasUnreadNotifications(count > 0)
      } catch {
        if (!active) return
        setHasUnreadNotifications(false)
      }
    }

    void loadUnread()
    const unsubscribe = subscribeToNotifications(() => {
      void loadUnread()
    })
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void loadUnread()
      }
    }
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadUnread()
      }
    }, 45000)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      active = false
      unsubscribe()
      document.removeEventListener('visibilitychange', handleVisibility)
      window.clearInterval(interval)
    }
  }, [notificationPath])

  useEffect(() => {
    if (likelyWarmPaths.length === 0) return () => undefined
    return scheduleWarmup(() => {
      likelyWarmPaths.forEach(path => warmPath(path))
    })
  }, [likelyWarmPaths, notificationHidCode])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setProfileMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    const handleResize = () => setIsCompact(window.innerWidth < 720)
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

  return (
    <div style={{ minHeight: '100vh', background: '#fff' }}>
      <div className="hid-portal-shell" style={{ maxWidth: 1360, margin: '0 auto', padding: 'clamp(20px, 5vw, 36px) clamp(14px, 3vw, 46px)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => warmPath(items[0]?.path ?? '/')}
            onClick={() => navigate(items[0]?.path ?? '/')}
          >
            <HIDLogo size="sm" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
            <div onMouseEnter={() => { if (notificationPath) warmPath(notificationPath) }}>
              <BellBadge hasUnread={hasUnreadNotifications} onClick={notificationPath ? () => navigate(notificationPath) : undefined} />
            </div>
            <div style={{ position: 'relative' }} ref={menuRef}>
              <ProfilePill initials={initials} photoUrl={avatarUrl} open={profileMenuOpen} onClick={() => setProfileMenuOpen(value => !value)} />
              {profileMenuOpen && (
                <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 190, borderRadius: 16, background: '#fff', border: '1px solid #eef1f5', boxShadow: '0 18px 34px rgba(15, 23, 42, 0.12)', padding: 8, zIndex: 20 }}>
                  {onAvatarUpload && (
                    <>
                      <button onClick={() => fileInputRef.current?.click()} style={{ width: '100%', border: 'none', background: '#fff', textAlign: 'left', borderRadius: 12, padding: '10px 12px', color: '#111827', cursor: 'pointer' }}>
                        Upload profile photo
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".img,.png,.jpg,.jpeg,image/png,image/jpeg"
                        style={{ display: 'none' }}
                        onChange={event => {
                          const file = event.target.files?.[0]
                          if (file) onAvatarUpload(file)
                          event.currentTarget.value = ''
                          setProfileMenuOpen(false)
                        }}
                      />
                    </>
                  )}
                  <button onClick={onLogout} style={{ width: '100%', border: 'none', background: '#fff5f5', textAlign: 'left', borderRadius: 12, padding: '10px 12px', color: '#b91c1c', cursor: 'pointer', fontWeight: 600 }}>
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginTop: 'clamp(20px, 5vw, 32px)', paddingBottom: 14, borderBottom: '1px solid #edf1f5', flexWrap: 'wrap' }}>
          {isCompact ? (
            <div style={{ position: 'relative', width: '100%' }}>
              <button
                type="button"
                aria-label={navOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={navOpen}
                onClick={() => setNavOpen(open => !open)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: '1px solid #eef1f5', background: '#fff', borderRadius: 12, padding: '10px 14px', cursor: 'pointer', color: '#111827', fontSize: 13, fontWeight: 600 }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                  {activeLabel}
                </span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ transform: navOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}><path d="M2 4l4 4 4-4" stroke="#9aa6b2" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              {navOpen && (
                <div style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, right: 0, background: '#fff', border: '1px solid #eef1f5', borderRadius: 14, boxShadow: '0 18px 34px rgba(15, 23, 42, 0.12)', padding: 8, zIndex: 25, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {items.map(item => {
                    const active = location.pathname === item.path
                    return (
                      <button
                        key={item.path}
                        onClick={() => { navigate(item.path); setNavOpen(false) }}
                        onMouseEnter={() => warmPath(item.path)}
                        onFocus={() => warmPath(item.path)}
                        style={{ width: '100%', textAlign: 'left', border: 'none', borderRadius: 10, padding: '11px 12px', background: active ? '#f0f7ff' : '#fff', color: active ? '#1a6fd4' : '#111827', fontSize: 13, fontWeight: active ? 600 : 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
                      >
                        {getNavIcon(item.path)}
                        {item.label}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          ) : (
            <nav style={{ display: 'flex', alignItems: 'center', gap: 28, flexWrap: 'wrap' }}>
              {items.map(item => {
                const active = location.pathname === item.path
                return (
                  <button
                    key={item.path}
                    onClick={() => navigate(item.path)}
                    onMouseEnter={() => warmPath(item.path)}
                    onFocus={() => warmPath(item.path)}
                    style={{
                      border: 'none',
                      background: 'none',
                      color: active ? '#111827' : '#9aa6b2',
                      fontSize: 12,
                      fontWeight: active ? 600 : 500,
                      padding: '6px 0',
                      borderBottom: active ? '2px solid #111827' : '2px solid transparent',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      cursor: 'pointer',
                    }}
                  >
                    {getNavIcon(item.path)}
                    {item.label}
                  </button>
                )
              })}
            </nav>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', width: isCompact ? '100%' : undefined, marginTop: isCompact ? 12 : 0 }}>
            <Button
              size="sm"
              icon={<ShareIcon />}
              onClick={() => setShareModalOpen(true)}
              style={{ borderRadius: 999 }}
            >
              Share Records
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon={<EditIcon />}
              onClick={() => navigate('/patient/biodata')}
              onMouseEnter={() => warmPath('/patient/biodata')}
              style={{ borderRadius: 999, borderColor: '#e5e7eb', color: '#374151' }}
            >
              Biodata
            </Button>
          </div>
        </div>

        <div style={{ marginTop: 'clamp(18px, 4vw, 28px)' }}>
          {notificationHidCode ? <PatientNotificationWatcher hidCode={notificationHidCode} /> : null}
          {(title || subtitle) && (
            <div style={{ marginBottom: 'clamp(14px, 4vw, 20px)' }}>
              <div style={{ fontSize: 'clamp(18px, 4.5vw, 26px)', fontWeight: 700, color: '#111827', letterSpacing: '-0.03em' }}>{title}</div>
              {subtitle && <div style={{ marginTop: 6, color: '#8a95a6', fontSize: 13 }}>{subtitle}</div>}
            </div>
          )}
          {children}
        </div>
      </div>

      <ShareProfileModal
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        onShared={() => onShareSuccess?.()}
      />
    </div>
  )
}
