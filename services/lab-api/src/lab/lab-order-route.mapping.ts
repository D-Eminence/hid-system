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
  // The wrong-patient report (C25, item 3 §5.1): the state is checked before the version.
  ORDER_ROUTE_NOT_ACCEPTED: [409, 'This order has not been accepted, so there is nothing to end: decline it instead'],
  ORDER_ROUTE_ALREADY_ENDED: [409, 'This order has already ended, so it cannot be ended here'],
  // The late correction (C29, D17 §5.1): the state is checked before the version.
  ORDER_ROUTE_STILL_OPEN: [409, 'This order is still open: report it with "This isn\'t the order\'s patient" instead'],
  ORDER_ROUTE_ALREADY_REPORTED: [409, 'This order has already been reported as accepted for the wrong person'],
  ORDER_ROUTE_CORRECTION_TOO_LATE: [409, 'The time to correct this order has passed: phone Health ID support'],
  // "We can't complete this order" (C31, D18 §5.1): the state, then a checked result, then the version.
  ORDER_ROUTE_ALREADY_RETURNED: [409, 'A result has already gone back on this order, so it cannot be ended here'],
  ORDER_ROUTE_RESULT_READY: [409, 'A checked result is waiting to be released on this order'],
  ORDER_ROUTE_CRITICAL_VALUE_NOT_TOLD: [409,
    'A possibly critical value is recorded on this order: confirm that the ordering facility has been told'],
});

/** The permission C25 names when something must be withdrawn and the member may not (D4). */
export const LAB_CORRECTION_PERMISSION = 'lab.result.entered-in-error';

/**
 * C25's refusal when a result must be withdrawn and the member may not mark
 * results entered in error: 403 with the missing permission as an extension
 * (the database's DETAIL, kept only when it is that permission).
 */
function correctionPermissionRequired(error: unknown): DomainProblem {
  const detail = (error as { detail?: unknown }).detail;
  return new DomainProblem(403, 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED',
    'Results were recorded on this order, and this role cannot mark results entered in error', undefined,
    { cause: error, extensions: { permission: detail === LAB_CORRECTION_PERMISSION ? detail : LAB_CORRECTION_PERMISSION } });
}

/** An ISO-8601 UTC instant with milliseconds, as C29's limit refusal gives it (e.g. 2026-10-27T09:14:03.218Z). */
const RETRY_AFTER = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * C29's limit (D17-9): 5 late corrections per member and 20 per facility in
 * any 24 hours, exact. 429 with the earliest time another is possible as the
 * problem member `retryAfter` (the database's DETAIL, kept only when it is
 * such a time); support cannot lift it.
 */
function correctionLimit(error: unknown): DomainProblem {
  const retryAfter = retryAfterOf(error);
  return new DomainProblem(429, 'ORDER_ROUTE_CORRECTION_LIMIT', retryAfter
    ? `This laboratory may make no more late corrections until ${retryAfter}; if many orders are affected, phone Health ID support now`
    : 'This laboratory may make no more late corrections for now; if many orders are affected, phone Health ID support now',
  undefined, { cause: error, ...(retryAfter ? { extensions: { retryAfter } } : {}) });
}

/**
 * C31's limit (D18-7): 20 endings per member and 50 per laboratory in any 24
 * hours, exact, never lifted. 429 with the earliest time another is possible
 * as the problem member `retryAfter` (the database's DETAIL, kept only when it
 * is an exact UTC time); past it the ordering facility cancels the order or
 * Health ID support closes it.
 */
function cannotCompleteLimit(error: unknown): DomainProblem {
  const retryAfter = retryAfterOf(error);
  return new DomainProblem(429, 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT',
    `The most orders that can be ended here in 24 hours have been ended; more can be ended ${retryAfter
      ? `from ${retryAfter}` : 'later'}: ask the ordering facility to cancel this order, or Health ID support to close it; `
      + 'if many orders are affected, phone Health ID support now',
    undefined, { cause: error, ...(retryAfter ? { extensions: { retryAfter } } : {}) });
}

