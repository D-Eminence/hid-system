import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { DomainProblem } from '../common/problem';

/** Metadata headers of the principal CSV export (GET /admin/principals/export). */
export const EXPORT_RESPONSE_HEADERS = {
  rowCount: 'X-HID-Export-Row-Count',
  rowLimit: 'X-HID-Export-Row-Limit',
  truncated: 'X-HID-Export-Truncated',
} as const;

/**
 * Response headers a browser on an allowed origin may read. The export
 * metadata is included so a console served from another origin can show the
 * row count and truncation (Stage 4A), and Retry-After so a client can tell
 * when a rate-limited request may be repeated (A21).
 */
export const CORS_EXPOSED_HEADERS: readonly string[] = ['etag', 'location', 'retry-after', 'x-correlation-id', 'x-csrf-token',
  ...Object.values(EXPORT_RESPONSE_HEADERS).map((name) => name.toLowerCase())];

/**
 * A request without Origin (a same-origin GET) or from an allowed origin gets
 * the CORS headers. One from any other origin is refused before routing with
 * 403 ORIGIN_DENIED and no CORS headers: a deliberate refusal, never the 500 a
 * plain Error became, which raised the 5xx alarms for anyone who forged an
 * Origin and made a missing portal origin look like a server fault (A19).
 */
export function corsOptions(corsOrigins: string): CorsOptions {
  const allowedOrigins = new Set(corsOrigins.split(',').map((origin) => origin.trim()));
  return {
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed'), false);
    },
    credentials: true,
    // PATCH: organization profile completion (/identity/organization-applications/completion/profile).
    // DELETE: patient access PIN removal (/identity/me/access-pin).
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'if-match', 'x-correlation-id', 'x-csrf-token', 'x-facility-id', 'x-purpose-of-use', 'x-hid-internal-caller', 'x-hid-service-authorization', 'x-hid-service-token', 'x-hid-scanner-authorization',
      // X-HID-Client: staff-web or patient-web names the app refreshing or signing out a cookie sign-in
      // (POST /auth/refresh, POST /auth/logout), so it acts only on its own kind of sign-in.
      'x-hid-client'],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    maxAge: 600,
  };
}
