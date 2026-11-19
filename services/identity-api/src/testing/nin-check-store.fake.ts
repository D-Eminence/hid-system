/**
 * An in-memory identity.qoreid_nin_checks with the four 0137 commands, as
 * the migration defines them, for unit tests only (no database). Each command
 * runs without an await, so concurrent callers see it as one transaction, as
 * the row lock makes them in PostgreSQL. The SQL itself is proved by
 * services/ehr-api/test/database/qoreid-nin-check-once.integration.sql and,
 * with two connections, by scripts/verify-nin-check-once-runtime.mjs.
 */
export interface FakeNinCheckRow {
  nin_lookup_hmac: string;
  state: 'checking' | 'held' | 'answered';
  attempt_id: string;
  question_hmac: string | null;
  outcome: 'record' | 'no_record' | 'rejected' | 'unusable' | null;
  record_complete: boolean | null;
  record_source: 'nin_only' | 'profile' | null;
  answer_ciphertext: Buffer | null;
  key_version: string | null;
  until: number;
}

/** 0137's hold for a lease that ended without an outcome. */
const LOST_LEASE_HOLD_MS = 6 * 60 * 60 * 1000;
/** Q115: each use of a stored record keeps it at least this long from the use (identity.qoreid_nin_record_used). */
const RECORD_USE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export function fakeNinCheckStore(options: { erased?: (lookup: string) => boolean; now?: () => number } = {}) {
  const rows = new Map<string, FakeNinCheckRow>();
  const clock = { offsetMs: 0 };
  const now = () => (options.now ?? Date.now)() + clock.offsetMs;
  const erased = (lookup: string) => options.erased?.(lookup) ?? false;
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let failing: string | undefined;

  function begin(values: readonly unknown[]) {
    const [lookup, question, complete, keyVersion, attempt, leaseSeconds] = values as
      [string, string | null, boolean, string, string, number];
    const leaseEnd = now() + leaseSeconds * 1000;
    const row = rows.get(lookup);
    const take = () => {
      rows.set(lookup, { nin_lookup_hmac: lookup, state: 'checking', attempt_id: attempt, question_hmac: question,
        outcome: null, record_complete: null, record_source: null, answer_ciphertext: null, key_version: null,
        until: leaseEnd });
      return { decision: 'call', outcome: null, record_complete: null, answer_ciphertext: null, until: new Date(leaseEnd) };
    };
    if (!row) return take();
    if (row.state === 'checking' && row.until <= now() && row.until + LOST_LEASE_HOLD_MS > now()) {
      Object.assign(row, { state: 'held', until: row.until + LOST_LEASE_HOLD_MS });
      return { decision: 'held', outcome: null, record_complete: null, answer_ciphertext: null, until: new Date(row.until) };
    }
    if (row.until > now()) {
      if (row.state === 'checking') return { decision: 'wait', outcome: null, record_complete: null,
        answer_ciphertext: null, until: new Date(row.until) };
      if (row.state === 'held') return { decision: 'held', outcome: null, record_complete: null,
        answer_ciphertext: null, until: new Date(row.until) };
      if (row.key_version === keyVersion && !erased(lookup)
        && ((row.outcome === 'record' && (row.record_complete || !complete || row.record_source === 'nin_only'))
          || (row.outcome !== 'record' && (row.question_hmac === null || row.question_hmac === question)))) {
        if (row.outcome === 'record') used(row);
        return { decision: 'stored', outcome: row.outcome, record_complete: row.record_complete,
          answer_ciphertext: row.answer_ciphertext, until: new Date(row.until) };
      }
    }
    return take();
  }

  function finish(values: readonly unknown[]) {
    const [lookup, attempt, result, question, complete, ciphertext, keyVersion, seconds] = values as
      [string, string, string, string | null, boolean | null, Buffer | null, string | null, number | null];
    const row = rows.get(lookup);
    if (!row || row.attempt_id !== attempt || row.state !== 'checking') return false;
    if (result === 'released') { rows.delete(lookup); return true; }
    if (result === 'held') { Object.assign(row, { state: 'held', until: now() + Number(seconds) * 1000 }); return true; }
    if (erased(lookup)) { rows.delete(lookup); return false; }
    Object.assign(row, { state: 'answered', outcome: result,
      question_hmac: result === 'record' || result === 'rejected' ? null : question,
      record_complete: result === 'record' ? complete : null,
      record_source: result !== 'record' ? null : question === null ? 'nin_only' : 'profile',
      answer_ciphertext: ciphertext, key_version: keyVersion, until: now() + Number(seconds) * 1000 });
    return true;
  }

  /** Q115's rule: a used record kept at least 30 days from now, never shorter; nothing else changes. */
  function used(row: FakeNinCheckRow) {
    row.until = Math.max(row.until, now() + RECORD_USE_KEEP_MS);
  }

  /** keep_qoreid_nin_record: the rule for a live stored record under this key, of a NIN not erased. */
  function keep(values: readonly unknown[]) {
    const [lookup, keyVersion] = values as [string, string];
    const row = rows.get(lookup);
    if (!row || row.state !== 'answered' || row.outcome !== 'record' || row.key_version !== keyVersion
      || row.until <= now() || erased(lookup)) return false;
    used(row);
    return true;
  }

  /** Expired rows by `until`, then (separately limited) answers for erased NINs, as 0137's two deletes. */
  function prune(values: readonly unknown[]) {
    const limit = Number(values[0]);
    let removed = 0;
    for (const [lookup, row] of [...rows].sort(([, a], [, b]) => a.until - b.until)) {
      if (removed >= limit) break;
      if (row.until <= now() && (row.state !== 'checking' || row.until + LOST_LEASE_HOLD_MS <= now())) {
        rows.delete(lookup); removed += 1;
      }
    }
    let erasedCount = 0;
    for (const [lookup, row] of [...rows]) {
      if (erasedCount >= limit) break;
      if (row.state === 'answered' && erased(lookup)) { rows.delete(lookup); erasedCount += 1; }
    }
    return removed + erasedCount;
  }

  /** Answers the 0137 statements; undefined for any other statement. */
  function query(sql: string, values: readonly unknown[] = []) {
    if (!sql.includes('qoreid_nin_check') && !sql.includes('identity.keep_qoreid_nin_record')) return undefined;
    calls.push({ sql, values });
    if (failing && sql.includes(failing)) throw Object.assign(new Error('database unavailable'), { code: '57P01' });
    if (sql.includes('identity.begin_qoreid_nin_check')) return { rows: [begin(values)] };
    if (sql.includes('identity.finish_qoreid_nin_check')) return { rows: [{ recorded: finish(values) }] };
    if (sql.includes('identity.keep_qoreid_nin_record')) return { rows: [{ kept: keep(values) }] };
    if (sql.includes('identity.prune_qoreid_nin_checks')) return { rows: [{ removed: prune(values) }] };
    return undefined;
  }

  return { rows, clock, calls, query,
    /** Makes every statement containing `fragment` fail as an unavailable database would. */
    fail(fragment: string | undefined) { failing = fragment; } };
}

/**
 * A NinCheckOnce that always asks QoreID and keeps nothing, for unit tests of
 * the paths around it (the guard itself is tested in nin-double-charge.spec.ts).
 */
export function passThroughNinCheck() {
  return {
    check: jest.fn(async (request: { ask: (options: { timeoutMs: number }) => Promise<{ answer: unknown; value: unknown }> }) => {
      const asked = await request.ask({ timeoutMs: 1_000 });
      return { source: 'qoreid' as const, answer: asked.answer, value: asked.value };
    }),
    prune: jest.fn(async () => 0),
  };
}
