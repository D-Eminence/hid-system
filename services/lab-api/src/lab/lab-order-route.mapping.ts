import { DomainProblem } from '../common/problem';

/**
 * Lab's side of cross-facility lab requests (P4c, SPEC-FINAL §10.2): the
 * shapes Lab answers, built field by field from what the commands return, so
 * nothing else a command returns (the patient's or the order's ids, staff
 * ids) ever reaches the browser (PRIV P4.3). Columns are read by name; where
 * the spec leaves a column's name open, both names are read (`id` or
 * `route_id`, `test_display` or `test_name`, `created_at` or `sent_at`).
 */
export type Row = Readonly<Record<string, unknown>>;

function field(row: Row, ...names: string[]): unknown {
  for (const name of names) if (row[name] !== undefined) return row[name];
  return undefined;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

function count(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  return null;
}

/**
 * A `date` as yyyy-mm-dd. node-postgres parses a `date` column into a Date at
 * local midnight, so the local calendar fields are the stored date whatever
 * the process's time zone (toISOString would shift it east of UTC).
 */
function day(value: unknown): string | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return text(value);
}

export interface RoutePatient { fullName: string; sex: string | null; dateOfBirth: string | null; healthIdLast4: string | null }

/** The patient card (H13 columns), only when the database gave one (identity shown after acceptance, P2). */
export function routePatient(row: Row): RoutePatient | undefined {
  const fullName = text(field(row, 'patient_full_name'));
  if (!fullName) return undefined;
  return { fullName, sex: text(field(row, 'patient_sex')), dateOfBirth: day(field(row, 'patient_date_of_birth')),
    healthIdLast4: text(field(row, 'patient_health_id_last4')) };
}

/** An Incoming row (C7 `incoming`): the preview, never the patient, clinical information or licence number. */
export function incomingLabRoute(row: Row) {
  return {
    id: text(field(row, 'route_id', 'id')),
    reference: text(field(row, 'reference')),
    version: count(field(row, 'row_version', 'version')),
    effectiveState: text(field(row, 'effective_state', 'state')),
    orderingFacilityName: text(field(row, 'ordering_facility_name')),
    orderer: { name: text(field(row, 'orderer_name')), licenceBody: text(field(row, 'orderer_licence_body')) },
    test: { codeSystem: text(field(row, 'test_code_system')), code: text(field(row, 'test_code')),
      name: text(field(row, 'test_display', 'test_name')) },
    priority: text(field(row, 'priority')),
    specimenTypeCode: text(field(row, 'specimen_type_code')),
    sentAt: iso(field(row, 'sent_at', 'created_at')),
    respondBy: iso(field(row, 'respond_by')),
    acceptLocked: field(row, 'accept_locked') === true,
    attemptsLeft: count(field(row, 'attempts_left')),
  };
}

/** A Recent row (C7 `recent`): metadata only, plus the work item and test name once accepted. */
export function recentLabRoute(row: Row) {
  return {
    id: text(field(row, 'route_id', 'id')),
    reference: text(field(row, 'reference')),
    version: count(field(row, 'row_version', 'version')),
    effectiveState: text(field(row, 'effective_state', 'state')),
    orderingFacilityName: text(field(row, 'ordering_facility_name')),
    sentAt: iso(field(row, 'sent_at', 'created_at')),
    endedAt: iso(field(row, 'ended_at')),
    workItemId: text(field(row, 'work_item_id')),
    testName: text(field(row, 'test_name', 'test_display')),
  };
}

/**
 * One route (C8): the Incoming shape, and after acceptance, while the route
 * allows a read, the clinical information, the licence number, the patient
 * card and the work item. The database decides what it gives; this never
 * adds what it did not.
 */
export function labRouteDetail(row: Row) {
  const incoming = incomingLabRoute(row);
  const patient = routePatient(row);
  const clinicalInformation = text(field(row, 'clinical_information'));
  const licenceNumber = text(field(row, 'orderer_licence_number'));
  const workItemId = text(field(row, 'work_item_id'));
  return {
    ...incoming,
    orderer: { ...incoming.orderer, ...(licenceNumber ? { licenceNumber } : {}) },
    ...(clinicalInformation !== null ? { clinicalInformation } : {}),
    ...(patient ? { patient } : {}),
    ...(workItemId ? { workItemId } : {}),
  };
}

