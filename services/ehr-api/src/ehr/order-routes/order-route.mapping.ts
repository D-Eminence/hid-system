/**
 * Cross-facility order routes (P4c, SPEC-FINAL §10.1): the shapes the EHR
 * answers, built from what the database commands return.
 *
 * Every shape is built field by field from a fixed list, so nothing a command
 * returns beyond these fields reaches the browser (source order, encounter,
 * patient or staff ids, PRIV P4.3). Each field is read by its column name
 * (snake_case, the commands' `returns table` columns) or by its camelCase key
 * (the commands' jsonb values, e.g. C4's `summary`, C3's `attestation` and
 * `events`), whichever is present.
 */

export type OrderRouteKind = 'lab_request' | 'prescription';

export const ORDER_ROUTE_KINDS: readonly OrderRouteKind[] = ['lab_request', 'prescription'];

/** Stored states with a route in force (SPEC-FINAL §3.2). */
export const LIVE_STATES: ReadonlySet<string> = new Set(['sent', 'accepted', 'completed']);

export interface OrderRouteSummary {
  id: string;
  reference: string | null;
  kind: OrderRouteKind;
  version: number;
  effectiveState: string;
  receivingFacility: { id: string | null; name: string | null; available: boolean | null };
  createdAt: string | null;
  respondBy: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  endedAt: string | null;
  endedKind: string | null;
  declineReason: string | null;
  acceptLocked: boolean;
  resendAllowed: boolean;
}

export interface OrderRouteAttestation {
  textVersion: string | null;
  attestedByName: string | null;
  attestedAt: string | null;
  receivingFacilityName: string | null;
}

export interface OrderRouteEvent {
  type: string | null;
  side: string | null;
  occurredAt: string | null;
  reasonCode: string | null;
  stateAfter: string | null;
}

export interface OrderRouteResultReport {
  resultId: string | null;
  resultVersion: number | null;
  kind: string | null;
  test: { codeSystem: string | null; code: string | null; name: string | null };
  resultType: string | null;
  numericValue: string | number | null;
  textValue: string | null;
  unit: string | null;
  referenceRange: string | null;
  abnormalFlag: string | null;
  revisionKind: string | null;
  correctionReason: string | null;
  occurredAt: string | null;
}

export interface OrderRouteDispensingReport {
  dispensingId: string | null;
  kind: string | null;
  medication: { codeSystem: string | null; code: string | null; display: string | null };
  quantityDispensed: string | number | null;
  quantityUnit: string | null;
  occurredAt: string | null;
}

export type OrderRouteView = OrderRouteSummary & {
  attestation: OrderRouteAttestation;
  events: OrderRouteEvent[];
} & ({ results: OrderRouteResultReport[] } | { dispensings: OrderRouteDispensingReport[] });

export interface PatientOrderRoute extends OrderRouteSummary {
  orderingFacilityName: string | null;
  receivingFacilityName: string | null;
  receivingRegisteredAddress: string | null;
  content: Record<string, string | number | null>;
  attestationTextVersion: string | null;
  attestationText: string | null;
  attestedByName: string | null;
  actions: 'withdraw'[];
  /**
   * The order was marked entered in error (it may have been written in
   * another patient's chart): C5 then answers the route as the record of what
   * went where, with no content beyond its reference, no attestation text and
   * no attesting clinician.
   */
  enteredInError: boolean;
}

type Source = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Source {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** The first of the named fields that is present (not undefined). */
function field(source: Source, ...names: string[]): unknown {
  for (const name of names) {
    if (source[name] !== undefined) return source[name];
  }
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

function flag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

/** An ISO-8601 instant, from a pg Date or a jsonb timestamp string. */
export function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  return null;
}

/** A plain date (yyyy-mm-dd) as the database renders a `date` column. */
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

/** A numeric column (pg returns numeric as text; jsonb as a number). */
function numeric(value: unknown): string | number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return text(value);
}

function kindOf(value: unknown, fallback?: OrderRouteKind): OrderRouteKind {
  if (value === 'lab_request' || value === 'prescription') return value;
  if (fallback) return fallback;
  throw new Error('An order route without a known kind');
}

