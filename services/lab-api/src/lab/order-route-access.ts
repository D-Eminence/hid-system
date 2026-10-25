import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { IdentityService } from '../identity/identity.service';

/** The resources a Lab command acts on, as C11 derives their work item (SPEC-FINAL §8.7 C11, PRIV P12). */
export type LabRouteResource = 'work_item' | 'accession' | 'specimen' | 'execution' | 'result';

export type RecordAction = 'read_records' | 'write_records';

/**
 * Why the command may act on the resource: the member's consent grant
 * (Identity, as before P4c), or the cross-facility order route that the
 * resource's work item is bound to.
 */
export type ResourceBasis = { basis: 'consent' } | { basis: 'order-route'; orderRouteId: string };

interface AccessRow {
  outcome: string;
  route_id: string | null;
  work_item_id: string | null;
}

export const orderRouteClosed = () => new DomainProblem(409, 'ORDER_ROUTE_CLOSED',
  'This order from another facility is closed: stop work on it');

export const crossFacilityWorkPaused = () => new DomainProblem(423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE',
  'Work on orders from other facilities is paused by Health ID');

/**
 * The audit details a route-backed command adds to its row (SPEC-FINAL §12):
 * `basis: 'order-route'` and the route's id. A consent-based row is unchanged.
 */
export function basisDetails(basis: ResourceBasis): Record<string, string> {
  return basis.basis === 'order-route' ? { basis: 'order-route', orderRouteId: basis.orderRouteId } : {};
}

/**
 * Authorizes a Lab command on the resource it acts on (SPEC-FINAL §4.3, §9.2,
 * PRIV P12), inside the command's transaction. The database derives the
 * resource's work item (C11, `lab.order_route_access_for`), so a route for
 * patient P at this facility never lets a member act on another of P's rows:
 *
 * - `allowed`: the work item is bound to a route that allows the action now;
 *   the command goes on on the route's basis, and Identity is not asked.
 * - `closed`: a write on a cancelled route, or on an accepted one past its
 *   work window: 409 ORDER_ROUTE_CLOSED.
 * - `paused`: work on routes is switched off (`cross_facility_route_access_enabled`):
 *   423 CROSS_FACILITY_ORDERS_UNAVAILABLE.
 * - `none`: no route applies (a same-facility row, a read the route does not
 *   allow, or a resource not visible): Identity's consent decision as before,
 *   refused with the command's own problem.
 *
 * A database error from C11 is not mapped: a serialization failure must reach
 * DatabaseService's retry, and any other one answers 500 as every other Lab
 * database error does.
 */
@Injectable()
export class LabOrderRouteAccess {
  constructor(private readonly identity: IdentityService) {}

  async authorize(client: PoolClient, context: DataAccessContext, resource: LabRouteResource, resourceId: string,
    patientId: string, action: RecordAction, denied: () => DomainProblem): Promise<ResourceBasis> {
    const access = await this.outcome(client, resource, resourceId, action);
    switch (access.outcome) {
      case 'allowed':
        if (!access.route_id) throw unexpected();
        return { basis: 'order-route', orderRouteId: access.route_id };
      case 'closed':
        throw orderRouteClosed();
      case 'paused':
        throw crossFacilityWorkPaused();
      case 'none': {
        const decision = await this.identity.authorize(patientId, action, context.purposeOfUse, context);
        if (!decision.allowed || (action === 'write_records' && decision.breakGlass)) throw denied();
        return { basis: 'consent' };
      }
      default:
        throw unexpected();
    }
  }

  /** C11's answer for the resource. */
  async outcome(client: PoolClient, resource: LabRouteResource, resourceId: string, action: RecordAction): Promise<AccessRow> {
    const result = await client.query<AccessRow>(
      `select outcome, route_id::text as route_id, work_item_id::text as work_item_id
         from lab.order_route_access_for($1, $2, $3)`,
      [resource, resourceId, action],
    );
    return result.rows[0] ?? { outcome: 'none', route_id: null, work_item_id: null };
  }
}

function unexpected() {
  return new DomainProblem(503, 'ORDER_ROUTE_UNAVAILABLE', 'The order route could not be checked');
}
