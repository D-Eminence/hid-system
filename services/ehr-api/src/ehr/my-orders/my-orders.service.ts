import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { LAB_PROGRESS_UNKNOWN, type LabOwnProgress, type OrderItem, OwnProgressSlots, type PatientOrders,
  PHARMACY_PROGRESS_UNKNOWN, type PharmacyOwnProgress, WorkItemProgressService } from '../../integrations/work-item-progress.service';
import { OrderRouteReader } from '../order-routes/order-route-reader';
import type { MyOrdersQueryDto } from './my-orders.dto';

/** MY-1: the list's one SQL call (0143's definer), with the exact time of where the next page resumes. */
export const MY_ORDERS_SQL = `select kind, order_id::text, encounter_id::text, patient_id::text, full_name, sex,
       date_of_birth::text as date_of_birth, health_id_last4, display, status, priority, created_at, updated_at,
       hidden_count, hidden_count_complete, has_more,
       to_char(resume_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as resume_at,
       resume_kind, resume_id::text as resume_id
  from ehr.list_my_orders($1::text[], $2, $3::date, $4::timestamptz, $5, $6::uuid, $7)`;

/** ORD-3's progress for one page: both kinds' calls, and any one-patient fallback calls, within this deadline. */
export const OWN_PROGRESS_PAGE_DEADLINE_MS = 4_000;

type OrderKind = 'lab_request' | 'prescription';

interface MyOrderRow {
  kind: OrderKind | null;
  order_id: string | null;
  encounter_id: string | null;
  patient_id: string | null;
  full_name: string | null;
  sex: string | null;
  date_of_birth: string | null;
  health_id_last4: string | null;
  display: string | null;
  status: string | null;
  priority: string | null;
  created_at: Date | null;
  updated_at: Date | null;
  hidden_count: string | number | null;
  hidden_count_complete: boolean | null;
  has_more: boolean | null;
  resume_at: string | null;
  resume_kind: OrderKind | null;
  resume_id: string | null;
}

export interface MyOrderItem {
  kind: OrderKind;
  orderId: string;
  encounterId: string;
  patient: { patientId: string; fullName: string; sex: string | null; dateOfBirth: string | null; healthIdLast4: string | null };
  display: string;
  status: string;
  priority: string | null;
  createdAt: string;
  updatedAt: string;
  ownProgress: LabOwnProgress | PharmacyOwnProgress;
  /** Left out when the route could not be read; null when it was read and there is none. */
  orderRoute?: unknown;
}

export interface MyOrdersPage {
  items: MyOrderItem[];
  /** The first page's count, carried by the cursor to later pages. */
  hiddenCount: number;
  /** False when the count stopped at the database's bound and is a lower bound. */
  hiddenCountComplete: boolean;
  since: string;
  nextCursor: string | null;
}

export const MY_ORDERS_MESSAGES = {
  sinceTooOld: 'You can look back up to 2 years. Choose a later date.',
  unavailable: 'Your orders cannot be listed right now. Please try again.',
  noPermission: 'Required permission is missing',
  invalidCursor: 'Pagination cursor is invalid',
} as const;

const CURSOR_VERSION = 2;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The Lagos calendar day of an instant, YYYY-MM-DD. */
export function lagosDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(at);
}

function addDays(day: string, days: number): string {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** As PostgreSQL's date - interval 'N years': the same day, or the month's last day (29 February to the 28th). */
export function addYears(day: string, years: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(year + years, month, 0)).getUTCDate();
  return `${String(year + years).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(date, lastDay)).padStart(2, '0')}`;
}

/**
 * MY-1 (0143): "Ordered by me". The database decides what this member may
 * see now (ehr.list_my_orders, the session's own direct-care rule per
 * patient) and audits the list and each patient shown; this adds each
 * order's own lab or pharmacy progress (ORD-3's several-patient form, one
 * call per kind on the page, all within 4 seconds, audited there per patient)
 * and its route summary.
 */
