import type { HidRequest, DataAccessContext } from '../../common/request-context';
import { requireRequestContext } from '../../common/request-context';
import { DomainProblem } from '../../common/problem';
export { requireIdempotencyKey, requestDigest } from '../../common/idempotency';

export function clinicalContext(request: HidRequest): DataAccessContext {
  const purpose = request.header('x-purpose-of-use');
  if (purpose !== 'direct-care') {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'X-Purpose-Of-Use must be direct-care for clinical access');
  }
  return requireRequestContext(request, purpose);
}

export interface TimelineCursor {
  sortAt: string;
  id: string;
}

export interface TimelinePage<Row> {
  items: readonly Row[];
  nextCursor: string | null;
}

export function decodeTimelineCursor(value: string | undefined): TimelineCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid cursor');
    const record = parsed as Readonly<Record<string, unknown>>;
    if (typeof record.sortAt !== 'string'
      || !Number.isFinite(Date.parse(record.sortAt))
      || new Date(record.sortAt).toISOString() !== record.sortAt
      || typeof record.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id)) {
      throw new Error('invalid cursor');
    }
    return { sortAt: record.sortAt, id: record.id };
  } catch {
    throw new DomainProblem(400, 'INVALID_CURSOR', 'Pagination cursor is invalid');
  }
}

export function timelinePage<Row extends { id: string }>(
  rows: readonly Row[],
  limit: number,
  sortAt: (row: Row) => Date | string,
): TimelinePage<Row> {
  const items = rows.slice(0, limit);
  const tail = rows.length > limit ? items.at(-1) : undefined;
  return {
    items,
    nextCursor: tail
      ? Buffer.from(JSON.stringify({ sortAt: new Date(sortAt(tail)).toISOString(), id: tail.id }), 'utf8').toString('base64url')
      : null,
  };
}
