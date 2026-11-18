import type { PoolClient } from 'pg';

/**
 * A transaction client for unit tests whose `query` mock scripts the
 * statements of a service, answering the patient recent-sign-in check's
 * schema probe (recent-authentication.ts: is 0127's
 * auth.session_single_sign_on there?) itself, so the scripted answers and
 * the recorded calls stay those of the service's own statements. The table
 * is there, as on every database this Identity is released with.
 */
export function clientAnsweringSingleSignOnProbe(query: jest.Mock): PoolClient {
  return {
    // The service's own statements reach the mock exactly as they were sent (with or without values).
    query: (...args: unknown[]) => (String(args[0]).includes("to_regclass('auth.session_single_sign_on')")
      ? Promise.resolve({ rows: [{ stored: true }], rowCount: 1 })
      : query(...args)),
  } as unknown as PoolClient;
}