/** P0001 refusals of C7-C10 (SPEC-FINAL §10.2, §11), each answered by its own code. */
const P0001_REFUSALS: Readonly<Record<string, readonly [number, string]>> = Object.freeze({
  ORDER_ROUTE_PATIENT_MISMATCH: [409, 'That does not match this order\'s patient'],
  ORDER_ROUTE_ACCEPT_LOCKED: [409, 'Too many wrong tries: this order cannot be accepted here'],
  ORDER_ROUTE_ORDER_IN_WORK: [409, 'This order is already being worked on'],
  ORDER_ROUTE_NOT_PENDING: [409, 'This order is no longer waiting for acceptance'],
  ORDER_ROUTE_EXPIRED: [409, 'This order was not accepted in time'],
  ORDER_ROUTE_DESTINATION_INELIGIBLE: [409, 'This facility cannot receive orders from other facilities now'],
  ORDER_ROUTE_ORDERING_FACILITY_UNAVAILABLE: [409, 'The ordering facility is not available on Health ID now'],
  ORDER_ROUTE_PATIENT_DENIED: [409, 'The patient does not allow this facility to receive their records'],
  ORDER_ROUTE_HEALTH_ID_REQUIRED: [409, 'Confirm the patient\'s Health ID: no date of birth is on record'],
  // A reference given with the date of birth that is not this order's: the
  // counter picked another row. Nothing is counted (C9).
  ORDER_ROUTE_REFERENCE_MISMATCH: [409, 'That reference is not this order\'s: ask the patient for the reference in their app'],
  IDEMPOTENCY_KEY_REUSED: [409, 'Idempotency-Key was already used with a different request'],
  ORDER_ROUTE_ACCEPT_LIMITED: [429, 'Too many wrong tries today; try again tomorrow'],
});

export const crossFacilityOrdersUnavailable = () => new DomainProblem(423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE',
  'Orders between facilities are paused on Health ID');

export const orderRouteUnavailable = (cause?: unknown) => new DomainProblem(503, 'ORDER_ROUTE_UNAVAILABLE',
  'The order route could not be completed', undefined, cause === undefined ? undefined : { cause });

/** The refusal of a result a command returns and commits (V6): the mismatch count and the lock must persist. */
export function resultRefusal(result: string, attemptsLeft: number | null): DomainProblem | undefined {
  switch (result) {
    case 'patient_mismatch':
      return new DomainProblem(409, 'ORDER_ROUTE_PATIENT_MISMATCH', 'That does not match this order\'s patient',
        undefined, { extensions: { attemptsLeft } });
    case 'accept_locked':
      return new DomainProblem(409, 'ORDER_ROUTE_ACCEPT_LOCKED', 'Too many wrong tries: this order cannot be accepted here',
        undefined, { extensions: { attemptsLeft: 0 } });
    case 'order_in_work':
      return new DomainProblem(409, 'ORDER_ROUTE_ORDER_IN_WORK', 'This order is already being worked on');
    case 'expired':
      return new DomainProblem(409, 'ORDER_ROUTE_EXPIRED', 'This order was not accepted in time');
    default:
      return undefined;
  }
}

/** True for the refusals that mean "orders between facilities are switched off" (A3). */
export function isCrossFacilityControlRefusal(code: unknown, message: string): boolean {
  if (code === '55000') {
    return message === 'PLATFORM_CONTROL_UNAVAILABLE'
      || message === 'PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled'
      || message === 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled';
  }
  return code === '22023' && message === 'PLATFORM_CONTROL_INVALID';
}

/** The problem for an error of a Lab order-route command (C7-C10). Never the database's text. */
export function labOrderRouteProblem(error: unknown): unknown {
  if (error instanceof DomainProblem) return error;
  if (typeof error !== 'object' || error === null || typeof (error as { code?: unknown }).code !== 'string') return error;
  const code = (error as { code: string }).code;
  const message = typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : '';
  if (isCrossFacilityControlRefusal(code, message)) return crossFacilityOrdersUnavailable();
  switch (code) {
    case '42501':
      return new DomainProblem(403, 'PERMISSION_DENIED', 'Receiving orders from other facilities is not permitted here',
        undefined, { cause: error });
    case '22023':
      return new DomainProblem(400, 'ORDER_ROUTE_INVALID', 'The order route request is invalid', undefined, { cause: error });
    case 'P0002':
      return new DomainProblem(404, 'ORDER_ROUTE_NOT_FOUND', 'The order route was not found', undefined, { cause: error });
    case 'P0001': {
      if (message === 'ORDER_ROUTE_VERSION_CONFLICT') {
        return new DomainProblem(412, 'VERSION_CONFLICT', 'The order route changed; reload it', undefined, { cause: error });
      }
      const refusal = P0001_REFUSALS[message];
      return refusal ? new DomainProblem(refusal[0], message, refusal[1], undefined, { cause: error })
        : orderRouteUnavailable(error);
    }
    default:
      return orderRouteUnavailable(error);
  }
}
