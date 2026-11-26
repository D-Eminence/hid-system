import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import type { ListOrderNoticesQueryDto, MarkOrderNoticesReadDto } from './order-notices.dto';

/**
 * ORD-11's setting, ORDER_NOTICES_ENABLED (off by default). Off, every route
 * answers 503 ORDER_NOTICES_UNAVAILABLE without opening a transaction, and
 * the sweep does not run. The database writes notices either way (0159's
 * own switch row is the owner's, not this).
 */
export class OrderNoticesSwitch {
  constructor(readonly enabled: boolean) {}
}

/** The six kinds 0159 writes, in the order the summary lists them. */
export const ORDER_NOTICE_KINDS = ['lab_result_critical', 'lab_result_corrected', 'lab_result_ready',
  'lab_result_withdrawn', 'prescription_dispensed', 'dispensing_reversed'] as const;
export type OrderNoticeKind = typeof ORDER_NOTICE_KINDS[number];

// Each call is one of 0159's definers, run in the doctor's own transaction
// (withTransaction: the session's account, facility, membership and purpose).
// Nothing here reads an order table: the list and Seen definers read the
// order by id under its row-level security in that same session.
export const ORDER_NOTICE_SUMMARY_SQL = 'select kind, unread_count, critical_not_seen_count from ehr.order_notice_summary()';
const NOTICE_COLUMNS = `notice_id::text as notice_id, kind, order_kind, order_id::text as order_id,
       order_route_id::text as order_route_id, encounter_id::text as encounter_id, display, event_count,
       first_event_at, last_event_at, read_at, needs_seen, seen_at, version::text as version, access_ended,
       patient_id::text as patient_id, full_name, sex, date_of_birth::text as date_of_birth, health_id_last4`;
// The list also answers where its page was cut (the last row's tier, last
// event time at the microsecond and id), from which the next cursor is made.
export const ORDER_NOTICES_LIST_SQL = `select ${NOTICE_COLUMNS}, has_more, resume_tier,
       to_char(resume_event_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as resume_at,
       resume_notice_id::text as resume_id
  from ehr.list_order_notices($1::text, $2::integer, $3::timestamptz, $4::uuid, $5::integer)`;
export const ORDER_NOTICES_READ_SQL = 'select ehr.mark_order_notices_read($1::uuid[], $2::bigint[]) as updated';
export const ORDER_NOTICE_SEEN_SQL = `select ${NOTICE_COLUMNS}
  from ehr.mark_order_notice_seen($1::uuid)`;
export const ORDER_NOTICE_SWEEP_SQL = 'select ehr.sweep_order_notices($1::integer) as swept';
/** Notices (and then gap rows) the sweep removes at most each time. */
export const ORDER_NOTICE_SWEEP_BATCH = 500;

export const ORDER_NOTICE_MESSAGES = {
  unavailable: 'Notices about your orders are not available yet.',
  notFound: 'This notice is not available.',
  consentRequired: 'Ask the patient for access to see this result first.',
  noPermission: 'Required permission is missing',
  invalidCursor: 'Pagination cursor is invalid',
} as const;

interface SummaryRow {
  kind: string;
  unread_count: number | string;
  critical_not_seen_count: number | string;
}

interface NoticeRow {
  notice_id: string;
  kind: string;
  order_kind: string;
  order_id: string;
  order_route_id: string | null;
  encounter_id: string | null;
  display: string | null;
  event_count: number | string;
  first_event_at: Date | string;
  last_event_at: Date | string;
  read_at: Date | string | null;
  needs_seen: boolean;
  seen_at: Date | string | null;
  version: string;
  access_ended: boolean | null;
  patient_id: string | null;
  full_name: string | null;
  sex: string | null;
  date_of_birth: string | null;
  health_id_last4: string | null;
  has_more?: boolean | null;
  resume_tier?: number | string | null;
  resume_at?: string | null;
  resume_id?: string | null;
}

export interface OrderNoticeCounts {
  unread: number;
  criticalNotSeen: number;
}

/** GET summary: totals, and the same per kind (every kind, 0 when none). Names no patient. */
export interface OrderNoticeSummary extends OrderNoticeCounts {
  byKind: Record<string, OrderNoticeCounts>;
}