@Injectable()
export class MyOrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly routes: OrderRouteReader,
    private readonly progress: WorkItemProgressService,
  ) {}

  /** The page's deadline for ORD-3's progress calls (a property so tests can shorten it). */
  progressDeadlineMs = OWN_PROGRESS_PAGE_DEADLINE_MS;

  async list(context: DataAccessContext, query: MyOrdersQueryDto, now: Date = new Date()): Promise<MyOrdersPage> {
    const kinds = this.kinds(context, query.kind ?? 'all');
    const today = lagosDay(now);
    // A later page keeps the first page's day: the default moves at Lagos
    // midnight, and an explicit day must be the cursor's.
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (cursor && query.since !== undefined && query.since !== cursor.since) throw invalidCursor();
    const since = query.since ?? cursor?.since ?? addDays(today, -90);
    if (!isCalendarDay(since) || since > today) throw sinceInvalid();
    if (since < addYears(today, -2)) throw new DomainProblem(400, 'MY_ORDERS_SINCE_TOO_OLD', MY_ORDERS_MESSAGES.sinceTooOld);
    const openOnly = query.state === 'open';
    const scope = cursorScope(context, kinds, openOnly, since);
    if (cursor && cursor.scope !== scope) throw invalidCursor();
    const limit = query.limit ?? 25;

    let rows: MyOrderRow[];
    let routes: RouteSummaries;
    try {
      ({ rows, routes } = await this.database.withTransaction(context, async (client: PoolClient) => {
        const found = (await client.query<MyOrderRow>(MY_ORDERS_SQL, [kinds, openOnly, since, cursor?.at ?? null,
          cursor?.kind ?? null, cursor?.id ?? null, limit])).rows;
        return { rows: found, routes: await this.routeSummaries(client, context, found) };
      }));
    } catch (error) {
      throw translate(error);
    }
    const listed = rows.filter((row): row is MyOrderRow & { kind: OrderKind; order_id: string; patient_id: string } =>
      row.kind !== null && row.order_id !== null && row.patient_id !== null);
    const progress = await this.ownProgress(context, listed);
    const first = rows[0];
    const hiddenCount = cursor ? cursor.hidden : Number(first?.hidden_count ?? 0);
    const hiddenCountComplete = cursor ? cursor.complete : first?.hidden_count_complete !== false;
    return {
      items: listed.map((row) => ({
        kind: row.kind,
        orderId: row.order_id,
        encounterId: String(row.encounter_id),
        patient: { patientId: row.patient_id, fullName: String(row.full_name), sex: row.sex ?? null,
          dateOfBirth: row.date_of_birth ?? null, healthIdLast4: row.health_id_last4 ?? null },
        display: String(row.display),
        status: String(row.status),
        priority: row.priority ?? null,
        createdAt: new Date(row.created_at as Date).toISOString(),
        updatedAt: new Date(row.updated_at as Date).toISOString(),
        ownProgress: progress.get(row.order_id)!,
        ...(routes.unread.has(row.order_id) ? {} : { orderRoute: routes.found.get(row.order_id) ?? null }),
      })),
      hiddenCount,
      hiddenCountComplete,
      since,
      nextCursor: first?.has_more === true && first.resume_at && first.resume_kind && first.resume_id
        ? encodeCursor({ scope, at: first.resume_at, kind: first.resume_kind, id: first.resume_id, since,
          hidden: hiddenCount, complete: hiddenCountComplete })
        : null,
    };
  }

  /** The kinds this member may list: 403 for none, or for a kind asked without its read permission. */
  private kinds(context: DataAccessContext, kind: 'all' | 'lab' | 'prescription'): OrderKind[] {
    const permissions = new Set(context.actor.permissions ?? []);
    const lab = permissions.has('ehr.lab-request.read');
    const prescription = permissions.has('ehr.prescription.read');
    const allowed: OrderKind[] = kind === 'lab' ? (lab ? ['lab_request'] : [])
      : kind === 'prescription' ? (prescription ? ['prescription'] : [])
        : [...(lab ? ['lab_request' as const] : []), ...(prescription ? ['prescription' as const] : [])];
    if (allowed.length === 0) throw new DomainProblem(403, 'PERMISSION_DENIED', MY_ORDERS_MESSAGES.noPermission);
    return allowed;
  }

  /**
   * Each listed order's route summary (sections 21-24), read in the list's
   * transaction. The orders of a group that could not be read are in
   * `unread`, so their orderRoute is left out rather than shown as "no route".
   */
  private async routeSummaries(client: PoolClient, context: DataAccessContext, rows: MyOrderRow[]): Promise<RouteSummaries> {
    const found = new Map<string, unknown>();
    const unread = new Set<string>();
    for (const [key, ids] of groups(rows)) {
      const [kind, patientId] = key.split('|') as [OrderKind, string];
      const summaries = await this.routes.summaries(client, context, kind, patientId, ids);
      if (summaries === undefined) {
        for (const id of ids) unread.add(id);
        continue;
      }
      for (const [id, summary] of summaries) found.set(id, summary);
    }
    return { found, unread };
  }

  /**
   * ORD-3's own lab or pharmacy progress for the page (decision 4): one call
   * per kind with ORD-3's several-patient form, both kinds at once. The page
   * passes one OwnProgressSlots to both, so against an image without that
   * form (the client then asks once per patient) the page makes at most 6
   * one-patient calls at once across both kinds. Each order's progress is
   * kept as soon as the client knows it (onAnswer): a draft at once, each
   * patient as its answer is read. At the page's deadline its signal aborts,
   * which ends both calls in the client, and only what has not answered by
   * then is unknown, patient by patient, as with the one-patient calls before
   * decision 4 (one slow patient on the fallback leaves the others answered).
   * Never throws.
   */
  private async ownProgress(context: DataAccessContext, rows: Array<MyOrderRow & { kind: OrderKind; order_id: string }>) {
    const out = new Map<string, LabOwnProgress | PharmacyOwnProgress>();
    const byKind = { lab_request: new Map<string, OrderItem[]>(), prescription: new Map<string, OrderItem[]>() };
    for (const row of rows) {
      const patients = byKind[row.kind];
      const patientId = String(row.patient_id);
      patients.set(patientId, [...(patients.get(patientId) ?? []), { id: row.order_id, status: String(row.status) }]);
    }
    const patientsOf = (kind: OrderKind): PatientOrders[] => [...byKind[kind]].map(([patientId, items]) => ({ patientId, items }));
    const page = new AbortController();
    // One limit for the page's one-patient calls (the fallback), across both kinds; made per page, never kept.
    const slots = new OwnProgressSlots();
    let open = true;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        page.abort();
        resolve();
      }, this.progressDeadlineMs);
      timer.unref?.();
    });
    // Each answer as the client reads it, until the deadline; nothing after it.
    const keep = (id: string, value: LabOwnProgress | PharmacyOwnProgress) => {
      if (open) out.set(id, value);
    };
    const ask = async (kind: OrderKind) => {
      if (byKind[kind].size === 0) return;
      let found: Map<string, LabOwnProgress | PharmacyOwnProgress>;
      try {
        found = kind === 'lab_request'
          ? await this.progress.labForPatients(context, patientsOf(kind), { signal: page.signal, slots, onAnswer: keep })
          : await this.progress.pharmacyForPatients(context, patientsOf(kind), { signal: page.signal, slots,
            onAnswer: keep });
      } catch {
        return;
      }
      for (const [id, value] of found) keep(id, value);
    };
    await Promise.race([Promise.all([ask('prescription'), ask('lab_request')]), deadline]);
    open = false;
    clearTimeout(timer);
    for (const row of rows) {
      if (!out.has(row.order_id)) out.set(row.order_id, row.kind === 'lab_request' ? LAB_PROGRESS_UNKNOWN : PHARMACY_PROGRESS_UNKNOWN);
    }
    return out;
  }
}

