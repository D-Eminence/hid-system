import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * The CORS answer of ehr-api (main.ts). The patient site calls the API on
 * another origin, so every header it sends must be listed here or the
 * browser's preflight refuses the request: X-Card-View names a card-link view
 * on GET card-share/records (0118).
 */
export function corsOptions(allowedOrigins: ReadonlySet<string>): CorsOptions {
  return {
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(new Error('Origin is not permitted'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'if-match',
      'x-correlation-id',
      'x-csrf-token',
      'x-facility-id',
      'x-purpose-of-use',
      'x-card-view',
    ],
    exposedHeaders: ['etag', 'location', 'x-correlation-id', 'x-csrf-token'],
    maxAge: 600,
  };
}