export interface OrderNotice {
  noticeId: string;
  kind: string;
  /** Sent back with mark read; it changes when the notice does (a merged event, read, Seen). */
  version: number;
  /** The first event's time. */
  createdAt: string;
  /** The latest event's time (a merged notice moves it). */
  lastEventAt: string;
  count: number;
  readAt: string | null;
  needsSeen: boolean;
  seenAt: string | null;
  order: { type: string; id: string; routeId: string | null; encounterId: string | null; display: string | null };
  patient: { patientId: string; fullName: string; sex: string | null; dateOfBirth: string | null;
    healthIdLast4: string | null } | null;
  accessEnded: boolean;
  message: string;
}

export interface OrderNoticePage {
  items: OrderNotice[];
  nextCursor: string | null;
}

/**
 * ORD-11 (0159): the doctor's notices about their own orders. Every call is
 * one definer in the doctor's own transaction; the database decides what this
 * session may see (its account and facility, an active membership with the
 * kind's read permission, direct care) and writes the list, read and Seen
 * audit rows. This adds the switch, the answer's shape and its words.
 */
@Injectable()
export class OrderNoticesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly notices: OrderNoticesSwitch,
  ) {}

  async summary(context: DataAccessContext): Promise<OrderNoticeSummary> {
    this.requireEnabled();
    const rows = await this.run(context, async (client) =>
      (await client.query<SummaryRow>(ORDER_NOTICE_SUMMARY_SQL)).rows, true);
    const byKind: Record<string, OrderNoticeCounts> = Object.fromEntries(
      ORDER_NOTICE_KINDS.map((kind) => [kind, { unread: 0, criticalNotSeen: 0 }]));
    let unread = 0;
    let criticalNotSeen = 0;
    for (const row of rows) {
      const counts = { unread: Number(row.unread_count), criticalNotSeen: Number(row.critical_not_seen_count) };
      byKind[row.kind] = counts;
      unread += counts.unread;
      criticalNotSeen += counts.criticalNotSeen;
    }
    return { unread, criticalNotSeen, byKind };
  }

  /**
   * A page, and where the next one starts. The cursor carries the position
   * the page was cut at, as it was then, so a notice Seen or merged between
   * pages neither hides nor repeats the rest. It is valid only for the
   * member, facility and state it was issued for.
   */
  async list(context: DataAccessContext, query: ListOrderNoticesQueryDto): Promise<OrderNoticePage> {
    this.requireEnabled();
    const scope = cursorScope(context, query.state);
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor, scope);
    const rows = await this.run(context, async (client) => (await client.query<NoticeRow>(ORDER_NOTICES_LIST_SQL,
      [query.state, cursor?.tier ?? null, cursor?.at ?? null, cursor?.id ?? null, query.limit ?? 20])).rows);
    const first = rows[0];
    const tier = first?.resume_tier === null || first?.resume_tier === undefined ? undefined : Number(first.resume_tier);
    return {
      items: rows.map(noticeAnswer),
      nextCursor: first?.has_more === true && (tier === 0 || tier === 1) && first.resume_at && first.resume_id
        ? encodeCursor({ scope, tier, at: first.resume_at, id: first.resume_id }) : null,
    };
  }

  /**
   * Marks read the notices still at the version sent. One that changed since
   * (a new event merged in, or read elsewhere) stays as it is and is not
   * counted; that is not an error. Needs no access to the patient.
   */
  async markRead(context: DataAccessContext, body: MarkOrderNoticesReadDto): Promise<{ updated: number }> {
    this.requireEnabled();
    const ids = body.notices.map((pair) => pair.noticeId);
    const versions = body.notices.map((pair) => pair.version);
    const updated = await this.run(context, async (client) =>
      (await client.query<{ updated: number | string | null }>(ORDER_NOTICES_READ_SQL, [ids, versions])).rows[0]?.updated);
    return { updated: Number(updated ?? 0) };
  }

  /** Seen: final, and only while the doctor may read the patient's records here (403 CONSENT_REQUIRED). */
  async seen(context: DataAccessContext, noticeId: string): Promise<OrderNotice> {
    this.requireEnabled();
    const row = await this.run(context, async (client) => {
      const found = (await client.query<NoticeRow>(ORDER_NOTICE_SEEN_SQL, [noticeId])).rows[0];
      // The definer answers one row or refuses; no row is a fault, and nothing is kept.
      if (!found) throw new Error('ORDER_NOTICE_SEEN_UNANSWERED');
      return found;
    });
    return noticeAnswer(row);
  }

  private requireEnabled(): void {
    if (!this.notices.enabled) throw unavailable();
  }

  private async run<Result>(context: DataAccessContext, operation: (client: PoolClient) => Promise<Result>,
    readOnly = false): Promise<Result> {
    try {
      return await this.database.withTransaction(context, operation, readOnly ? { readOnly: true } : {});
    } catch (error) {
      throw translate(error);
    }
  }
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null || value === undefined ? null : iso(value);
}