interface RouteSummaries {
  found: Map<string, unknown>;
  unread: Set<string>;
}

function groups(rows: MyOrderRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.kind || !row.order_id || !row.patient_id) continue;
    const key = `${row.kind}|${row.patient_id}`;
    out.set(key, [...(out.get(key) ?? []), row.order_id]);
  }
  return out;
}

function isCalendarDay(value: string): boolean {
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

/** A cursor is valid only for the member, facility and filters (the day included) it was issued with. */
function cursorScope(context: DataAccessContext, kinds: OrderKind[], openOnly: boolean, since: string): string {
  return createHash('sha256').update(JSON.stringify(['ehr.my-orders', context.membershipId, context.facilityId,
    [...kinds].sort(), openOnly, since]), 'utf8').digest('base64url').slice(0, 22);
}

/**
 * Where the next page resumes, the first page's day, and the first page's
 * hidden count (which later pages do not recount).
 */
interface MyOrdersCursor {
  scope: string;
  at: string;
  kind: OrderKind;
  id: string;
  since: string;
  hidden: number;
  complete: boolean;
}

function encodeCursor(cursor: MyOrdersCursor): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, f: cursor.scope, t: cursor.at, k: cursor.kind, i: cursor.id,
    s: cursor.since, h: cursor.hidden, c: cursor.complete }), 'utf8').toString('base64url');
}

