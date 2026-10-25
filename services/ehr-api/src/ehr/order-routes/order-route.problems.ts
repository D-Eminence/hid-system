import { DomainProblem } from '../../common/problem';

/**
 * How the EHR answers the order-route commands' refusals (SPEC-FINAL §8.7
 * conventions, §9.1, §11). Business refusals are P0001 with the API code as
 * the message; each is answered by that exact code with a fixed detail, never
 * the database's text. An unknown P0001 is 503 ORDER_ROUTE_UNAVAILABLE.
 */
const P0001_REFUSALS: Readonly<Record<string, readonly [number, string]>> = Object.freeze({
  ORDER_ROUTE_DESTINATION_INELIGIBLE: [409, 'That facility cannot receive this order on Health ID'],
  ORDER_ROUTE_ORDER_NOT_ELIGIBLE: [409, 'Only a draft or active order can be sent to another facility'],
  ORDER_ROUTE_ORDER_IN_WORK: [409, 'This order is already being worked on'],
  ORDER_ROUTE_ALREADY_SENT: [409, 'This order has already been sent to another facility'],
  ORDER_ROUTE_RESEND_LIMIT: [409, 'This order has been sent the most times allowed'],
  ORDER_ROUTE_DESTINATION_BUSY: [409, 'That facility has too many orders waiting'],
  ORDER_ROUTE_PATIENT_DENIED: [409, 'The patient does not allow this facility to receive their records'],
  ORDER_ROUTE_PATIENT_APP_REQUIRED: [409, 'The patient needs an active Health ID account to be told where the order goes'],
  ORDER_ROUTE_ATTESTATION_OUTDATED: [409, 'The confirmation wording changed; read it again and confirm'],
  ORDER_ROUTE_NOT_PENDING: [409, 'This order route is no longer waiting for acceptance'],
  ORDER_ROUTE_EXPIRED: [409, 'This order route has expired'],
  IDEMPOTENCY_KEY_REUSED: [409, 'Idempotency-Key was already used with a different request'],
  ORDER_ROUTE_SEND_LIMIT: [429, 'Too many orders sent today; try again tomorrow'],
  ORDER_ROUTE_PAIR_LIMIT: [429, 'Too many orders sent to that facility today; try again tomorrow'],
});

/** The control refusals that mean "orders between facilities are switched off" (A3). */
export function isCrossFacilityControlRefusal(code: unknown, message: string): boolean {
  if (code === '55000') {
    return message === 'PLATFORM_CONTROL_UNAVAILABLE'
      || message === 'PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled'
      || message === 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled';
  }
  // platform.control_enabled raises 22023 for a key it does not know: the
  // migration that adds the P4c keys is not applied, so orders are closed.
  return code === '22023' && message === 'PLATFORM_CONTROL_INVALID';
}

export type OrderRouteScope = 'staff' | 'patient';

export interface DatabaseErrorShape { code?: unknown; message?: unknown }

function databaseError(error: unknown): DatabaseErrorShape | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as DatabaseErrorShape).code === 'string'
    ? error as DatabaseErrorShape : undefined;
}

export const crossFacilityUnavailable = () => new DomainProblem(423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE',
  'Orders between facilities are paused on Health ID');

export const orderRouteUnavailable = () => new DomainProblem(503, 'ORDER_ROUTE_UNAVAILABLE',
  'The order route could not be completed');

/**
 * The problem for an error from an order-route command. `notFound` names the
 * 404 code for P0002 when the message is not one (C1 raises ORDER_NOT_FOUND;
 * a route command answers ORDER_ROUTE_NOT_FOUND).
 */
export function orderRouteProblem(error: unknown, scope: OrderRouteScope,
  notFound: 'ORDER_NOT_FOUND' | 'ORDER_ROUTE_NOT_FOUND' = 'ORDER_ROUTE_NOT_FOUND'): unknown {
  if (error instanceof DomainProblem) return error;
  const database = databaseError(error);
  if (!database) return error;
  const message = typeof database.message === 'string' ? database.message : '';
  if (isCrossFacilityControlRefusal(database.code, message)) return crossFacilityUnavailable();
  switch (database.code) {
    case '42501':
      return scope === 'patient'
        ? new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required')
        : new DomainProblem(403, 'PERMISSION_DENIED', 'Sending orders to other facilities is not permitted here');
    case '22023':
      return new DomainProblem(400, 'ORDER_ROUTE_INVALID', 'The order route request is invalid');
    case 'P0002':
      return message === 'ORDER_NOT_FOUND' || message === 'ORDER_ROUTE_NOT_FOUND'
        ? new DomainProblem(404, message, message === 'ORDER_NOT_FOUND' ? 'The order was not found' : 'The order route was not found')
        : new DomainProblem(404, notFound, notFound === 'ORDER_NOT_FOUND' ? 'The order was not found' : 'The order route was not found');
    case 'P0001': {
      if (message === 'ORDER_ROUTE_VERSION_CONFLICT') {
        return new DomainProblem(412, 'VERSION_CONFLICT', 'The order route changed; reload it');
      }
      const refusal = P0001_REFUSALS[message];
      return refusal ? new DomainProblem(refusal[0], message, refusal[1]) : orderRouteUnavailable();
    }
    default:
      return orderRouteUnavailable();
  }
}
