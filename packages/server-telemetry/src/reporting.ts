import type * as SentryModule from '@sentry/node';
import type { NodeOptions } from '@sentry/node';
import { scrubEvent } from './scrub';

type Sentry = typeof SentryModule;

/**
 * The SDK is loaded only when reporting is enabled: with SENTRY_DSN unset the
 * services never load (or execute any code from) @sentry/node.
 */
let sentry: Sentry | undefined;
function loadSentry(): Sentry {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sentry ??= require('@sentry/node') as Sentry;
  return sentry;
}

export interface ErrorReportingOptions {
  /** Stable service name, sent as the `service` tag. */
  service: string;
  /**
   * Test seam only: replaces the network transport so tests can inspect the
   * exact envelopes without any network access. Never set in services.
   */
  transport?: NodeOptions['transport'];
}

const ECS_METADATA_TIMEOUT_MS = 2_000;

let enabled = false;

/** True once `initErrorReporting` has started Sentry in this process. */
export function isErrorReportingEnabled(): boolean {
  return enabled;
}

/** Exact Sentry options used by every backend service (exported for review and tests). */
export function buildSentryOptions(dsn: string, transport?: NodeOptions['transport']): NodeOptions {
  const Sentry = loadSentry();
  return {
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || 'production',
    sendDefaultPii: false,
    // No automatic integrations (http/express/console/context lines/local
    // variables/modules/request data are all off). Only the uncaught-exception
    // handler is re-added (it reports, then exits 1 as Node would). Unhandled
    // rejections use our own handler (handleUnhandledRejection) because
    // Sentry's integration ignores AbortError and would suppress the crash.
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
    ],
    includeLocalVariables: false,
    // Explicit 0 (rather than undefined) also overrides SENTRY_TRACES_SAMPLE_RATE.
    tracesSampleRate: 0,
    // No OpenTelemetry tracer/provider and no import-in-the-middle loader hooks.
    skipOpenTelemetrySetup: true,
    registerEsmLoaderHooks: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSendTransaction: () => null,
    sendClientReports: false,
    includeServerName: false,
    beforeSend: (event, hint) => scrubEvent(event, hint),
    ...(transport ? { transport } : {}),
  };
}

/**
 * Starts privacy-scrubbed error reporting when SENTRY_DSN is set. Returns false
 * (and touches nothing) when it is absent or empty.
 */
export function initErrorReporting(options: ErrorReportingOptions): boolean {
  const dsn = (process.env.SENTRY_DSN ?? '').trim();
  if (!dsn || enabled) return enabled;
  const Sentry = loadSentry();
  Sentry.init(buildSentryOptions(dsn, options.transport));
  const scope = Sentry.getGlobalScope();
  scope.setTag('service', options.service);
  scope.setTag('release_id', fallbackReleaseId());
  enabled = true;
  process.on('unhandledRejection', handleUnhandledRejection);
  void resolveImageReleaseId().then((releaseId) => {
    if (releaseId) scope.setTag('release_id', releaseId);
  });
  return true;
}

function fallbackReleaseId(): string {
  return process.env.HID_RELEASE_ID || 'unknown';
}

/** `repo@sha256:<64 hex>` -> `sha256:<first 12 hex>`; anything else -> undefined. */
export function releaseIdFromImage(image: unknown): string | undefined {
  if (typeof image !== 'string') return undefined;
  const match = /@sha256:([0-9a-f]{64})$/i.exec(image.trim());
  return match ? `sha256:${match[1]!.slice(0, 12).toLowerCase()}` : undefined;
}

/**
 * Reads the running container's image digest from the ECS task metadata
 * endpoint (v4). Release automation only swaps image digests, so this is the
 * release identity. Never throws; resolves undefined when unavailable.
 */
export async function resolveImageReleaseId(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | undefined> {
  const uri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!uri || typeof fetchImpl !== 'function') return undefined;
  try {
    const response = await fetchImpl(uri, { signal: AbortSignal.timeout(ECS_METADATA_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const metadata = (await response.json()) as { Image?: unknown } | null;
    return releaseIdFromImage(metadata?.Image);
  } catch {
    return undefined;
  }
}

/**
 * Reports a server-side failure. No-op when reporting is disabled. Non-Error
 * throwables are replaced by a generic `NonErrorThrown` error so their content
 * is never serialized.
 */
export function captureServerError(error: unknown, routeTemplate?: string): void {
  capture(error, routeTemplate, { type: 'generic', handled: true });
}

function capture(error: unknown, routeTemplate: string | undefined,
  mechanism: { type: string; handled: boolean }): void {
  if (!enabled) return;
  try {
    const reportable = error instanceof Error ? error : nonErrorThrown();
    // The route goes in the per-event capture context, never on a scope: with
    // skipOpenTelemetrySetup there is no async context strategy, so
    // withScope() would not fork and a tag could leak into later events.
    loadSentry().captureException(reportable, {
      mechanism,
      ...(routeTemplate ? { captureContext: { tags: { route: routeTemplate } } } : {}),
    });
  } catch {
    // Reporting must never affect the caller.
  }
}

let exitingOnRejection = false;

/**
 * Replaces Sentry's onUnhandledRejection integration, which silently ignores
 * AbortError (and, by registering a listener, would also disable Node's
 * default crash). Every unhandled rejection is reported through the scrubbed
 * path, flushed for at most 2s, printed to stderr and then the process exits
 * with code 1 exactly like Node's default `--unhandled-rejections=throw`.
 */
export async function handleUnhandledRejection(reason: unknown): Promise<void> {
  capture(reason, undefined, { type: 'auto.node.onunhandledrejection', handled: false });
  if (exitingOnRejection) return;
  exitingOnRejection = true;
  await flushErrorReporting(2_000);
  try {
    process.stderr.write(`${reason instanceof Error ? reason.stack ?? String(reason) : String(reason)}\n`);
  } catch {
    // stderr unavailable: still exit.
  }
  process.exit(1);
}

function nonErrorThrown(): Error {
  const error = new Error('Non-Error value thrown');
  error.name = 'NonErrorThrown';
  return error;
}

/** Waits (bounded) for queued events to be sent, e.g. before a worker exits. */
export async function flushErrorReporting(timeoutMs = 2_000): Promise<boolean> {
  if (!enabled) return true;
  try {
    return await loadSentry().flush(timeoutMs);
  } catch {
    return false;
  }
}

/** Test helper: shuts the client down and resets module state. */
export async function resetErrorReportingForTests(): Promise<void> {
  if (enabled) await loadSentry().close(0).catch(() => false);
  process.removeListener('unhandledRejection', handleUnhandledRejection);
  exitingOnRejection = false;
  enabled = false;
}