/** OrderRouteSummary from a command row or a jsonb summary (C1, C3, C4, C5). */
export function orderRouteSummary(source: Source, fallbackKind?: OrderRouteKind): OrderRouteSummary {
  const nested = field(source, 'receivingFacility');
  const receiving = isRecord(nested) ? nested : undefined;
  const id = text(field(source, 'id', 'route_id', 'routeId'));
  if (!id) throw new Error('An order route without an id');
  const lockedAt = field(source, 'acceptLockedAt', 'accept_locked_at');
  return {
    id,
    reference: text(field(source, 'reference')),
    kind: kindOf(field(source, 'kind'), fallbackKind),
    version: count(field(source, 'version', 'rowVersion', 'row_version')) ?? 0,
    effectiveState: text(field(source, 'effectiveState', 'effective_state', 'state')) ?? 'unknown',
    receivingFacility: {
      id: text(receiving ? field(receiving, 'id') : field(source, 'receivingFacilityId', 'receiving_facility_id')),
      name: text(receiving ? field(receiving, 'name')
        : field(source, 'receivingFacilityName', 'receiving_facility_name')),
      available: flag(receiving ? field(receiving, 'available')
        : field(source, 'receivingAvailable', 'receiving_available')),
    },
    createdAt: iso(field(source, 'createdAt', 'created_at', 'sentAt', 'sent_at')),
    respondBy: iso(field(source, 'respondBy', 'respond_by')),
    acceptedAt: iso(field(source, 'acceptedAt', 'accepted_at')),
    completedAt: iso(field(source, 'completedAt', 'completed_at')),
    endedAt: iso(field(source, 'endedAt', 'ended_at')),
    endedKind: text(field(source, 'endedKind', 'ended_kind')),
    declineReason: text(field(source, 'declineReason', 'decline_reason')),
    acceptLocked: flag(field(source, 'acceptLocked', 'accept_locked')) === true
      || (lockedAt !== undefined && lockedAt !== null),
    resendAllowed: flag(field(source, 'resendAllowed', 'resend_allowed')) === true,
  };
}

/**
 * True when the order is routed to another facility, so this facility's own
 * Lab or Pharmacy must not take it (SPEC-FINAL §7.5): its latest route is live
 * (`sent`, `accepted`, `completed`), or it was ever accepted. An accepted
 * route holds the order's one work item for good (one work item per order,
 * ever, NMIG 0018:50, 0023:88), so a route accepted and then cancelled, or
 * accepted and lapsed (effectively `expired`), still keeps the order out of
 * this facility's Lab and Pharmacy. A `sent` route past its respond-by date
 * (effectively `expired`, never accepted) does not: the order may then go
 * anywhere, here included. C4 answers the latest route only; a route can be
 * sent again only when no route of the order was ever accepted (§3.2), so the
 * latest route is the accepted one whenever any was.
 */