function decodeCursor(value: string): MyOrdersCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw invalidCursor();
  const { v, f, t, k, i, s, h, c } = decoded as Record<string, unknown>;
  if (v !== CURSOR_VERSION || typeof f !== 'string' || typeof t !== 'string' || !CURSOR_TIME.test(t)
    || (k !== 'lab_request' && k !== 'prescription') || typeof i !== 'string' || !UUID.test(i)
    || typeof s !== 'string' || !isCalendarDay(s) || typeof h !== 'number' || !Number.isSafeInteger(h) || h < 0
    || typeof c !== 'boolean') {
    throw invalidCursor();
  }
  const cursor: MyOrdersCursor = { scope: f, at: t, kind: k, id: i, since: s, hidden: h, complete: c };
  // Only the exact issued encoding is accepted.
  if (encodeCursor(cursor) !== value) throw invalidCursor();
  return cursor;
}

function invalidCursor(): DomainProblem {
  return new DomainProblem(400, 'INVALID_CURSOR', MY_ORDERS_MESSAGES.invalidCursor);
}

function sinceInvalid(): DomainProblem {
  return new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
    [{ field: 'since', messages: ['since must be a past or present day, YYYY-MM-DD'] }]);
}

/** The definer's refusals, in the contract's words; anything else is 503. */
export function translate(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if (code === '42501' && message === 'MY_ORDERS_NOT_PERMITTED') {
    return new DomainProblem(403, 'PERMISSION_DENIED', MY_ORDERS_MESSAGES.noPermission);
  }
  if (code === '22023' && message === 'MY_ORDERS_DIRECT_CARE_ONLY') {
    return new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'X-Purpose-Of-Use must be direct-care for this list');
  }
  if (code === '22023' && message === 'MY_ORDERS_SINCE_TOO_OLD') {
    return new DomainProblem(400, 'MY_ORDERS_SINCE_TOO_OLD', MY_ORDERS_MESSAGES.sinceTooOld);
  }
  // A day after the database's today (the two clocks either side of Lagos midnight).
  if (code === '22023' && message === 'MY_ORDERS_SINCE_INVALID') return sinceInvalid();
  if (code === '22023' && message === 'MY_ORDERS_CURSOR_INVALID') return invalidCursor();
  // A schema without 0143 (42883) or any other failure: the list is not available.
  return new DomainProblem(503, 'MY_ORDERS_UNAVAILABLE', MY_ORDERS_MESSAGES.unavailable);
}
