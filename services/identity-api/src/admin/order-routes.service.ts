import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { PlatformAdminContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';

const REFERENCE = /^[0-9A-F]{8}$/;
const HEALTH_ID = /^HID-[A-HJ-NP-Z2-9]{6,32}$/;

interface FoundRouteRow extends QueryResultRow {
  route_id: string;
  reference: string;
  kind: string;
  row_version: string | number;
  effective_state: string;
  ordering_facility_id: string;
  ordering_facility_name: string;
  receiving_facility_id: string;
  receiving_facility_name: string;
  created_at: Date | string;
  accepted_at: Date | string | null;
  ended_at: Date | string | null;
  ended_kind: string | null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const lookupInvalid = () => new DomainProblem(400, 'ORDER_ROUTE_LOOKUP_INVALID',
  'Enter an order reference (8 characters) or a patient Health ID, not both');

const unavailable = () => new DomainProblem(503, 'ORDER_ROUTES_ADMIN_UNAVAILABLE',
  'Orders between facilities could not be read or changed');

/**
 * Support's tools for orders between facilities (P4c, SPEC-FINAL §8.7
 * C20-C23, §10.4): a facility's summary, listing it for orders or not,
 * finding a route and closing it. Platform transactions, so a standalone
 * platform administrator works; the commands check the permissions and write
 * their own platform and facility audit rows.
 */
@Injectable()
export class AdminOrderRoutesService {
  constructor(private readonly database: DatabaseService) {}

  /** C20: listing, lifetime counts and 30 days per counterpart; no patient, no order content. */
  async summary(context: PlatformAdminContext, facilityId: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<{ summary: unknown }>(
          'select identity.admin_order_route_summary($1) as summary', [facilityId]);
        const summary = parse(result.rows[0]?.summary);
        if (!summary) throw new DomainProblem(404, 'ADMIN_FACILITY_NOT_FOUND', 'Facility was not found');
        return { facilityId, ...summary };
      }, { readOnly: true });
    } catch (error) {
      throw adminOrderRouteProblem(error, 'facility');
    }
  }

  /** C23: list or unlist the facility for orders from other facilities; accepted work is unaffected. */
  async setDestination(context: PlatformAdminContext, facilityId: string, listed: boolean, reason: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<{ facility_id: string; listed: boolean; set_at: Date | string }>(
          `select facility_id::text as facility_id, listed, set_at
             from identity.admin_set_order_route_destination($1, $2, $3)`, [facilityId, listed, reason]);
        const row = result.rows[0];
        if (!row) throw unavailable();
        return { facilityId: row.facility_id, listed: row.listed, setAt: iso(row.set_at) };
      });
    } catch (error) {
      throw adminOrderRouteProblem(error, 'facility');
    }
  }

  /** C21: by reference (at most 5 routes) or by Health ID (at most 20), exactly one of them. */
  async find(context: PlatformAdminContext, reference: string | undefined, healthId: string | undefined) {
    const byReference = reference ? reference.toUpperCase() : null;
    const byHealthId = healthId ? healthId.toUpperCase() : null;
    if ((byReference === null) === (byHealthId === null)) throw lookupInvalid();
    if (byReference !== null && !REFERENCE.test(byReference)) throw lookupInvalid();
    if (byHealthId !== null && !HEALTH_ID.test(byHealthId)) throw lookupInvalid();
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<FoundRouteRow>(
          `select route_id::text as route_id, reference, kind, row_version, effective_state,
                  ordering_facility_id::text as ordering_facility_id, ordering_facility_name,
                  receiving_facility_id::text as receiving_facility_id, receiving_facility_name,
                  created_at, accepted_at, ended_at, ended_kind
             from identity.admin_find_order_routes($1, $2)`, [byReference, byHealthId]);
        return { items: result.rows.map((row) => ({
          routeId: row.route_id, reference: row.reference, kind: row.kind, version: Number(row.row_version),
          effectiveState: row.effective_state, orderingFacilityId: row.ordering_facility_id,
          orderingFacilityName: row.ordering_facility_name, receivingFacilityId: row.receiving_facility_id,
          receivingFacilityName: row.receiving_facility_name, createdAt: iso(row.created_at),
          acceptedAt: iso(row.accepted_at), endedAt: iso(row.ended_at), endedKind: row.ended_kind,
        })) };
      }, { readOnly: true });
    } catch (error) {
      throw adminOrderRouteProblem(error, 'lookup');
    }
  }

  /** C22: close a live route (access ends now, both facilities and the patient told). */
  async close(context: PlatformAdminContext, routeId: string, expectedVersion: number, reason: string) {
    try {
      return await this.database.withPlatformTransaction(context, async (client) => {
        const result = await client.query<{ route_id: string; row_version: string | number; state: string }>(
          `select route_id::text as route_id, row_version, state
             from identity.admin_close_order_route($1, $2, $3)`, [routeId, expectedVersion, reason]);
        const row = result.rows[0];
        if (!row) throw unavailable();
        return { routeId: row.route_id, version: Number(row.row_version), effectiveState: row.state };
      });
    } catch (error) {
      throw adminOrderRouteProblem(error, 'route');
    }
  }
}

function parse(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

/**
 * The commands' refusals (SPEC-FINAL §8.7 C20-C23, §10.4, §11), as the
 * neighbouring admin commands answer them: 42501 403 PERMISSION_DENIED, a
 * version conflict 409 VERSION_CONFLICT (P4b's admin convention, 40001).
 */
export function adminOrderRouteProblem(error: unknown, scope: 'facility' | 'lookup' | 'route'): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message : '';
  switch (code) {
    case '42501':
      return new DomainProblem(403, 'PERMISSION_DENIED', 'Administrative permission is missing');
    case 'P0002':
      return scope === 'route' ? new DomainProblem(404, 'ORDER_ROUTE_NOT_FOUND', 'The order route was not found')
        : new DomainProblem(404, 'ADMIN_FACILITY_NOT_FOUND', 'Facility was not found');
    case '22023':
      if (scope === 'lookup') return lookupInvalid();
      return new DomainProblem(400, message === 'ORDER_ROUTE_DESTINATION_INVALID' || message === 'ORDER_ROUTE_CLOSE_INVALID'
        ? message : 'ORDER_ROUTE_ADMIN_INVALID', 'The reason must be 8 to 500 characters');
    case '40001':
      return new DomainProblem(409, 'VERSION_CONFLICT', 'The order route changed; reload before retrying');
    case '23505':
      if (message === 'ORDER_ROUTE_ALREADY_CLOSED') {
        return new DomainProblem(409, 'ORDER_ROUTE_ALREADY_CLOSED', 'This order route is already closed');
      }
      if (message === 'ORDER_ROUTE_DESTINATION_UNCHANGED') {
        return new DomainProblem(409, 'ORDER_ROUTE_DESTINATION_UNCHANGED', 'The facility is already listed that way');
      }
      return unavailable();
    default:
      return unavailable();
  }
}
