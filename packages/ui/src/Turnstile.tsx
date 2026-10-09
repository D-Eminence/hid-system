import { useEffect, useRef, useState } from 'react'

declare global {
  interface Window {
    turnstile?: {
      render(container: HTMLElement, options: Record<string, unknown>): string
      remove(widgetId: string): void
      reset(widgetId?: string): void
    }
  }
}

const SCRIPT_ID = 'hid-shared-turnstile-script'
let loader: Promise<void> | null = null

function siteKey(): string {
  const environment = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
  return environment?.VITE_TURNSTILE_SITE_KEY?.trim() ?? ''
}

function load(): Promise<void> {
  if (loader) return loader
  loader = new Promise((resolve, reject) => {
    if (window.turnstile) return resolve()
    const present = document.getElementById(SCRIPT_ID)
    if (present) {
      present.addEventListener('load', () => resolve(), { once: true })
      present.addEventListener('error', () => reject(new Error('Turnstile unavailable')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => { loader = null; reject(new Error('Turnstile unavailable')) }
    document.head.appendChild(script)
  })
  return loader
}

export function Turnstile({ action, onTokenChange }: {
  action: string
  onTokenChange(token: string | null): void
}) {
  const container = useRef<HTMLDivElement | null>(null)
  const widget = useRef<string | null>(null)
  const [error, setError] = useState('')
  const key = siteKey()

  useEffect(() => {
    if (!key || !container.current) return
    let active = true
    void load().then(() => {
      if (!active || !container.current || !window.turnstile) return
      widget.current = window.turnstile.render(container.current, {
        sitekey: key,
        action,
        appearance: 'always',
        size: 'flexible',
        retry: 'never',
        'refresh-expired': 'manual',
        'refresh-timeout': 'manual',
        callback: (token: string) => { setError(''); onTokenChange(token) },
        'expired-callback': () => onTokenChange(null),
        'timeout-callback': () => { onTokenChange(null); setError('The security check timed out. Try again.') },
        'error-callback': () => { onTokenChange(null); setError('The security check could not be completed.') },
      })
    }).catch(() => setError('The security check could not be loaded.'))
    return () => {
      active = false
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current)
      widget.current = null
      onTokenChange(null)
    }
  }, [action, key, onTokenChange])

  if (!key) return null
  return <div style={{ display: 'grid', gap: 8 }}>
    <div ref={container} data-testid="turnstile-widget" />
    {error && <p role="alert" style={{ color: 'var(--color-error, #b42318)', margin: 0 }}>{error}</p>}
  </div>
}

export function isTurnstileClientConfigured(): boolean {
  return Boolean(siteKey())
}
