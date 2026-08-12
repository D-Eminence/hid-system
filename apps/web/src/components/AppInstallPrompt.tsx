import React, { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { HIDLogo } from './HIDLogo'
import { Button } from './ui'

type DeferredInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const DISMISS_KEY = 'hid:install-prompt-dismissed-at'
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000

function canShowInstallPrompt() {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.('(display-mode: standalone)').matches) return false
  if ((window.navigator as Navigator & { standalone?: boolean }).standalone) return false
  const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) ?? '0')
  return !dismissedAt || Date.now() - dismissedAt > DISMISS_TTL_MS
}

function isIosDevice() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || navigator.vendor || ''
  return /iPad|iPhone|iPod/.test(ua)
}

function isSafariBrowser() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(ua)
}

function isStaleInstallPromptError(error: unknown) {
  if (!error) return false

  // Browser install-prompt errors can carry circular Event objects. Reading the
  // small public fields avoids recursively serializing browser internals.
  const text = error instanceof Error
    ? `${error.name} ${error.message}`.toLowerCase()
    : typeof error === 'object'
      ? [
          'name' in error && typeof error.name === 'string' ? error.name : '',
          'message' in error && typeof error.message === 'string' ? error.message : '',
          'code' in error && typeof error.code === 'string' ? error.code : '',
        ].join(' ').toLowerCase()
      : String(error).toLowerCase()

  return (
    text.includes('object not found matching id') &&
    text.includes('methodname:update')
  )
}

export function AppInstallPrompt() {
  const location = useLocation()
  const [deferredPrompt, setDeferredPrompt] = useState<DeferredInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)
  const [iosPrompt, setIosPrompt] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !canShowInstallPrompt()) return undefined

    if (isIosDevice()) {
      setIosPrompt(true)
      setVisible(true)
      return undefined
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setDeferredPrompt(event as DeferredInstallPromptEvent)
      setVisible(true)
    }

    const handleInstalled = () => {
      setVisible(false)
      setDeferredPrompt(null)
      localStorage.removeItem(DISMISS_KEY)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  const description = useMemo(() => (
    iosPrompt
      ? isSafariBrowser()
        ? 'Install HID on your iPhone or iPad by tapping Share, then Add to Home Screen.'
        : 'To install HID on iPhone or iPad, open this page in Safari, tap Share, then Add to Home Screen.'
      : 'Install HID on this device for faster access from your home screen and a more app-like experience.'
  ), [iosPrompt])

  async function install() {
    if (!deferredPrompt) return
    try {
      await deferredPrompt.prompt()
      const choice = await deferredPrompt.userChoice
      if (choice.outcome === 'accepted') {
        setVisible(false)
        setDeferredPrompt(null)
        localStorage.removeItem(DISMISS_KEY)
        return
      }
      dismiss()
    } catch (error) {
      setDeferredPrompt(null)
      setVisible(false)
      if (!isStaleInstallPromptError(error)) {
        dismiss()
      }
    }
  }

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, `${Date.now()}`)
    setVisible(false)
    setIosPrompt(false)
  }

  if (location.pathname.startsWith('/migrate') || !visible || (!deferredPrompt && !iosPrompt)) return null

  return (
    <div
      style={{
        position: 'fixed',
        right: 18,
        bottom: 18,
        zIndex: 120,
        width: 'min(360px, calc(100vw - 24px))',
        background: '#ffffff',
        border: '1px solid #dbe8f8',
        borderRadius: 18,
        boxShadow: '0 18px 44px rgba(15, 23, 42, 0.16)',
        padding: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ paddingTop: 2 }}>
          <HIDLogo size="xs" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Install HID</div>
          <div style={{ fontSize: 12.5, color: '#6b7280', lineHeight: 1.6, marginTop: 4 }}>{description}</div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <Button size="sm" variant="outline" onClick={dismiss}>Not now</Button>
        {!iosPrompt && <Button size="sm" onClick={() => void install()}>Add to device</Button>}
      </div>
    </div>
  )
}
