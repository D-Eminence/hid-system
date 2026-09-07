import { registerScopedServiceWorker } from '@hid/offline'
import { captureProductEvent, captureSafeException, initializeTelemetry } from '@hid/telemetry'
import { OFFLINE_MESSAGE } from '@hid/ui/Offline'
import { registerReleaseBoundServiceWorker } from './release-service-worker'

initializeTelemetry({
  app: 'ehr',
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_HID_RELEASE,
  sentryDsn: import.meta.env.VITE_SENTRY_DSN,
  sentryTracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0),
  posthogKey: import.meta.env.VITE_POSTHOG_KEY,
  posthogHost: import.meta.env.VITE_POSTHOG_HOST,
  enabled: import.meta.env.VITE_TELEMETRY_ENABLED !== 'false',
})

captureProductEvent('workspace_opened', { workspace: 'ehr', offline: !navigator.onLine })

window.addEventListener('error', event => {
  captureSafeException(event.error instanceof Error ? event.error : new Error('EHR browser runtime error'), {
    app: 'ehr',
    operation: 'window_error',
  })
})
window.addEventListener('unhandledrejection', () => {
  captureSafeException(new Error('EHR unhandled promise rejection'), { app: 'ehr', operation: 'unhandled_rejection' })
})

const BANNER_ID = 'hid-ehr-connectivity'
function renderConnectivity(): void {
  const existing = document.getElementById(BANNER_ID)
  if (navigator.onLine) {
    existing?.remove()
    return
  }
  if (existing || !document.body) return
  const banner = document.createElement('div')
  banner.id = BANNER_ID
  banner.setAttribute('role', 'status')
  banner.setAttribute('aria-live', 'polite')
  banner.textContent = OFFLINE_MESSAGE
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:100000;padding:8px 16px;text-align:center;font:600 13px/1.4 system-ui,sans-serif;background:#fff2d8;color:#7a4d00'
  document.body.prepend(banner)
}

window.addEventListener('online', renderConnectivity)
window.addEventListener('offline', renderConnectivity)
new MutationObserver(renderConnectivity).observe(document, { childList: true, subtree: true })
renderConnectivity()

function registerWorker(): void {
  void registerReleaseBoundServiceWorker({
    scriptUrl: `${import.meta.env.BASE_URL}service-worker.js?release=${__HID_EHR_RELEASE_SHA__}`,
    scope: import.meta.env.BASE_URL,
    releaseSha: __HID_EHR_RELEASE_SHA__,
    enabled: import.meta.env.PROD,
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? navigator.serviceWorker
      : undefined,
    reload: () => window.location.reload(),
    register: registerScopedServiceWorker,
  })
}
if (document.readyState === 'complete') registerWorker()
else window.addEventListener('load', registerWorker, { once: true })
