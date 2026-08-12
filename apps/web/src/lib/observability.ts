import {
  SAFE_PRODUCT_EVENTS,
  captureProductEvent,
  captureSafeException,
  initializeTelemetry,
  type SafeProductEvent,
} from '@hid/telemetry'

let initialized = false
const safeEvents = new Set<string>(SAFE_PRODUCT_EVENTS)

function parseSampleRate(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0
}

export async function initObservability(): Promise<void> {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  initializeTelemetry({
    app: 'web',
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_HID_RELEASE as string | undefined,
    sentryDsn: import.meta.env.VITE_SENTRY_DSN as string | undefined,
    sentryTracesSampleRate: parseSampleRate(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE as string | undefined),
    posthogKey: import.meta.env.VITE_POSTHOG_KEY as string | undefined,
    posthogHost: import.meta.env.VITE_POSTHOG_HOST as string | undefined,
    enabled: import.meta.env.VITE_TELEMETRY_ENABLED !== 'false',
  })
}

// Route paths and authenticated identifiers can contain patient or staff context.
// The shared telemetry layer deliberately does not receive either value.
export function updateObservabilityForRoute(_pathname: string): void {}

export function identifyObservabilityUser(_params: {
  appRole: string
  id: string
  staffRole?: string | null
}): void {}

export function clearObservabilityIdentity(): void {}

export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  if (!safeEvents.has(event)) return
  captureProductEvent(event as SafeProductEvent, properties)
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  captureSafeException(error, context)
}
