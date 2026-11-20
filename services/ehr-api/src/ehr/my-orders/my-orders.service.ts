import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { type LabOwnProgress, type PharmacyOwnProgress, WorkItemProgressService } from '../../integrations/work-item-progress.service';
import { OrderRouteReader } from '../order-routes/order-route-reader';
import type { MyOrdersQueryDto } from './my-orders.dto';

/** MY-1: the list's one SQL call (0143's definer), with each row's exact cursor time. */
export const MY_ORDERS_SQL = `select kind, order_id::text, encounter_id::text, patient_id::text, full_name, sex,
       date_of_birth::text as date_of_birth, health_id_last4, display, status, priority, created_at, updated_at,
       hidden_count, has_more,
       to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
  from ehr.list_my_orders($1::text[], $2, $3::date, $4::timestamptz, $5, $6::uuid, $7)`;

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
  has_more: boolean | null;
  cursor_at: string | null;
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
  orderRoute: unknown;
}

export interface MyOrdersPage {
  items: MyOrderItem[];
  hiddenCount: number;
  since: string;
  nextCursor: string | null;
}

export const MY_ORDERS_MESSAGES = {
  sinceTooOld: 'You can look back up to 2 years. Choose a later date.',
  unavailable: 'Your orders cannot be listed right now. Please try again.',
  noPermission: 'Required permission is missing',
  invalidCursor: 'Pagination cursor is invalid',
} as const;

const CURSOR_VERSION = 1;
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

function addYears(day: string, years: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year + years, month - 1, date, 12));
  return at.toISOString().slice(0, 10);
}

/**
 * MY-1 (0143): "Ordered by me". The database decides what this member may
 * see now (ehr.list_my_orders, the session's own direct-care rule per
 * patient) and audits the list and each patient shown; this adds each
 * order's own lab or pharmacy progress (ORD-3, one call per patient and kind
 * on the page, audited there) and its route summary.
 */
@Injectable()
export class MyOrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly routes: OrderRouteReader,
    private readonly progress: WorkItemProgressService,
  ) {}

  async list(context: DataAccessContext, query: MyOrdersQueryDto, now: Date = new Date()): Promise<MyOrdersPage> {
    const kinds = this.kinds(context, query.kind ?? 'all');
    const today = lagosDay(now);
    const since = query.since ?? addDays(today, -90);
    if (!isCalendarDay(since) || since > today) {
      throw new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        [{ field: 'since', messages: ['since must be a past or present day, YYYY-MM-DD'] }]);
    }
    if (since < addYears(today, -2)) throw new DomainProblem(400, 'MY_ORDERS_SINCE_TOO_OLD', MY_ORDERS_MESSAGES.sinceTooOld);
    const openOnly = query.state === 'open';
    const scope = cursorScope(context, kinds, openOnly, since);
    const cursor = query.cursor ? decodeCursor(query.cursor, scope) : undefined;
    const limit = query.limit ?? 25;

    let rows: MyOrderRow[];
    let routes: Map<string, unknown>;
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
    const last = listed.at(-1);
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
        orderRoute: routes.get(row.order_id) ?? null,
      })),
      hiddenCount: Number(rows[0]?.hidden_count ?? 0),
      since,
      nextCursor: rows[0]?.has_more === true && last?.cursor_at
        ? encodeCursor(scope, { at: last.cursor_at, kind: last.kind, id: last.order_id }) : null,
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

  /** Each listed order's route summary (sections 21-24), read in the list's transaction; none on any failure. */
  private async routeSummaries(client: PoolClient, context: DataAccessContext, rows: MyOrderRow[]): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    for (const [key, ids] of groups(rows)) {
      const [kind, patientId] = key.split('|') as [OrderKind, string];
      const found = await this.routes.summaries(client, context, kind, patientId, ids);
      for (const [id, summary] of found ?? []) out.set(id, summary);
    }
    return out;
  }

  /** ORD-3's own lab or pharmacy progress, one call per patient and kind on the page. Never throws. */
  private async ownProgress(context: DataAccessContext, rows: Array<MyOrderRow & { kind: OrderKind; order_id: string }>) {
    const out = new Map<string, LabOwnProgress | PharmacyOwnProgress>();
    const byKey = new Map<string, Array<{ id: string; status: string }>>();
    for (const row of rows) {
      const key = `${row.kind}|${row.patient_id}`;
      byKey.set(key, [...(byKey.get(key) ?? []), { id: row.order_id, status: String(row.status) }]);
    }
    for (const [key, items] of byKey) {
      const [kind, patientId] = key.split('|') as [OrderKind, string];
      const found = kind === 'lab_request'
        ? await this.progress.lab(context, patientId, items)
        : await this.progress.pharmacy(context, patientId, items);
      for (const [id, value] of found) out.set(id, value);
    }
    return out;
  }
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

/** A cursor is valid only for the member, facility and filters it was issued with. */
function cursorScope(context: DataAccessContext, kinds: OrderKind[], openOnly: boolean, since: string): string {
  return createHash('sha256').update(JSON.stringify(['ehr.my-orders', context.membershipId, context.facilityId,
    [...kinds].sort(), openOnly, since]), 'utf8').digest('base64url').slice(0, 22);
}

function encodeCursor(scope: string, position: { at: string; kind: OrderKind; id: string }): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, f: scope, t: position.at, k: position.kind, i: position.id }),
    'utf8').toString('base64url');
}

function decodeCursor(value: string, scope: string): { at: string; kind: OrderKind; id: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw invalidCursor();
  const { v, f, t, k, i } = decoded as Record<string, unknown>;
  if (v !== CURSOR_VERSION || f !== scope || typeof t !== 'string' || !CURSOR_TIME.test(t)
    || (k !== 'lab_request' && k !== 'prescription') || typeof i !== 'string' || !UUID.test(i)) {
    throw invalidCursor();
  }
  const position = { at: t, kind: k, id: i } as const;
  // Only the exact issued encoding is accepted.
  if (encodeCursor(scope, position) !== value) throw invalidCursor();
  return position;
}

function invalidCursor(): DomainProblem {
  return new DomainProblem(400, 'INVALID_CURSOR', MY_ORDERS_MESSAGES.invalidCursor);
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
  if (code === '22023' && message === 'MY_ORDERS_CURSOR_INVALID') return invalidCursor();
  // A schema without 0143 (42883) or any other failure: the list is not available.
  return new DomainProblem(503, 'MY_ORDERS_UNAVAILABLE', MY_ORDERS_MESSAGES.unavailable);
}