/** A limit refusal's DETAIL when it is an exact ISO UTC time with milliseconds, else undefined. */
function retryAfterOf(error: unknown): string | undefined {
  const detail = (error as { detail?: unknown }).detail;
  const parsed = typeof detail === 'string' && RETRY_AFTER.test(detail) ? new Date(detail) : undefined;
  return parsed && Number.isFinite(parsed.getTime()) && parsed.toISOString() === detail ? detail : undefined;
}

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
      if (message === 'ORDER_ROUTE_CORRECTION_PERMISSION_REQUIRED') return correctionPermissionRequired(error);
      if (message === 'ORDER_ROUTE_CORRECTION_LIMIT') return correctionLimit(error);
      if (message === 'ORDER_ROUTE_CANNOT_COMPLETE_LIMIT') return cannotCompleteLimit(error);
      const refusal = P0001_REFUSALS[message];
      return refusal ? new DomainProblem(refusal[0], message, refusal[1], undefined, { cause: error })
        : orderRouteUnavailable(error);
    }
    default:
      return orderRouteUnavailable(error);
  }
}

/**
 * The wrong-patient report's problems (C25): a concurrent route write (40001)
 * or a deadlock with a manual correction (40P01) is 409
 * ORDER_ROUTE_CHANGED_CONCURRENTLY for this command only (the website asks the
 * member to try again); everything else as the other route commands.
 */
export function wrongPatientProblem(error: unknown): unknown {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === '40001' || code === '40P01') {
    return new DomainProblem(409, 'ORDER_ROUTE_CHANGED_CONCURRENTLY', 'Someone changed this order at the same moment; try again',
      undefined, { cause: error });
  }
  return labOrderRouteProblem(error);
}

/** The answer of C25 (item 3 §5.1): the route as the report left it and what was withdrawn; never the patient or the report id. */
export interface WrongPatientAnswer {
  route: { id: string; version: number; effectiveState: string; endedKind: string };
  resultsVoided: number;
  resultReportsMarked: number;
  dispensingReversed: boolean;
  replayed: boolean;
}

export function wrongPatientAnswer(routeId: string, row: Row): WrongPatientAnswer | undefined {
  const result = field(row, 'result');
  const version = count(field(row, 'route_row_version'));
  const effectiveState = text(field(row, 'effective_state'));
  const endedKind = text(field(row, 'ended_kind'));
  if ((result !== 'ended' && result !== 'replayed') || version === null || !effectiveState || !endedKind) return undefined;
  return {
    route: { id: routeId, version, effectiveState, endedKind },
    resultsVoided: count(field(row, 'results_voided')) ?? 0,
    resultReportsMarked: count(field(row, 'result_reports_marked')) ?? 0,
    dispensingReversed: field(row, 'dispensing_reversed') === true,
    replayed: result === 'replayed',
  };
}

/**
 * The late correction's problems (C29, D17 §5.1): as the wrong-patient
 * report's, a concurrent release, reversal or order change (40001) or a
 * deadlock (40P01) is 409 ORDER_ROUTE_CHANGED_CONCURRENTLY for this command
 * only; everything else as the other route commands, the limit 429 with
 * `retryAfter`, the capability's own failure (XX000) 503.
 */
export function lateCorrectionProblem(error: unknown): unknown {
  return wrongPatientProblem(error);
}

/**
 * The answer of C29 (D17 §5.1): the route as the correction left it, the
 * ending it had before (null when it had only lapsed), what was withdrawn and
 * until when the order could be corrected; never the patient or the report id.
 */
export interface LateCorrectionAnswer {
  route: { id: string; version: number; effectiveState: string; endedKind: string };
  late: true;
  endedKindBefore: string | null;
  resultsVoided: number;
  resultReportsMarked: number;
  dispensingReversed: boolean;
  correctableUntil: string | null;
  replayed: boolean;
}

export function correctionAnswer(routeId: string, row: Row): LateCorrectionAnswer | undefined {
  const result = field(row, 'result');
  const version = count(field(row, 'route_row_version'));
  const effectiveState = text(field(row, 'effective_state'));
  const endedKind = text(field(row, 'ended_kind'));
  if ((result !== 'corrected' && result !== 'replayed') || version === null || !effectiveState || !endedKind) return undefined;
  return {
    route: { id: routeId, version, effectiveState, endedKind },
    late: true,
    endedKindBefore: text(field(row, 'ended_kind_before')),
    resultsVoided: count(field(row, 'results_voided')) ?? 0,
    resultReportsMarked: count(field(row, 'result_reports_marked')) ?? 0,
    dispensingReversed: field(row, 'dispensing_reversed') === true,
    correctableUntil: iso(field(row, 'correctable_until')),
    replayed: result === 'replayed',
  };
}

