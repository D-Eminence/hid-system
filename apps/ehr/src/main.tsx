import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/styles/tokens.css';
import '@/styles/ehr-theme.css';
import { App } from './ehr-app';
import { registerScopedServiceWorker, useConnectivity } from '@hid/offline';
import { ApplicationErrorBoundary, initializeTelemetry } from '@hid/telemetry';
import { OfflineBanner } from '@hid/ui/Offline';
import { registerReleaseBoundServiceWorker } from './release-service-worker';

initializeTelemetry({
  app: 'ehr', environment: import.meta.env.MODE, release: import.meta.env.VITE_HID_RELEASE,
  sentryDsn: import.meta.env.VITE_SENTRY_DSN,
  sentryTracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0),
  posthogKey: import.meta.env.VITE_POSTHOG_KEY, posthogHost: import.meta.env.VITE_POSTHOG_HOST,
  enabled: import.meta.env.VITE_TELEMETRY_ENABLED !== 'false',
});

function Root() {
  const { offline } = useConnectivity();
  return <ApplicationErrorBoundary app="ehr"><OfflineBanner offline={offline} /><App /></ApplicationErrorBoundary>;
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);

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
});
