import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { IdentityService } from '../identity/identity.service';
import { OWN_WORK_OFF, PharmacyOwnWork } from './own-work-access';

/** The resources a Pharmacy command acts on, as C17 derives their work item (SPEC-FINAL §8.7, PRIV P12). */
export type PharmacyRouteResource = 'work_item' | 'dispensing';

export type RecordAction = 'read_records' | 'write_records';

/**
 * Why the command may act: the member's consent (Identity, as before P4c),
 * the work item's order route, or (0133) this facility's own work item, on
 * which the facility's pharmacy staff work without a personal grant.
 */
export type ResourceBasis = { basis: 'consent' } | { basis: 'order-route'; orderRouteId: string }
  | { basis: 'own-work' };

interface AccessRow { outcome: string; route_id: string | null; work_item_id: string | null }

export const orderRouteClosed = () => new DomainProblem(409, 'ORDER_ROUTE_CLOSED',
  'This prescription from another facility is closed: stop work on it');

export const crossFacilityWorkPaused = () => new DomainProblem(423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE',
  'Work on orders from other facilities is paused by Health ID');

/**
 * The audit details a route-backed command adds to its row (SPEC-FINAL §12),
 * and (0133) `basis: 'own-work'` for this facility's own work done by its
 * pharmacy staff without a personal grant. A consent-based row is unchanged.
 */
export function basisDetails(basis: ResourceBasis): Record<string, string> {
  if (basis.basis === 'order-route') return { basis: 'order-route', orderRouteId: basis.orderRouteId };
  return basis.basis === 'own-work' ? { basis: 'own-work' } : {};
}

/**
 * Authorizes a Pharmacy command on the resource it acts on, inside its
 * transaction (SPEC-FINAL §4.3, §9.3, PRIV P12): C17
 * (`pharmacy.order_route_access_for`) derives the work item in the database.
 * `allowed` goes on on the route's basis without Identity; `closed` is 409
 * ORDER_ROUTE_CLOSED; `paused` is 423; `none` is, first (0133), this
 * facility's own work item for its pharmacy staff (`pharmacy.own_work_access_for`,
 * basis 'own-work', no Identity call), else Identity's consent decision as
 * before, refused 403 PHARMACY_ACCESS_DENIED (break-glass never writes).
 * A database error from C17 is passed on unchanged, so a serialization
 * failure reaches DatabaseService's retry.
 */
@Injectable()
export class PharmacyOrderRouteAccess {
  constructor(private readonly identity: IdentityService,
    private readonly ownWork: PharmacyOwnWork = OWN_WORK_OFF) {}

  async authorize(client: PoolClient, context: DataAccessContext, resource: PharmacyRouteResource, resourceId: string,
    patientId: string, action: RecordAction): Promise<ResourceBasis> {
    const result = await client.query<AccessRow>(
      `select outcome, route_id::text as route_id, work_item_id::text as work_item_id
         from pharmacy.order_route_access_for($1, $2, $3)`,
      [resource, resourceId, action],
    );
    const access = result.rows[0] ?? { outcome: 'none', route_id: null, work_item_id: null };
    switch (access.outcome) {
      case 'allowed':
        if (!access.route_id) throw unexpected();
        return { basis: 'order-route', orderRouteId: access.route_id };
      case 'closed':
        throw orderRouteClosed();
      case 'paused':
        throw crossFacilityWorkPaused();
      case 'none': {
        if (await this.ownWork.allows(client, resource, resourceId, action, context.correlationId)) {
          return { basis: 'own-work' };
        }
        const decision = await this.identity.authorize(patientId, action, context);
        if (!decision.allowed || (action === 'write_records' && decision.breakGlass)) {
          throw new DomainProblem(403, 'PHARMACY_ACCESS_DENIED',
            action === 'write_records' && decision.breakGlass
              ? 'Break-glass authorization cannot mutate Pharmacy records'
              : 'Pharmacy access is not authorized');
        }
        return { basis: 'consent' };
      }
      default:
        throw unexpected();
    }
  }

  /**
   * The answer for a work item this session cannot see. A route-backed item at
   * this facility is hidden by the strict policy once its route stops allowing
   * the action; C17 finds it through its route, so the member is told why: work
   * on routes is paused (423) or the route is closed (409). Anything else is
   * the command's own not-found answer.
   */
  async hiddenWorkItem(client: PoolClient, workItemId: string, action: RecordAction, notFound: () => DomainProblem):
  Promise<never> {
    const result = await client.query<AccessRow>(
      `select outcome, route_id::text as route_id, work_item_id::text as work_item_id
         from pharmacy.order_route_access_for('work_item', $1, $2)`,
      [workItemId, action],
    );
    const outcome = result.rows[0]?.outcome;
    if (outcome === 'paused') throw crossFacilityWorkPaused();
    if (outcome === 'closed') throw orderRouteClosed();
    throw notFound();
  }
}

function unexpected() {
  return new DomainProblem(503, 'ORDER_ROUTE_UNAVAILABLE', 'The order route could not be checked');
}
