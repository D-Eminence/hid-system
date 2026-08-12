import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import { registerScopedServiceWorker, useConnectivity } from '@hid/offline'
import { ApplicationErrorBoundary, initializeTelemetry } from '@hid/telemetry'
import { OfflineBanner } from '@hid/ui/Offline'
import App from './App'
import './index.css'

initializeTelemetry({
  app: 'ocr', environment: import.meta.env.MODE,
  release: import.meta.env.VITE_HID_RELEASE,
  sentryDsn: import.meta.env.VITE_SENTRY_DSN,
  sentryTracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0),
  posthogKey: import.meta.env.VITE_POSTHOG_KEY,
  posthogHost: import.meta.env.VITE_POSTHOG_HOST,
  enabled: import.meta.env.VITE_TELEMETRY_ENABLED !== 'false',
})

function Root() {
  const { offline } = useConnectivity()
  return <ApplicationErrorBoundary app="ocr"><OfflineBanner offline={offline} /><App /></ApplicationErrorBoundary>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>)
void registerScopedServiceWorker({ scriptUrl: `${import.meta.env.BASE_URL}service-worker.js`, scope: import.meta.env.BASE_URL, enabled: import.meta.env.PROD })
