import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './index.css'
import App from './App'
import { registerOutreachServiceWorker } from './lib/pwa'
import { useConnectivity } from '@hid/offline'
import { ApplicationErrorBoundary, initializeTelemetry } from '@hid/telemetry'
import { OfflineBanner } from '@hid/ui/Offline'

initializeTelemetry({
  app: 'outreach', environment: import.meta.env.MODE, release: import.meta.env.VITE_HID_RELEASE,
  sentryDsn: import.meta.env.VITE_SENTRY_DSN,
  sentryTracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0),
  posthogKey: import.meta.env.VITE_POSTHOG_KEY, posthogHost: import.meta.env.VITE_POSTHOG_HOST,
  enabled: import.meta.env.VITE_TELEMETRY_ENABLED !== 'false',
})

function Root() {
  const { offline } = useConnectivity()
  return <ApplicationErrorBoundary app="outreach"><OfflineBanner offline={offline} /><App /></ApplicationErrorBoundary>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><Root /></React.StrictMode>,
)

void registerOutreachServiceWorker()