export function routeInForce(summary: OrderRouteSummary | null | undefined): boolean {
  if (!summary) return false;
  return LIVE_STATES.has(summary.effectiveState) || summary.acceptedAt !== null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function records(value: unknown): Source[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
}

export function orderRouteAttestation(source: Source): OrderRouteAttestation {
  const nested = parseJson(field(source, 'attestation'));
  const from = isRecord(nested) ? nested : source;
  return {
    textVersion: text(field(from, 'textVersion', 'attestationTextVersion', 'attestation_text_version')),
    attestedByName: text(field(from, 'attestedByName', 'attested_by_name')),
    attestedAt: iso(field(from, 'attestedAt', 'attested_at', ...(from === source ? ['created_at'] : []))),
    receivingFacilityName: text(field(from, 'receivingFacilityName', 'attestedReceivingFacilityName',
      'attested_receiving_facility_name')),
  };
}

export function orderRouteEvents(value: unknown): OrderRouteEvent[] {
  return records(value).map((event) => ({
    type: text(field(event, 'type', 'eventType', 'event_type')),
    side: text(field(event, 'side')),
    occurredAt: iso(field(event, 'occurredAt', 'occurred_at')),
    reasonCode: text(field(event, 'reasonCode', 'reason_code')),
    stateAfter: text(field(event, 'stateAfter', 'state_after')),
  }));
}

export function orderRouteResults(value: unknown): OrderRouteResultReport[] {
  return records(value).map((report) => {
    const nested = field(report, 'test');
    const test = isRecord(nested) ? nested : undefined;
    return {
      resultId: text(field(report, 'resultId', 'result_id')),
      resultVersion: count(field(report, 'resultVersion', 'result_version')),
      kind: text(field(report, 'kind')),
      test: {
        codeSystem: text(test ? field(test, 'codeSystem') : field(report, 'testCodeSystem', 'test_code_system')),
        code: text(test ? field(test, 'code') : field(report, 'testCode', 'test_code')),
        name: text(test ? field(test, 'name') : field(report, 'testName', 'test_name')),
      },
      resultType: text(field(report, 'resultType', 'result_type')),
      numericValue: numeric(field(report, 'numericValue', 'numeric_value')),
      textValue: text(field(report, 'textValue', 'text_value')),
      unit: text(field(report, 'unit')),
      referenceRange: text(field(report, 'referenceRange', 'reference_range')),
      abnormalFlag: text(field(report, 'abnormalFlag', 'abnormal_flag')),
      revisionKind: text(field(report, 'revisionKind', 'revision_kind')),
      correctionReason: text(field(report, 'correctionReason', 'correction_reason')),
      occurredAt: iso(field(report, 'occurredAt', 'occurred_at')),
    };
  });
}

export function orderRouteDispensings(value: unknown): OrderRouteDispensingReport[] {
  return records(value).map((report) => {
    const nested = field(report, 'medication');
    const medication = isRecord(nested) ? nested : undefined;
    return {
      dispensingId: text(field(report, 'dispensingId', 'dispensing_id')),
      kind: text(field(report, 'kind')),
      medication: {
        codeSystem: text(medication ? field(medication, 'codeSystem')
          : field(report, 'medicationCodeSystem', 'medication_code_system')),
        code: text(medication ? field(medication, 'code') : field(report, 'medicationCode', 'medication_code')),
        display: text(medication ? field(medication, 'display')
          : field(report, 'medicationDisplay', 'medication_display')),
      },
      quantityDispensed: numeric(field(report, 'quantityDispensed', 'quantity_dispensed')),
      quantityUnit: text(field(report, 'quantityUnit', 'quantity_unit')),
      occurredAt: iso(field(report, 'occurredAt', 'occurred_at')),
    };
  });
}

/** OrderRouteView from one row of C3 (`ehr.list_order_routes_for_order`). */
export function orderRouteView(source: Source, kind: OrderRouteKind): OrderRouteView {
  // C3 may answer the summary as columns or as one `summary` jsonb (as C4
  // does); `receiving_available` is the receiver's eligibility now (H4).
  const nested = parseJson(field(source, 'summary'));
  const summarySource = isRecord(nested) ? { ...nested, id: field(nested, 'id') ?? field(source, 'route_id', 'id') } : source;
  const parsed = orderRouteSummary(summarySource, kind);
  const available = flag(field(source, 'receiving_available', 'receivingAvailable'));
  const summary = available === null ? parsed : { ...parsed, receivingFacility: { ...parsed.receivingFacility, available } };
  const reports = field(source, 'reports');
  const base = { ...summary, attestation: orderRouteAttestation(source), events: orderRouteEvents(field(source, 'events')) };
  return summary.kind === 'lab_request'
    ? { ...base, results: orderRouteResults(reports) }
    : { ...base, dispensings: orderRouteDispensings(reports) };
}

/** What crossed about the orderer (T1's snapshot of the order's author, PRIV P7.5). */
const ORDERER_CONTENT: readonly (readonly [string, readonly string[], (value: unknown) => string | number | null])[] = [
  ['ordererName', ['ordererName', 'orderer_name'], text],
  ['ordererLicenceBody', ['ordererLicenceBody', 'orderer_licence_body'], text],
  ['ordererLicenceNumber', ['ordererLicenceNumber', 'orderer_licence_number'], text],
];

const LAB_CONTENT: readonly (readonly [string, readonly string[], (value: unknown) => string | number | null])[] = [
  ['testCodeSystem', ['testCodeSystem', 'test_code_system'], text],
  ['testCode', ['testCode', 'test_code'], text],
  ['testDisplay', ['testDisplay', 'test_display'], text],
  ['priority', ['priority'], text],
  ['specimenTypeCode', ['specimenTypeCode', 'specimen_type_code'], text],
  ['clinicalInformation', ['clinicalInformation', 'clinical_information'], text],
  ['requestedAt', ['requestedAt', 'requested_at'], iso],
];

const PRESCRIPTION_CONTENT: readonly (readonly [string, readonly string[], (value: unknown) => string | number | null])[] = [
  ['medicationCodeSystem', ['medicationCodeSystem', 'medication_code_system'], text],
  ['medicationCode', ['medicationCode', 'medication_code'], text],
  ['medicationDisplay', ['medicationDisplay', 'medication_display'], text],
  ['doseQuantity', ['doseQuantity', 'dose_quantity'], numeric],
  ['doseUnit', ['doseUnit', 'dose_unit'], text],
  ['routeCode', ['routeCode', 'route_code'], text],
  ['frequency', ['frequency'], text],
  ['instructions', ['instructions'], text],
  ['startsOn', ['startsOn', 'starts_on'], day],
  ['endsOn', ['endsOn', 'ends_on'], day],
  ['prescribedAt', ['prescribedAt', 'prescribed_at'], iso],
];

/** Every snapshot field the route sent (PRIV P7.5), from `content` jsonb or the snapshot columns. */
export function orderRouteContent(source: Source, kind: OrderRouteKind): Record<string, string | number | null> {
  const nested = parseJson(field(source, 'content'));
  const from = isRecord(nested) ? nested : source;
  const fields = [...(kind === 'lab_request' ? LAB_CONTENT : PRESCRIPTION_CONTENT), ...ORDERER_CONTENT];
  return Object.fromEntries(fields.map(([name, names, convert]) => [name, convert(field(from, ...names))]));
}

function patientActions(value: unknown): 'withdraw'[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) && parsed.includes('withdraw') ? ['withdraw'] : [];
}

