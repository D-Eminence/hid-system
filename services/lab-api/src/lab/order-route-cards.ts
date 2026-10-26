import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';

/** C12 takes at most 200 work items (SPEC-FINAL §8.7). */
export const CARD_BATCH = 200;

export interface OrderRouteCardRow {
  work_item_id: string;
  route_id: string;
  reference: string | null;
  effective_state: string;
  access: string;
  ordering_facility_name: string | null;
  orderer_name: string | null;
  orderer_licence_body: string | null;
  orderer_licence_number: string | null;
  patient_full_name: string | null;
  patient_sex: string | null;
  patient_date_of_birth: string | Date | null;
  patient_health_id_last4: string | null;
  /** The route's version (item 3, 0088): the wrong-patient report's expectedVersion. node-postgres answers bigint as text. */
  row_version: string | number;
  /** How the route ended: null while it is live; 'wrong_patient', 'support', 'order_changed', ... (0088). */
  ended_kind: string | null;
}

/**
 * What a route-backed work row shows of its route (SPEC-FINAL §10.2; item 3
 * adds version and endedKind). The list around the rows may also say whether
 * this facility receives lab requests from other facilities and whether any
 * wait or are held here (item 4, `ReceivingFacts`).
 */
export interface WorkItemOrderRoute {
  id: string;
  reference: string | null;
  effectiveState: string;
  access: 'work' | 'read' | 'none';
  version: number;
  endedKind: string | null;
  orderingFacilityName: string | null;
  ordererName: string | null;
  ordererLicence?: { body: string; number: string | null };
}

/** The patient of a route-backed work row, only while the route allows a read (P10.5). */
export interface WorkItemRoutePatient {
  fullName: string;
  sex: string | null;
  dateOfBirth: string | null;
  healthIdLast4: string | null;
}

export interface OrderRouteCard { orderRoute: WorkItemOrderRoute; patient?: WorkItemRoutePatient }

/** Whether the two P4c controls are on, for the page's banners (FEAS R4). */
export interface CrossFacilityFlags { crossFacilityOrders: boolean; crossFacilityWork: boolean }

/**
 * Whether lab requests from other facilities wait here (sent, before their
 * respond-by) or are held here (accepted, completed or cancelled, while this
 * facility may still read them): item 4, D4. Booleans only.
 */
export interface RoutesHere { waiting: boolean; held: boolean }

/**
 * What the work list and Incoming say about this facility as a receiver
 * (item 4, 0089): `receives` is whether clinicians at other facilities can
 * send it lab requests now (H4, whatever the switches say), `routesHere`
 * whether any wait or are held here. Each is left out when it was not read.
 */
export interface ReceivingFacts { receives?: boolean; routesHere?: RoutesHere }

/** The permission the database answers `receiving` to (NULL to anyone else). */
const RECEIVE_PERMISSION = 'lab.order-route.receive';

const ACCESS = new Set(['work', 'read', 'none']);

/** A `date` as yyyy-mm-dd (C12 casts it to text; a Date is read by its local calendar fields, as node-postgres makes it). */
function day(value: string | Date | null): string | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return value;
}

/** A C12 row as the work list shows it. */
export function orderRouteCard(row: OrderRouteCardRow): OrderRouteCard {
  const access = ACCESS.has(row.access) ? row.access as WorkItemOrderRoute['access'] : 'none';
  const orderRoute: WorkItemOrderRoute = {
    id: row.route_id,
    reference: row.reference,
    effectiveState: row.effective_state,
    access,
    // A number, as the website checks it (B9), whatever node-postgres made of the bigint.
    version: Number(row.row_version),
    endedKind: row.ended_kind ?? null,
    orderingFacilityName: row.ordering_facility_name,
    ordererName: row.orderer_name,
    ...(row.orderer_licence_body
      ? { ordererLicence: { body: row.orderer_licence_body, number: row.orderer_licence_number ?? null } } : {}),
  };
  // C12 gives the patient only when the route allows a read now; the card is
  // left without one otherwise, whatever else the row carries.
  const patient = row.patient_full_name && access !== 'none'
    ? { patient: { fullName: row.patient_full_name, sex: row.patient_sex, dateOfBirth: day(row.patient_date_of_birth),
      healthIdLast4: row.patient_health_id_last4 } }
    : {};
  return { orderRoute, ...patient };
}

/**
 * The receiving facts as the answer carries them: each only when the
 * database gave it with the right type (an older schema, or a member the
 * database answers NULL to, gives nothing); never a made-up false.
 */