/**
 * One notice as the contract answers it. While the doctor may no longer read
 * the patient's records here (accessEnded), there is no patient, visit or
 * display, whatever the row holds.
 */
export function noticeAnswer(row: NoticeRow): OrderNotice {
  const accessEnded = row.access_ended === true || !row.patient_id;
  const count = Number(row.event_count);
  const display = accessEnded ? null : row.display ?? null;
  return {
    noticeId: row.notice_id,
    kind: row.kind,
    version: Number(row.version),
    createdAt: iso(row.first_event_at),
    lastEventAt: iso(row.last_event_at),
    count,
    readAt: isoOrNull(row.read_at),
    needsSeen: row.needs_seen === true,
    seenAt: isoOrNull(row.seen_at),
    order: { type: row.order_kind, id: row.order_id, routeId: row.order_route_id ?? null,
      encounterId: accessEnded ? null : row.encounter_id ?? null, display },
    patient: accessEnded ? null : { patientId: String(row.patient_id), fullName: String(row.full_name ?? ''),
      sex: row.sex ?? null, dateOfBirth: row.date_of_birth ?? null, healthIdLast4: row.health_id_last4 ?? null },
    accessEnded,
    message: noticeMessage(row.kind, display, count, accessEnded, row.seen_at !== null && row.seen_at !== undefined),
  };
}

const ACCESS_ENDED_ASK = 'Ask the patient for access to see it';

/**
 * The notice's words. The test or medicine name only while access lasts;
 * never a result value. A kind this image does not know gets plain words.
 */
export function noticeMessage(kind: string, display: string | null, count: number, accessEnded: boolean,
  seen = false): string {
  if (accessEnded) {
    switch (kind) {
      case 'lab_result_critical':
        return seen ? `A result is ready for a patient whose access has ended. ${ACCESS_ENDED_ASK}.`
          : `A result is ready for a patient whose access has ended. ${ACCESS_ENDED_ASK}, or call the laboratory.`;
      case 'lab_result_corrected':
        return `A corrected result is ready for a patient whose access has ended. ${ACCESS_ENDED_ASK}.`;
      case 'lab_result_withdrawn':
        return `A result was withdrawn for a patient whose access has ended. ${ACCESS_ENDED_ASK}.`;
      case 'prescription_dispensed':
        return `A prescription was dispensed for a patient whose access has ended. ${ACCESS_ENDED_ASK}.`;
      case 'dispensing_reversed':
        return `A dispensing was reversed for a patient whose access has ended. ${ACCESS_ENDED_ASK}.`;
      case 'lab_result_ready':
        return `A result is ready for a patient whose access has ended. ${ACCESS_ENDED_ASK}.`;
      default:
        return `There is news about an order for a patient whose access has ended. ${ACCESS_ENDED_ASK}.`;
    }
  }
  const name = display ?? 'your order';
  const several = count > 1;
  switch (kind) {
    case 'lab_result_critical':
      return seen ? `Critical result: ${name}. Marked Seen.` : `Critical result: ${name}. Open it and mark it Seen.`;
    case 'lab_result_corrected':
      return several ? `${count} corrected results: ${name}.` : `Corrected result: ${name}.`;
    case 'lab_result_ready':
      return several ? `${count} results ready: ${name}.` : `Result ready: ${name}.`;
    case 'lab_result_withdrawn':
      return several ? `${count} results withdrawn: ${name}. They were entered in error.`
        : `Result withdrawn: ${name}. It was entered in error.`;
    case 'prescription_dispensed':
      return `Dispensed: ${name}.`;
    case 'dispensing_reversed':
      return several ? `${count} dispensings reversed: ${name}.` : `Dispensing reversed: ${name}.`;
    default:
      return `News about your order: ${name}.`;
  }
}

const CURSOR_VERSION = 1;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Where the next page starts, and the member, facility and state it was issued for (hashed). */
interface OrderNoticesCursor {
  scope: string;
  /** 1 for a critical notice not Seen, else 0, as the page's last notice was when the page was cut. */
  tier: 0 | 1;
  /** That notice's last event time, UTC at the microsecond. */
  at: string;
  id: string;
}

