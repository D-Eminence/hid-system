import * as Sentry from '@sentry/react'
import posthog from 'posthog-js'
import React from 'react'

export type HidFrontendApp = 'web' | 'ehr' | 'lab' | 'pharmacy' | 'ocr' | 'outreach' | 'admin'

export const SAFE_PRODUCT_EVENTS = [
  'workspace_opened',
  'profile_completion_started',
  'profile_completion_completed',
  'lab_workspace_opened',
  'pharmacy_prescription_opened',
  'pharmacy_prescription_accepted',
  'pharmacy_dispensing_confirmed',
  'pharmacy_reversal_confirmed',
  'ocr_job_opened',
  'ocr_job_created',
  'ocr_job_retry_requested',
  'ocr_validation_completed',
  'outreach_sync_completed',
  'admin_facility_review_opened',
  'admin_facility_approved',
] as const

export type SafeProductEvent = (typeof SAFE_PRODUCT_EVENTS)[number]

const SAFE_PROPERTY_KEYS = new Set([
  'app', 'workspace', 'operation', 'result', 'source', 'duration_bucket', 'retry_count_bucket',
  'offline', 'sync_state', 'status', 'error_code', 'correlation_id', 'route', 'version',
])
const SENSITIVE_KEY = /(authorization|cookie|token|csrf|otp|turnstile|nin|patient|phone|email|name|hid|clinical|diagnosis|result_value|laboratory|medication|prescription|ocr_text|raw_text|document|payload|body|url|presign|signature|secret|credential|private_key|api_key|access_key|novu|firebase|fcm|whatsapp|termii|infobip|ses_|pin)/i

function primitive(value: unknown): string | number | boolean | null | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null
    ? value
    : undefined
}

export function safeTelemetryProperties(input: Record<string, unknown> = {}): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_PROPERTY_KEYS.has(key) || SENSITIVE_KEY.test(key)) continue
    const safe = primitive(value)
    if (safe !== undefined) output[key] = typeof safe === 'string' ? safe.slice(0, 160) : safe
  }
  return output
}

export function redactSentryEvent<Event extends Sentry.Event>(event: Event): Event {
  if (event.request) {
    event.request = {
      method: event.request.method,
    }
  }
  delete event.user
  if (event.exception?.values) {
    event.exception.values = event.exception.values.map(value => ({
      ...value,
      value: value.type ? `${value.type} (details redacted)` : 'Error details redacted',
    }))
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .filter(breadcrumb => !['ui.input', 'console', 'xhr', 'fetch'].includes(breadcrumb.category ?? ''))
      .map(breadcrumb => ({ category: breadcrumb.category, level: breadcrumb.level, timestamp: breadcrumb.timestamp }))
  }
  event.extra = safeTelemetryProperties(event.extra ?? {})
  event.contexts = undefined
  return event
}

export interface TelemetryOptions {
  app: HidFrontendApp
  environment: string
  release?: string
  sentryDsn?: string
  sentryTracesSampleRate?: number
  posthogKey?: string
  posthogHost?: string
  enabled?: boolean
}

let activeApp: HidFrontendApp | null = null
let sentryEnabled = false
let posthogEnabled = false

export function initializeTelemetry(options: TelemetryOptions): void {
  if (options.enabled === false || activeApp || typeof window === 'undefined') return
  activeApp = options.app
  if (options.sentryDsn) {
    try {
      Sentry.init({
        dsn: options.sentryDsn,
        environment: options.environment,
        release: options.release,
        sendDefaultPii: false,
        tracesSampleRate: Math.min(1, Math.max(0, options.sentryTracesSampleRate ?? 0)),
        beforeSend: event => redactSentryEvent(event),
        beforeBreadcrumb: breadcrumb => ['ui.input', 'console', 'xhr', 'fetch'].includes(breadcrumb.category ?? '') ? null : breadcrumb,
        integrations: defaults => defaults.filter(integration => !/replay|feedback/i.test(integration.name)),
      })
      Sentry.setTag('hid.app', options.app)
      sentryEnabled = true
    } catch {
      sentryEnabled = false
    }
  }
  if (options.posthogKey) {
    try {
      posthog.init(options.posthogKey, {
        api_host: options.posthogHost ?? 'https://us.i.posthog.com',
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        mask_all_text: true,
        persistence: 'memory',
      })
      posthogEnabled = true
    } catch {
      posthogEnabled = false
    }
  }
}

export function captureProductEvent(event: SafeProductEvent, properties: Record<string, unknown> = {}): void {
  if (!posthogEnabled || !activeApp || !SAFE_PRODUCT_EVENTS.includes(event)) return
  try {
    posthog.capture(event, { app: activeApp, ...safeTelemetryProperties(properties) })
  } catch {
    // Telemetry is non-critical and must never interrupt a healthcare workflow.
  }
}

export function captureSafeException(error: unknown, context: Record<string, unknown> = {}): void {
  if (!sentryEnabled) return
  try {
    Sentry.captureException(error instanceof Error ? error : new Error('Non-Error exception'), {
      extra: safeTelemetryProperties(context),
      tags: activeApp ? { 'hid.app': activeApp } : undefined,
    })
  } catch {
    // Observability failure is deliberately ignored.
  }
}

export class ApplicationErrorBoundary extends React.Component<
  React.PropsWithChildren<{ app: HidFrontendApp; fallback?: React.ReactNode }>,
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error): void {
    captureSafeException(error, { app: this.props.app, operation: 'react_render' })
  }

  render(): React.ReactNode {
    if (this.state.failed) return this.props.fallback ?? <main role="alert"><h1>Workspace unavailable</h1><p>Reload the application. No clinical change was recorded.</p></main>
    return this.props.children
  }
}
