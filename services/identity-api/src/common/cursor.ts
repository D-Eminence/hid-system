import { createHash } from 'node:crypto';
import { DomainProblem } from './problem';

/**
 * Opaque keyset cursors for newest-first administration lists (Stage 4A).
 *
 * A cursor names the last row of a page (its timestamp at microsecond
 * precision and its id) and the list and filters it was issued for. It is a
 * position, not a credential: every page re-applies the caller's permissions
 * and filters, and a cursor issued for another list or other filters, or one
 * that is not exactly as issued, is refused. Clients must treat it as opaque.
 */
export interface CursorPosition {
  /** UTC timestamp with microseconds, as Postgres `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` renders it. */
  readonly at: string;
  readonly id: string;
}

export type CursorFilters = Readonly<Record<string, string | null | undefined>>;

/** SQL that renders a timestamptz column as a cursor position timestamp. */
export const cursorTimestampSql = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const MAX_CURSOR_LENGTH = 512;
const VERSION = 1;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function encodeCursor(list: string, filters: CursorFilters, position: CursorPosition): string {
  if (!isCalendarTimestamp(position.at) || !UUID.test(position.id)) {
    throw new Error('A cursor position needs a microsecond UTC timestamp and a lower-case UUID');
  }
  return Buffer.from(JSON.stringify({ v: VERSION, l: list, f: filterBinding(list, filters), t: position.at,
    i: position.id }), 'utf8').toString('base64url');
}

/** Returns the position a cursor names, or throws 400 ADMIN_INVALID_CURSOR. */
export function decodeCursor(value: string, list: string, filters: CursorFilters): CursorPosition {
  if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw invalidCursor();
  const { v, l, f, t, i } = decoded as Record<string, unknown>;
  if (v !== VERSION || l !== list || f !== filterBinding(list, filters)
    || typeof t !== 'string' || !isCalendarTimestamp(t)
    || typeof i !== 'string' || !UUID.test(i)) {
    throw invalidCursor();
  }
  const position = { at: t, id: i };
  // Only the exact issued encoding is accepted (no extra fields, padding or re-ordering).
  if (encodeCursor(list, filters, position) !== value) throw invalidCursor();
  return position;
}

/** Splits a limit+1 result into one page and the cursor of the page's last row. */
export function cursorPage<Row extends { cursorAt: string; id: string }>(rows: readonly Row[], limit: number,
  list: string, filters: CursorFilters): { rows: Row[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor(list, filters, { at: last.cursorAt, id: last.id }) : null };
}

/**
 * A real calendar instant in the issued format that Postgres accepts. JavaScript
 * also accepts year 0000 and 30 February-style overflow; Postgres rejects both.
 */
function isCalendarTimestamp(value: string): boolean {
  if (!TIMESTAMP.test(value) || value.startsWith('0000')) return false;
  const milliseconds = Date.parse(`${value.slice(0, 23)}Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === `${value.slice(0, 23)}Z`;
}

function filterBinding(list: string, filters: CursorFilters): string {
  const canonical = Object.keys(filters).sort().map((key) => [key, filters[key] ?? null]);
  return createHash('sha256').update(JSON.stringify([list, canonical]), 'utf8').digest('base64url').slice(0, 22);
}

function invalidCursor(): DomainProblem {
  return new DomainProblem(400, 'ADMIN_INVALID_CURSOR', 'The page cursor is invalid; reload the list from the start');
}
