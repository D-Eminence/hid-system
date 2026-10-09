import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/** Metadata headers of the principal CSV export (GET /admin/principals/export). */
export const EXPORT_RESPONSE_HEADERS = {
  rowCount: 'X-HID-Export-Row-Count',
  rowLimit: 'X-HID-Export-Row-Limit',
  truncated: 'X-HID-Export-Truncated',
} as const;

/**
 * Response headers a browser on an allowed origin may read. The export
 * metadata is included so a console served from another origin can show the
 * row count and truncation (Stage 4A).
 */
export const CORS_EXPOSED_HEADERS: readonly string[] = ['etag', 'location', 'x-correlation-id', 'x-csrf-token',
  ...Object.values(EXPORT_RESPONSE_HEADERS).map((name) => name.toLowerCase())];

export function corsOptions(corsOrigins: string): CorsOptions {
  const allowedOrigins = new Set(corsOrigins.split(',').map((origin) => origin.trim()));
  return {
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(new Error('Origin is not permitted'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'if-match', 'x-correlation-id', 'x-csrf-token', 'x-facility-id', 'x-purpose-of-use', 'x-hid-internal-caller', 'x-hid-service-authorization', 'x-hid-service-token', 'x-hid-scanner-authorization'],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    maxAge: 600,
  };
}
