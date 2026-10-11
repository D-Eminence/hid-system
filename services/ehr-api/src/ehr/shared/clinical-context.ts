import { createHash } from 'node:crypto';
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

/**
 * Opaque keyset cursors for the clinical record's newest-first lists.
 *
 * A cursor names the last row of a page: its sort key at microsecond
 * precision, as Postgres stores it, and its id; and the list and scope
 * (patient, encounter) it was issued for. It is a position, not a credential:
 * every page re-applies the caller's authorization. A cursor issued for
 * another list or scope, one in an earlier format, or one that is not exactly
 * as issued is refused with 400 INVALID_CURSOR, which tells the client to load
 * the list from the start. Clients must treat it as opaque.
 */
export interface TimelineCursor {
  /** UTC timestamp with microseconds, as timelineCursorSql renders it. */
  sortAt: string;
  id: string;
}

/** The list a cursor pages, and the patient and encounter it pages within. */
export interface TimelineScope {
  list: string;
  patientId: string;
  encounterId?: string;
}

export interface TimelinePage<Row> {
  items: readonly Row[];
  nextCursor: string | null;
}

/**
 * A row without its `cursorAt`. Unlike Omit, it keeps the named columns of a
 * pg row type, whose index signature would otherwise swallow them.
 */
export type WithoutCursor<Row> = { [Key in keyof Row as Key extends 'cursorAt' ? never : Key]: Row[Key] };

/**
 * SQL that renders a timestamptz sort key at the microsecond, for the row's
 * `cursorAt`. node-postgres returns a timestamptz as a JavaScript Date, which
 * keeps only milliseconds, so the cursor must never be built from the Date.
 */
export const timelineCursorSql = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 512;
// to_char's YYYY: four digits, or five or six from year 10000 on, without a
// leading zero. 294276 is the last year a timestamptz holds.
const CURSOR_TIMESTAMP = /^(\d{4}|[1-9]\d{4,5})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/;
const LAST_TIMESTAMPTZ_YEAR = 294276;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function encodeTimelineCursor(scope: TimelineScope, position: TimelineCursor): string {
  if (!isCalendarTimestamp(position.sortAt) || !CURSOR_ID.test(position.id)) {
    throw new Error('A timeline cursor needs a microsecond UTC timestamp and a lower-case UUID');
  }
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, l: scope.list, f: scopeBinding(scope),
    t: position.sortAt, i: position.id }), 'utf8').toString('base64url');
}

/** The position a cursor names, or 400 INVALID_CURSOR. */
export function decodeTimelineCursor(value: string | undefined, scope: TimelineScope): TimelineCursor | undefined {
  if (!value) return undefined;
  if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw invalidCursor();
  const { v, l, f, t, i } = decoded as Readonly<Record<string, unknown>>;
  if (v !== CURSOR_VERSION || l !== scope.list || f !== scopeBinding(scope)
    || typeof t !== 'string' || !isCalendarTimestamp(t) || typeof i !== 'string' || !CURSOR_ID.test(i)) {
    throw invalidCursor();
  }
  const position = { sortAt: t, id: i };
  // Only the exact issued encoding is accepted: no extra fields, padding or re-ordering.
  if (encodeTimelineCursor(scope, position) !== value) throw invalidCursor();
  return position;
}

/**
 * Splits a limit+1 result into one page and the cursor of its last row. Each
 * row carries its sort key as `cursorAt` (timelineCursorSql); the returned
 * items do not.
 */
export function timelinePage<Row extends { id: string; cursorAt: string }>(
  rows: readonly Row[],
  limit: number,
  scope: TimelineScope,
): TimelinePage<WithoutCursor<Row>> {
  const page = rows.slice(0, limit);
  const tail = rows.length > limit ? page.at(-1) : undefined;
  return {
    items: page.map(withoutCursor),
    nextCursor: tail ? encodeTimelineCursor(scope, { sortAt: tail.cursorAt, id: tail.id }) : null,
  };
}

function withoutCursor<Row extends { cursorAt: string }>(row: Row): WithoutCursor<Row> {
  const item: Record<PropertyKey, unknown> = { ...row };
  delete item.cursorAt;
  return item as WithoutCursor<Row>;
}

/**
 * A real calendar instant in the issued format that Postgres accepts: year 1
 * to 294276, no 30 February, no hour 24 and no leap second. Checked by
 * arithmetic, since JavaScript dates neither reach year 294276 nor reject
 * 30 February.
 */
function isCalendarTimestamp(value: string): boolean {
  const fields = CURSOR_TIMESTAMP.exec(value)?.slice(1).map(Number);
  if (!fields) return false;
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = fields;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
  return year >= 1 && year <= LAST_TIMESTAMPTZ_YEAR && days !== undefined && day >= 1 && day <= days
    && hour <= 23 && minute <= 59 && second <= 59;
}

function scopeBinding(scope: TimelineScope): string {
  return createHash('sha256').update(JSON.stringify([scope.list, scope.patientId.toLowerCase(),
    scope.encounterId?.toLowerCase() ?? null]), 'utf8').digest('base64url').slice(0, 22);
}

function invalidCursor(): DomainProblem {
  return new DomainProblem(400, 'INVALID_CURSOR', 'Pagination cursor is invalid');
}
