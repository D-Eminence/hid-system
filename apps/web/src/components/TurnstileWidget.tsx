import React, { useEffect, useRef, useState } from 'react'
import { getTurnstileSiteKey } from '../lib/captcha'

declare global {
  interface Window {
    turnstile?: {
      remove: (widgetId: string) => void
      render: (container: HTMLElement, options: Record<string, unknown>) => string
      reset: (widgetId?: string) => void
    }
  }
}

const TURNSTILE_SCRIPT_ID = 'hid-turnstile-script'
let turnstileScriptPromise: Promise<void> | null = null

function loadTurnstileScript() {
  if (turnstileScriptPromise) return turnstileScriptPromise

  turnstileScriptPromise = new Promise((resolve, reject) => {
    if (window.turnstile) {
      resolve()
      return
    }

    const existing = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => {
        turnstileScriptPromise = null
        reject(new Error('Turnstile failed to load.'))
      }, { once: true })
      return
    }

    const script = document.createElement('script')
    script.id = TURNSTILE_SCRIPT_ID
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => {
      turnstileScriptPromise = null
      reject(new Error('Turnstile failed to load.'))
    }
    document.head.appendChild(script)
  })

  return turnstileScriptPromise
}

type TurnstileWidgetProps = {
  action: string
  message?: string | null
  messageTone?: 'error' | 'info'
  onTokenChange: (token: string | null) => void
  preload?: boolean
  resetKey?: string | number
  visible?: boolean
}

function noticeStyles(tone: 'error' | 'info') {
  return tone === 'error'
    ? {
        background: '#fef2f2',
        border: '#fecaca',
        color: '#b91c1c',
      }
    : {
        background: '#eff6ff',
        border: '#bfdbfe',
        color: '#1d4ed8',
      }
}

export function TurnstileWidget({
  action,
  message,
  messageTone = 'info',
  onTokenChange,
  preload = false,
  resetKey,
  visible = true,
}: TurnstileWidgetProps) {
  const siteKey = getTurnstileSiteKey() || undefined
  const containerRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<string | null>(null)
  const [error, setError] = useState('')
  const shouldLoad = visible || preload

  useEffect(() => {
    if (!siteKey || !shouldLoad) return

    let active = true
    void loadTurnstileScript()
      .then(() => {
        if (!active) return
        setError('')
      })
      .catch(() => {
        if (!active) return
        setError('Security check failed to load. Refresh and try again.')
      })

    return () => {
      active = false
    }
  }, [shouldLoad, siteKey])

  useEffect(() => {
    if (!siteKey || !containerRef.current || !visible) return

    let active = true
    setError('')
    void loadTurnstileScript()
      .then(() => {
        if (!active || !containerRef.current || !window.turnstile) return
        if (widgetIdRef.current) {
          window.turnstile.remove(widgetIdRef.current)
          widgetIdRef.current = null
        }

        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          action,
          appearance: 'always',
          callback: (token: string) => {
            onTokenChange(token)
            setError('')
          },
          'error-callback': () => {
            onTokenChange(null)
            setError('We could not complete the security check. Check your connection and verify again.')
          },
          'expired-callback': () => {
            onTokenChange(null)
            setError('')
          },
          'refresh-expired': 'manual',
          'refresh-timeout': 'manual',
          retry: 'never',
          size: 'flexible',
          sitekey: siteKey,
          theme: 'light',
          'timeout-callback': () => {
            onTokenChange(null)
            setError('The security check timed out. Verify again to continue.')
          },
        })
      })
      .catch(() => {
        if (!active) return
        onTokenChange(null)
        setError('Security check failed to load. Refresh and try again.')
      })

    return () => {
      active = false
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
        widgetIdRef.current = null
      }
    }
  }, [action, onTokenChange, resetKey, siteKey, visible])

  if (!siteKey || (!visible && !preload)) return null

  if (!visible) return null

  const notice = error
    ? { message: error, tone: 'error' as const }
    : message
      ? { message, tone: messageTone }
      : null
  const styles = notice ? noticeStyles(notice.tone) : null

  return (
    <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
      {notice && styles ? (
        <div
          aria-live="polite"
          style={{
            background: styles.background,
            border: `1px solid ${styles.border}`,
            borderRadius: 12,
            color: styles.color,
            fontSize: 12,
            lineHeight: 1.5,
            padding: '10px 12px',
          }}
        >
          {notice.message}
        </div>
      ) : null}
      <div ref={containerRef} />
    </div>
  )
}
