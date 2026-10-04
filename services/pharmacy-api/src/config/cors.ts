export function pharmacyCorsOptions(allowedOrigins: ReadonlySet<string>) {
  return {
    origin: (origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.has(origin)) callback(null, true);
      else callback(new Error('Origin is not permitted'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-correlation-id',
      'x-csrf-token', 'x-facility-id', 'x-purpose-of-use'],
    exposedHeaders: ['location', 'x-correlation-id'],
    maxAge: 600,
  };
}
