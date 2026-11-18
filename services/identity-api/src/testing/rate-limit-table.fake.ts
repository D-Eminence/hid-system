/**
 * An in-memory auth.otp_rate_limits (0028) answering the statements
 * consumeRateLimit (auth/rate-limit.ts) sends, and a read of a bucket's
 * blocked_until, for unit tests only (no database). Each statement runs
 * without an await, as one transaction would see it. `query` answers
 * undefined for any other statement, so a caller can fall through to its own
 * fake.
 */
export interface FakeRateLimitRow {
  scope: string;
  bucket_hmac: string;
  window_started_at: Date;
  request_count: number;
  blocked_until: Date | null;
}

export function fakeRateLimitTable(options: { now?: () => number } = {}) {
  const rows = new Map<string, FakeRateLimitRow>();
  const now = () => options.now?.() ?? Date.now();
  const key = (scope: unknown, bucket: unknown) => `${String(scope)}:${String(bucket)}`;
  let failing = false;

  function query(sql: string, values: readonly unknown[] = []): { rows: unknown[]; rowCount: number } | undefined {
    if (!sql.includes('auth.otp_rate_limits') && !sql.includes('pg_advisory_xact_lock')) return undefined;
    if (failing) throw Object.assign(new Error('connection reset'), { code: '08006' });
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (/select\s+blocked_until\s+from auth\.otp_rate_limits/.test(sql)) {
      const row = rows.get(key('account', values[0]));
      const held = row?.blocked_until && row.blocked_until.getTime() > now() ? row : undefined;
      return { rows: held ? [{ blocked_until: held.blocked_until }] : [], rowCount: held ? 1 : 0 };
    }
    if (/select request_count, window_started_at, blocked_until/.test(sql)) {
      const row = rows.get(key(values[0], values[1]));
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (/insert into auth\.otp_rate_limits/.test(sql) && /on conflict/.test(sql)) {
      const [scope, bucket, windowExpired, nextCount, blocked, windowSeconds] = values as
        [string, string, boolean, number, boolean, number];
      const existing = rows.get(key(scope, bucket));
      const at = new Date(now());
      rows.set(key(scope, bucket), existing ? {
        ...existing,
        window_started_at: windowExpired ? at : existing.window_started_at,
        request_count: nextCount,
        blocked_until: blocked ? new Date(at.getTime() + windowSeconds * 1000) : null,
      } : { scope, bucket_hmac: bucket, window_started_at: at, request_count: 1, blocked_until: null });
      return { rows: [], rowCount: 1 };
    }
    throw new Error('fake auth.otp_rate_limits: unexpected statement');
  }

  return {
    rows,
    query,
    /** Every statement on the table fails from now on (a lost connection). */
    fail(): void { failing = true; },
  };
}