function cursorScope(context: DataAccessContext, state: string): string {
  return createHash('sha256').update(JSON.stringify(['ehr.order-notices', context.membershipId, context.facilityId,
    state]), 'utf8').digest('base64url').slice(0, 22);
}

function encodeCursor(cursor: OrderNoticesCursor): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, f: cursor.scope, r: cursor.tier, t: cursor.at, i: cursor.id }),
    'utf8').toString('base64url');
}

/** The position a cursor names, or 400 INVALID_CURSOR: another member, facility or state, or not as issued. */
function decodeCursor(value: string, scope: string): OrderNoticesCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw invalidCursor();
  const { v, f, r, t, i } = decoded as Record<string, unknown>;
  if (v !== CURSOR_VERSION || f !== scope || (r !== 0 && r !== 1) || typeof t !== 'string' || !CURSOR_TIME.test(t)
    || typeof i !== 'string' || !CURSOR_ID.test(i)) {
    throw invalidCursor();
  }
  const cursor: OrderNoticesCursor = { scope, tier: r, at: t, id: i };
  // Only the exact issued encoding is accepted.
  if (encodeCursor(cursor) !== value) throw invalidCursor();
  return cursor;
}

function invalidCursor(): DomainProblem {
  return new DomainProblem(400, 'INVALID_CURSOR', ORDER_NOTICE_MESSAGES.invalidCursor);
}

function unavailable(): DomainProblem {
  return new DomainProblem(503, 'ORDER_NOTICES_UNAVAILABLE', ORDER_NOTICE_MESSAGES.unavailable);
}

function invalid(field: string, message: string): DomainProblem {
  return new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
    [{ field, messages: [message] }]);
}

/**
 * The definers' refusals, in the contract's words. A schema without 0159
 * (42883, 42P01) or any other failure: notices are not available (as MY-1).
 */
export function translate(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if (code === '42501' && message === 'ORDER_NOTICES_NOT_PERMITTED') {
    return new DomainProblem(403, 'PERMISSION_DENIED', ORDER_NOTICE_MESSAGES.noPermission);
  }
  if (code === '42501' && message === 'ORDER_NOTICE_CONSENT_REQUIRED') {
    return new DomainProblem(403, 'CONSENT_REQUIRED', ORDER_NOTICE_MESSAGES.consentRequired);
  }
  if (code === 'P0002' && message === 'ORDER_NOTICE_NOT_FOUND') {
    return new DomainProblem(404, 'ORDER_NOTICE_NOT_FOUND', ORDER_NOTICE_MESSAGES.notFound);
  }
  if (code === '22023' && message === 'ORDER_NOTICES_DIRECT_CARE_ONLY') {
    return new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'X-Purpose-Of-Use must be direct-care for clinical access');
  }
  // A cursor position the definer refuses (decodeCursor refuses the rest first).
  if (code === '22023' && message === 'ORDER_NOTICES_CURSOR_INVALID') return invalidCursor();
  if (code === '22023' && message === 'ORDER_NOTICES_LIST_INVALID') return invalid('state', 'state must be unread or all');
  if (code === '22023' && message === 'ORDER_NOTICES_READ_INVALID') {
    return invalid('notices', 'notices must be 1-100 pairs of noticeId and version');
  }
  return unavailable();
}

/**
 * Removes notices past their time every 10 minutes, through 0159's sweeper
 * (90 days after reading or Seen, or after the last event while unread; a
 * critical notice never Seen stays; anything under a legal hold stays), with
 * one expire audit row each. It reads only the notice tables, so it runs as
 * the system. Only while ORDER_NOTICES_ENABLED is on (the count check comes
 * before the first sweep); never in tests. A failure is logged once with no
 * identifier and tried again next time.
 */
@Injectable()
export class OrderNoticeSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderNoticeSweeper.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: DatabaseService,
    private readonly notices: OrderNoticesSwitch,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !this.notices.enabled) return;
    this.timer = setInterval(() => { void this.sweep(); }, 10 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    if (!this.notices.enabled) return 0;
    try {
      return await this.database.withSystemTransaction(`order-notice-sweep-${randomUUID()}`, async (client) =>
        Number((await client.query<{ swept: number }>(ORDER_NOTICE_SWEEP_SQL, [ORDER_NOTICE_SWEEP_BATCH])).rows[0]?.swept
          ?? 0));
    } catch {
      this.logger.warn({ event: 'ehr.order_notice.sweep_unavailable' });
      return 0;
    }
  }
}
