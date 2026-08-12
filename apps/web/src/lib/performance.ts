import { initObservability } from './observabilityBridge'

function addHeadLink(rel: 'dns-prefetch' | 'preconnect', href: string, crossOrigin = false) {
  if (typeof document === 'undefined' || !href) return

  const existing = document.head.querySelector(`link[rel="${rel}"][href="${href}"]`)
  if (existing) return

  const link = document.createElement('link')
  link.rel = rel
  link.href = href
  if (crossOrigin && rel === 'preconnect') {
    link.crossOrigin = 'anonymous'
  }
  document.head.appendChild(link)
}

function safeOrigin(raw: string | undefined) {
  if (!raw) return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

function runWhenIdle(task: () => void, timeoutMs = 1500) {
  if (typeof window === 'undefined') return () => undefined

  const idleWindow = window as Window & {
    requestIdleCallback?: (task: () => void, options?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }

  if (typeof idleWindow.requestIdleCallback === 'function') {
    const idleId = idleWindow.requestIdleCallback(task, { timeout: timeoutMs })
    return () => idleWindow.cancelIdleCallback?.(idleId)
  }

  const timer = globalThis.setTimeout(task, Math.min(timeoutMs, 250))
  return () => globalThis.clearTimeout(timer)
}

export function warmCriticalConnections() {
  if (typeof window === 'undefined') return

  const identityApiOrigin = safeOrigin(
    (import.meta.env.VITE_HID_IDENTITY_API_URL ?? import.meta.env.VITE_HID_API_URL) as string | undefined,
  )
  if (identityApiOrigin) {
    addHeadLink('dns-prefetch', identityApiOrigin)
    addHeadLink('preconnect', identityApiOrigin, true)
  }
}

function warmObservabilityConnections() {
  if (typeof window === 'undefined') return

  const origins = [
    safeOrigin(import.meta.env.VITE_POSTHOG_HOST as string | undefined),
    safeOrigin(import.meta.env.VITE_SENTRY_DSN as string | undefined),
  ]

  origins.forEach(origin => {
    if (!origin) return
    addHeadLink('dns-prefetch', origin)
    addHeadLink('preconnect', origin, true)
  })
}

export function scheduleNonCriticalStartup() {
  if (typeof window === 'undefined') return

  const start = () => {
    runWhenIdle(() => {
      warmObservabilityConnections()
      initObservability()
      void import('./pwa').then(module => module.registerAppServiceWorker())
    })
  }

  if (document.readyState === 'complete') {
    start()
    return
  }

  window.addEventListener('load', start, { once: true })
}
