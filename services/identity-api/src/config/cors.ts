export function identityCorsOptions(allowedOrigins: ReadonlySet<string>) {
  return {
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(new Error('Origin is not permitted'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'if-match',
      'x-correlation-id', 'x-csrf-token', 'x-facility-id', 'x-purpose-of-use',
      'x-hid-internal-caller', 'x-hid-service-authorization', 'x-hid-service-token',
      'x-hid-scanner-authorization'],
    exposedHeaders: ['etag', 'location', 'x-correlation-id', 'x-csrf-token'],
    maxAge: 600,
  };
}
