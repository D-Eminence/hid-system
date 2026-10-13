import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { DomainProblem } from '../common/problem';

/**
 * Cross-origin settings for browser callers on an allowed origin. A cookie
 * session sends its CSRF token in `x-csrf-token`, which the security guard
 * forwards to Identity, so the header must be allowed in a preflight.
 */
export function corsOptions(corsOrigins: string): CorsOptions {
  const allowedOrigins = new Set(corsOrigins.split(',').map((origin) => origin.trim()));
  return {
    origin: (origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      // A deliberate refusal, never the 500 a plain Error became (A19).
      else callback(new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-correlation-id',
      'x-csrf-token', 'x-facility-id', 'x-purpose-of-use'],
    exposedHeaders: ['location', 'x-correlation-id'],
    maxAge: 600,
  };
}