/** The correction states C30 answers (`not_accepted` never: it lists accepted routes only). */
const DETAILED = new Set(['open', 'correctable']);

/** What went back to the ordering facility and when (C30's `returned_items`), oldest first, at most 20. */
function returnedItems(value: unknown): { at: string | null; withdrawn: boolean }[] {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown; } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 20).flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    return [{ at: iso(entry.at), withdrawn: entry.withdrawn === true }];
  });
}

/**
 * One row of C30 (D17-8, §5.1): an order this laboratory accepted, found by
 * its reference, with its correction state and deadline, the laboratory's own
 * report if any, and, only while it is open or correctable, the laboratory's
 * own facts about it (the test, who here accepted it and how identity was
 * checked, what went back and when). Built field by field: no patient, no
 * orderer, no work item, no value. Undefined for a row without a route id.
 */
export function correctableLabRoute(row: Row) {
  const id = text(field(row, 'route_id', 'id'));
  if (!id) return undefined;
  const correction = text(field(row, 'correction_state', 'correction'));
  const what = text(field(row, 'what_name'));
  const reportedAt = iso(field(row, 'reported_at'));
  return {
    id,
    reference: text(field(row, 'reference')),
    kind: text(field(row, 'kind')),
    version: count(field(row, 'row_version', 'version')),
    effectiveState: text(field(row, 'effective_state')),
    orderingFacilityName: text(field(row, 'ordering_facility_name')),
    acceptedAt: iso(field(row, 'accepted_at')),
    completedAt: iso(field(row, 'completed_at')),
    endedAt: iso(field(row, 'ended_at')),
    endedKind: text(field(row, 'ended_kind')),
    returned: field(row, 'returned') === true,
    correction,
    correctableUntil: iso(field(row, 'correctable_until')),
    wrongPatient: reportedAt ? { reportedAt, late: field(row, 'report_late') === true } : null,
    details: correction !== null && DETAILED.has(correction) && what !== null ? {
      what,
      acceptedBy: text(field(row, 'accepted_by_name')),
      acceptedWith: text(field(row, 'accepted_with')),
      returned: returnedItems(field(row, 'returned_items')),
    } : null,
  };
}

/**
 * "We can't complete this order"'s problems (C31, D18 §5.1): as the
 * wrong-patient report's, a concurrent route write (40001) or a deadlock
 * (40P01) is 409 ORDER_ROUTE_CHANGED_CONCURRENTLY for this command only;
 * everything else as the other route commands: the limit 429 with
 * `retryAfter`, a caller transaction that is not READ COMMITTED (25000), a
 * CHECK (23514) or a schema without 0091 (42883) 503.
 */
export function cannotCompleteProblem(error: unknown): unknown {
  return wrongPatientProblem(error);
}

/**
 * The answer of C31 (D18 §5.1): the route as the ending left it, the reason
 * given (a replay: the first ending's), until when the laboratory may still
 * read it (the ending's moment when its reads ended at once) and what it had
 * recorded; never the patient, the ending id or anything clinical.
 */
export interface CannotCompleteAnswer {
  route: { id: string; version: number; effectiveState: string; endedKind: string };
  reason: string;
  readUntil: string | null;
  specimensCollected: number;
  resultsRecorded: number;
  criticalCandidates: number;
  replayed: boolean;
}

export function cannotCompleteAnswer(routeId: string, row: Row): CannotCompleteAnswer | undefined {
  const result = field(row, 'result');
  const version = count(field(row, 'route_row_version'));
  const effectiveState = text(field(row, 'effective_state'));
  const endedKind = text(field(row, 'ended_kind'));
  const reason = text(field(row, 'reason_code'));
  if ((result !== 'ended' && result !== 'replayed') || version === null || !effectiveState || !endedKind || !reason) {
    return undefined;
  }
  return {
    route: { id: routeId, version, effectiveState, endedKind },
    reason,
    readUntil: iso(field(row, 'access_ends_at')),
    specimensCollected: count(field(row, 'specimens_collected')) ?? 0,
    resultsRecorded: count(field(row, 'results_recorded')) ?? 0,
    criticalCandidates: count(field(row, 'critical_candidates')) ?? 0,
    replayed: result === 'replayed',
  };
}