export function receivingFacts(row: { receives?: unknown; routes_here?: unknown } | undefined): ReceivingFacts {
  const routes = jsonObject(row?.routes_here);
  return {
    ...(typeof row?.receives === 'boolean' ? { receives: row.receives } : {}),
    ...(routes && typeof routes.waiting === 'boolean' && typeof routes.held === 'boolean'
      ? { routesHere: { waiting: routes.waiting, held: routes.held } } : {}),
  };
}

/** A jsonb value as an object (node-postgres parses jsonb; text is parsed here). */
function jsonObject(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown; } catch { return undefined; }
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

/**
 * The route cards of route-backed work items (C12, `lab.order_route_cards`),
 * the two control flags (SPEC-FINAL §9.2), and whether this facility receives
 * lab requests from other facilities and holds any (item 4, 0089).
 */
@Injectable()
export class LabOrderRouteCards {
  private readonly logger = new Logger(LabOrderRouteCards.name);

  constructor(private readonly database: DatabaseService) {}

  /**
   * C12 in the caller's transaction, in a savepoint: a failure leaves the rows
   * without cards (no route identity, no patient), never fails the list.
   */
  async cards(client: PoolClient, workItemIds: readonly string[], correlationId: string): Promise<Map<string, OrderRouteCard>> {
    const found = new Map<string, OrderRouteCard>();
    if (workItemIds.length === 0) return found;
    await client.query('savepoint lab_order_route_cards');
    try {
      for (let start = 0; start < workItemIds.length; start += CARD_BATCH) {
        const result = await client.query<OrderRouteCardRow>(
          `select work_item_id::text as work_item_id, route_id::text as route_id, reference, effective_state, access,
                  ordering_facility_name, orderer_name, orderer_licence_body, orderer_licence_number,
                  patient_full_name, patient_sex, patient_date_of_birth::text as patient_date_of_birth,
                  patient_health_id_last4, row_version, ended_kind
             from lab.order_route_cards($1::uuid[])`,
          [workItemIds.slice(start, start + CARD_BATCH)],
        );
        for (const row of result.rows) found.set(row.work_item_id, orderRouteCard(row));
      }
      await client.query('release savepoint lab_order_route_cards');
    } catch (error) {
      await client.query('rollback to savepoint lab_order_route_cards');
      this.logger.warn({ message: 'Order route cards could not be read', sqlState: sqlState(error), correlationId });
      return new Map();
    }
    return found;
  }

  /**
   * Item 4 (0089): whether this facility receives lab requests from other
   * facilities now, and whether any wait or are held here, for a member
   * holding `lab.order-route.receive`; nothing for anyone else (no statement:
   * the database would answer NULL). Both functions are bound to the session
   * (no facility argument) as the cards are. One statement in the caller's
   * transaction, after its audit row, in a savepoint: a failure (a schema
   * without 0089, a facility no longer active) leaves both out and never
   * fails the list. Booleans only: no patient, count or reference, so the
   * list's audit rows stay as they are.
   */
  async receiving(client: PoolClient, context: DataAccessContext): Promise<ReceivingFacts> {
    if (!context.actor.permissions.includes(RECEIVE_PERMISSION)) return {};
    await client.query('savepoint lab_order_route_receives');
    try {
      const result = await client.query<{ receives: unknown; routes_here: unknown }>(
        'select lab.order_route_receives_here() as receives, lab.order_routes_here() as routes_here');
      await client.query('release savepoint lab_order_route_receives');
      return receivingFacts(result.rows[0]);
    } catch (error) {
      await client.query('rollback to savepoint lab_order_route_receives');
      this.logger.warn({ message: 'Whether this facility receives orders could not be read', sqlState: sqlState(error),
        correlationId: context.correlationId });
      return {};
    }
  }

  /**
   * The two P4c controls, read with a pool statement after (never inside)
   * the clinical transaction (V11). Off when they cannot be read.
   */
  async flags(): Promise<CrossFacilityFlags> {
    try {
      const result = await this.database.query<{ orders: boolean; work: boolean }>(
        `select platform.control_enabled('cross_facility_orders_enabled') as orders,
                platform.control_enabled('cross_facility_route_access_enabled') as work`);
      const row = result.rows[0];
      return { crossFacilityOrders: row?.orders === true, crossFacilityWork: row?.work === true };
    } catch {
      return { crossFacilityOrders: false, crossFacilityWork: false };
    }
  }
}

function sqlState(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}