/** PatientOrderRoute from one row of C5 (`ehr.patient_list_order_routes`). */
export function patientOrderRoute(source: Source): PatientOrderRoute {
  const summary = orderRouteSummary(source);
  return {
    ...summary,
    orderingFacilityName: text(field(source, 'orderingFacilityName', 'ordering_facility_name')),
    receivingFacilityName: text(field(source, 'receivingFacilityName', 'receiving_facility_name'))
      ?? summary.receivingFacility.name,
    receivingRegisteredAddress: text(field(source, 'receivingRegisteredAddress', 'receiving_registered_address')),
    content: orderRouteContent(source, summary.kind),
    attestationTextVersion: text(field(source, 'attestationTextVersion', 'attestation_text_version')),
    attestationText: text(field(source, 'attestationText', 'attestation_text')),
    attestedByName: text(field(source, 'attestedByName', 'attested_by_name')),
    // Stop is offered only while the route waits for acceptance; the database
    // decides (C5) and refuses a late Stop (C6), this only never widens it.
    actions: summary.effectiveState === 'sent' ? patientActions(field(source, 'actions')) : [],
    enteredInError: flag(field(source, 'enteredInError', 'entered_in_error')) === true,
  };
}

/**
 * The item with its latest route to another facility: the route's summary,
 * null when it has none, and no field at all when routes could not be read
 * (`routes` undefined, or not under direct care).
 */
export function withOrderRoute<Row extends { id: string }>(row: Row,
  routes: ReadonlyMap<string, OrderRouteSummary> | undefined): Row & { orderRoute?: OrderRouteSummary | null } {
  return routes === undefined ? row : { ...row, orderRoute: routes.get(row.id) ?? null };
}
