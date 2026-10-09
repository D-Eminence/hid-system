import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import App from './App'
import { useConnectivity } from '@hid/offline'
import { ApplicationErrorBoundary } from '@hid/telemetry'
import { OfflineBanner } from '@hid/ui/Offline'
import { scheduleNonCriticalStartup, warmCriticalConnections } from './lib/performance'
import './index.css'

warmCriticalConnections()

function Root() {
  const { offline } = useConnectivity()
  return <ApplicationErrorBoundary app="web"><OfflineBanner offline={offline} /><App /></ApplicationErrorBoundary>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>)

scheduleNonCriticalStartup()
