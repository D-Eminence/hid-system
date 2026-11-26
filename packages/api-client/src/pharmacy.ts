import { requestJson } from './index';

export type PharmacyInternalCaller = 'ehr-api' | 'ocr-api';

export interface PharmacyRequestContext {
  correlationId: string;
  facilityId: string;
  purposeOfUse: string;
  authorization?: string;
  cookie?: string;
  csrfToken?: string;
  origin?: string;
}

export interface PharmacyClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  internalServiceToken?: string;
  serviceAuthorizationProvider?: (caller: PharmacyInternalCaller) => Promise<string>;
}

export interface PharmacyResourceReference {
  id: string;
}

export interface PharmacyMedicationReference {
  codeSystem: string | null;
  code: string | null;
  display: string;
}

/**
 * The patient on a work item: name, sex, date of birth and the last 4
 * characters of the Health ID. On this facility's own work it is sent while
 * pharmacy-api's OWN_WORK_PATIENT_CARD_ENABLED is on and the member may read
 * the work (0124). On an item from another facility's order route it comes
 * with the route card, and only while the route still allows a read. Absent
 * otherwise.
 */
export interface PharmacyWorkItemPatient {
  fullName: string;
  sex: string | null;
  dateOfBirth: string | null;
  healthIdLast4: string | null;
}

/**
 * A work item's medicine, and on this facility's own work, while
 * pharmacy-api's PRESCRIPTION_DISPENSING_DETAILS_ENABLED is on and the
 * prescriber gave them (0125), its strength as written ("500 mg") and its
 * form (tablet, capsule, liquid, injection, cream, inhaler, drops, other).
 */
export interface PharmacyWorkItemMedication extends PharmacyMedicationReference {
  strength?: string;
  doseForm?: string;
}

/**
 * The order route a work item came from, as pharmacy-api shows it on an item
 * that another facility sent here: the route's id and reference, its state
 * now, what this pharmacy may still do with it, its version (sent back as
 * expectedVersion when reporting the wrong patient on it), how it ended (null
 * while it is live), and who ordered it from which facility, so a screen can
 * say "by <ordering facility>". The names are null when the route does not
 * hold them.
 */
export interface PharmacyWorkItemOrderRoute {
  id: string;
  reference: string | null;
  effectiveState: string;
  /**
   * What this pharmacy may do with the route now: 'work' (may act on it),
   * 'read' (may read it only) or 'none' (may no longer read it). Kept as a
   * string so a value added later still reaches the screen instead of failing
   * the whole list.
   */
  access: string;
  version: number;
  endedKind: string | null;
  orderingFacilityName: string | null;
  ordererName: string | null;
  /** Left out when the route holds no licence for the orderer. */
  ordererLicence?: { body: string; number: string | null };
}

export interface PharmacyWorkItem {
  id: string;
  patientId: string;
  facilityId: string;
  /**
   * The EHR prescription and encounter the item came from, present only on
   * this facility's own items. pharmacy-api leaves both out on an item from
   * another facility's order route, because they are the ordering facility's
   * record ids and this pharmacy may not see them (PRIV P4.3); such an item
   * carries `orderRoute` instead.
   */
  sourceEhrPrescriptionId?: string;
  sourceEhrPrescriptionVersion: number;
  /** Present only on this facility's own items (see sourceEhrPrescriptionId). */
  sourceEncounterId?: string;
  status: 'accepted';
  medication: PharmacyWorkItemMedication;
  doseQuantity: number | null;
  doseUnit: string | null;
  routeCode: string | null;
  frequency: string;
  instructions: string;
  acceptedAt: string;
  version: number;
  /**
   * The item's dispensing, or null before any. With refills (ORD-12, database
   * 0154) an item can have several fills, and this is the latest (the highest
   * fill number): `reversed` is whether that fill was reversed, and its id is
   * the one a reversal names (only the latest fill can be reversed; an earlier
   * one answers 409 PHARMACY_DISPENSING_NOT_LATEST_FILL). `fillNumber` (1 for
   * the first fill, 2-12 for refills) is present while pharmacy-api's
   * PRESCRIPTION_REFILLS_ENABLED is on, and left out when it is not a whole
   * number 1-12.
   */
  dispensing: { id: string; status: 'dispensed'; reversed: boolean; fillNumber?: number } | null;
  /**
   * ORD-12: when the latest fill was recorded (ISO time), present on a
   * dispensed item while PRESCRIPTION_REFILLS_ENABLED is on. Show "Last
   * dispensed 19 Nov" (Africa/Lagos).
   */
  lastFilledAt?: string;
  /**
   * ORD-12: the item's refills, present while PRESCRIPTION_REFILLS_ENABLED is
   * on (see PharmacyWorkItemRefills); left out on an older pharmacy-api, with
   * the setting off, when pharmacy-api could not read them, and when they are
   * malformed (the item reads as before, never a 502).
   */
  refills?: PharmacyWorkItemRefills;
  /** Present only when pharmacy-api sent it (see PharmacyWorkItemPatient). */
  patient?: PharmacyWorkItemPatient;
  /**
   * Present only on an item from another facility's order route whose route
   * card pharmacy-api could read; absent on this facility's own items, and on
   * a route-backed item whose card could not be read.
   */
  orderRoute?: PharmacyWorkItemOrderRoute;
  /**
   * The prescription details on own work (0125), each present only when
   * pharmacy-api sent it (see PharmacyWorkItemMedication): the priority
   * (routine, urgent, asap, stat); how long it is for (a whole number of
   * days, weeks or months; from the prescription's dates when it gave none);
   * and how much to hand over with its unit, which the pharmacist confirms.
   */
  priority?: string;
  duration?: { value: number; unit: string };
  quantityToDispense?: number;
  quantityUnit?: string;
  /**
   * Present (always true) only on this facility's own item withdrawn before
   * it was dispensed (database 0133); `withdrawnReason` says why. Dispensing
   * it answers 409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE; Dispense is
   * disabled.
   */
  withdrawn?: true;
  /**
   * Why the item was withdrawn, present only with `withdrawn` (and left out
   * when pharmacy-api sends another value):
   * - `changed`: its automatic send was withdrawn: the prescription was put
   *   on hold, cancelled, entered in error, edited or resumed after it was
   *   sent, by the prescriber or a colleague. Show "Changed or stopped by the
   *   prescribing team". The work list shows it with the done work.
   * - `sent_elsewhere`: the prescription was sent to another facility's
   *   pharmacy before it was dispensed (owner's Q121 A). The work list no
   *   longer shows it; read by id it is still answered. Show "Sent to another
   *   pharmacy by the prescribing team".
   */
  withdrawnReason?: 'changed' | 'sent_elsewhere';
  /**
   * Where the item is in the pharmacy's own steps (ORD-4), present only when
   * pharmacy-api sent it (left out on an older pharmacy-api, and on this
   * facility's own items when the database cannot say), and left out with
   * `pharmacistAcceptance` when pharmacy-api sends a step or an
   * `acceptedWith` this client does not know (see parseWorkItemStep):
   * - `received`: sent to this hospital's pharmacy by itself; no pharmacist
   *   has accepted it yet. Show "Accept" first, then "Dispense" (dispensing
   *   accepts it too).
   * - `accepted`: a pharmacist here took it on (see `pharmacistAcceptance`).
   * - `dispensed`, `dispensing_reversed`: as `dispensing` says.
   * `withdrawn` stays a separate flag: a received or accepted item can be
   * withdrawn. `status` and `acceptedAt` keep their meaning ("the pharmacy
   * has it", "when it arrived").
   */
  pharmacyStep?: PharmacyStep;
  /**
   * Who accepted it and when, present with `pharmacyStep` (null while
   * received). `acceptedWith`: `accept` (the Accept command), `dispensing`
   * (recorded by the first dispensing), `order_route` (another facility's
   * order, accepted with its route) or `hand_off` (brought in by a
   * pharmacist by hand). Show the name through the facility staff names
   * read; the id is never shown.
   */
  pharmacistAcceptance?: PharmacistAcceptance | null;
  /**
   * Q132 A (Release B, database 0148): present only on a dispensed item
   * (reversed or not) whose prescription the prescribing team changed after
   * the item was dispensed, so the pharmacist can contact the patient. Left
   * out when nothing was changed, on an older pharmacy-api or database, and
   * when pharmacy-api could not read it (it then logs a warning: no notice
   * does not prove no change). Never next to `withdrawn`, which exists only
   * before a dispensing. `pharmacyStep` stays `dispensed` or
   * `dispensing_reversed`.
   *
   * Show the words for the code, never the code, a version or an id, and
   * keep them in the screen's strings file. On this hospital's own item:
   * - `on_hold`: "Changed after dispensing: put on hold by the prescribing team"
   * - `cancelled`: "Changed after dispensing: cancelled by the prescribing team"
   * - `entered_in_error`: "Changed after dispensing: entered in error by the prescribing team"
   * - `edited`: "Changed after dispensing: edited by the prescribing team"
   * - `resumed`: "Changed after dispensing: resumed by the prescribing team"
   * - no `change` (a code this client does not know): "Changed after
   *   dispensing by the prescribing team"
   * On an item from another facility's order route say "by
   * {orderingFacilityName}" (the item's order route card) in place of "by the
   * prescribing team", or "by the ordering facility" with no card or no name.
   * "The prescribing team", not "the prescriber": anyone at the prescribing
   * facility who may change the prescription can do so. With `changeCount`
   * above 1 add " (changed {n} times)". Then the time, "Last change: 20 Nov
   * 2026, 09:15" (Africa/Lagos), and the next step, "Contact the patient."
   * There is no "Dismiss" or "Seen": the notice stays on the item.
   */
  changedAfterDispensing?: PharmacyChangedAfterDispensing;
}

export type PharmacyStep = 'received' | 'accepted' | 'dispensed' | 'dispensing_reversed';

/**
 * ORD-12: why no further fill can be recorded: `none_left` (every fill the
 * prescription allows is recorded; a reversed fill counts), `stopped` (the
 * prescription is on hold, completed, cancelled or entered in error),
 * `changed` (the prescribing team changed it after it was accepted: an edit,
 * or a hold then resume), `ended` (no refill can be collected any more: the
 * refills' last day, `endsOn`, is past, or the next refill would open only
 * after it, a late fill; the last day is the earliest of the prescription's
 * end date, the Lagos day it was written plus (refills + 2) times one fill's
 * duration, and that day plus 365; the clinical owner's decision of 24
 * November 2026),
 * `not_yet` (the refill interval has not passed: the refill opens on
 * `nextFillOn`, the Lagos day of the latest fill not reversed plus 3/4 of the
 * prescription's duration, rounded up; the clinical owner's rule of 24
 * November 2026, with no override: a clinician writes a new prescription).
 */
export type PharmacyRefillsClosedReason = 'none_left' | 'changed' | 'stopped' | 'ended' | 'not_yet';

/**
 * ORD-12's refills on a work item:
 * - `allowed`: the refills the prescription allows (0-11; an item from
 *   another facility's order route allows none and takes one fill);
 * - `recorded`: the fills recorded, a reversed fill included;
 * - `open`: another fill may be recorded now. Offer "Dispense" again only
 *   when `open` is true, and send `fillNumber: recorded + 1`;
 * - `closedReason`: why not, once a fill is recorded (null while open, before
 *   the first fill, and when pharmacy-api sends a reason this client does not
 *   know);
 * - `nextFillOn`: the Lagos day (YYYY-MM-DD) from which the next fill may be
 *   recorded: a later day while `closedReason` is `not_yet` (show "Refill
 *   from <date>"), today or earlier while open; null before the first fill,
 *   once closed for another reason, and from a pharmacy-api that does not
 *   send it;
 * - `endsOn`: the last Lagos day (YYYY-MM-DD) a refill can be collected,
 *   whatever the item's state: show "Refills until <date>" while refills
 *   remain; once `closedReason` is `ended`, "Refills ended on <date>" when
 *   that day has passed, and "Refills end on <date>, before the next one is
 *   due" when it is today or later (a late fill).
 *   Null when the prescription allows no refill, for an item from another
 *   facility's order route, and from a pharmacy-api that does not send it (or
 *   sends anything but a day).
 * Label: "Fill {recorded} of {allowed + 1}" ("Fill 2 of 3"); while open, the
 * fill about to be recorded is recorded + 1.
 */
export interface PharmacyWorkItemRefills {
  allowed: number;
  recorded: number;
  open: boolean;
  closedReason: PharmacyRefillsClosedReason | null;
  nextFillOn: string | null;
  endsOn: string | null;
}

/**
 * The pharmacy work list with what the list says about itself
 * (listWorkQueue):
 * - `items`: the work items, as listWorkItems answers them;
 * - `refillsUnavailable` (ORD-12): true when pharmacy-api, with refills on,
 *   could not read which items have a refill open, or the refills of the
 *   rows shown (a timeout among them: the open refills' cost grows with the
 *   facility's refill history). A due refill may then be missing from the
 *   open work, and the rows carry no `refills`: show "Refills could not be
 *   loaded" above the list. False when pharmacy-api does not say it (refills
 *   off, an older pharmacy-api) or says anything but true.
 */
export interface PharmacyWorkQueue {
  items: PharmacyWorkItem[];
  refillsUnavailable: boolean;
}

export interface PharmacistAcceptance {
  acceptedAt: string;
  /** Never null: pharmacy-api reads it from columns that are NOT NULL (0023's work item, 0144's acceptance). */
  acceptedByMembershipId: string;
  acceptedWith: 'accept' | 'dispensing' | 'order_route' | 'hand_off';
}

/**
 * Q132 A: what the prescribing team did after the dispensing. `edited`: an
 * active prescription's content changed, or it was resumed from a hold and
 * no longer says what was dispensed. `resumed`: resumed from a hold exactly
 * as dispensed. A stop (`entered_in_error`, `cancelled`, `on_hold`) wins over
 * an edit sent in the same change.
 */
export type PharmacyChangeAfterDispensing = 'on_hold' | 'cancelled' | 'entered_in_error' | 'edited' | 'resumed';

/**
 * Q132 A's notice: the latest shown change (`change`, `changedAt`: "the
 * latest change first" is these two, not a list) and how many shown changes
 * there were after the dispensing (`changeCount`, 1 or more). `change` is
 * absent when pharmacy-api sent a code this client does not know: the notice
 * is kept, because a safety notice is better shown without its reason than
 * not at all.
 */
export interface PharmacyChangedAfterDispensing {
  change?: PharmacyChangeAfterDispensing;
  /** ISO time, as the database recorded it (after any dispensing the change waited for). */
  changedAt: string;
  changeCount: number;
}

export interface PharmacyDispensing {
  id: string;
  workItemId: string;
  patientId: string;
  facilityId: string;
  status: 'dispensed';
  effectiveStatus: 'dispensed' | 'reversed';
  medication: PharmacyMedicationReference;
  quantityDispensed: number;
  quantityUnit: string;
  dispensedAt: string;
  reversalId: string | null;
  version: number;
  /**
   * ORD-12: which fill this is, 1 for the first and 2 to 12 for refills,
   * present while pharmacy-api's PRESCRIPTION_REFILLS_ENABLED is on, and left
   * out when it is not a whole number 1-12.
   */
  fillNumber?: number;
}

export interface PharmacyDispensingReversal {
  id: string;
  dispensingId: string;
  workItemId: string;
  patientId: string;
  facilityId: string;
  status: 'reversed';
  reversedAt: string;
  version: number;
}

export interface PharmacyImportedMedicationEvidence {
  id: string;
  patientId: string;
  facilityId: string;
  sourceType: 'IMPORTED_MEDICATION_EVIDENCE';
  activityStatus: 'unknown';
  medicationText: string;
  strengthText: string | null;
  doseText: string | null;
  frequencyText: string | null;
  historicalContext: string | null;
  sourceDocumentId: string;
  ocrJobId: string;
  extractionId: string;
  validationId: string;
  validationVersion: number;
  publicationId: string;
  version: number;
  createdAt: string;
}

export interface PharmacyImportBatch {
  id: string;
  count: number;
  items: PharmacyImportedMedicationEvidence[];
}

/** One page of a patient's imported medication records, newest first. */
export interface PharmacyImportedMedicationPage {
  items: PharmacyImportedMedicationEvidence[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface ListPharmacyImportedMedicationsOptions {
  /** 1-100; Pharmacy answers 50 when it is left out. */
  limit?: number;
  cursor?: string;
}

export interface CreatePharmacyDispensingInput {
  expectedWorkItemVersion: number;
  quantityDispensed: number;
  quantityUnit: string;
  reason: string;
  /**
   * ORD-12: the fill this records, the item's `refills.recorded + 1` (1 for
   * the first fill, 2-12 for refills). Send it only to a pharmacy-api whose
   * work item answered `refills` (PRESCRIPTION_REFILLS_ENABLED on): with the
   * setting off, or on an older pharmacy-api, any field the route does not
   * take is refused 400 VALIDATION_FAILED. Left out, the request is a first
   * fill, as before. The same fill with the same body replays the recorded
   * fill (201), whatever the Idempotency-Key, so a second press records
   * nothing. Refusals (409): PHARMACY_FILL_NUMBER_CHANGED with
   * `fillsRecorded` (another fill was recorded since the item was read: read
   * it again), PHARMACY_NO_REFILLS_LEFT, PHARMACY_REFILL_PRESCRIPTION_ENDED
   * with `refillsEndedOn` (YYYY-MM-DD, the refills' last day, `endsOn`: past,
   * or today or later when this refill would open only after it),
   * PHARMACY_REFILL_TOO_SOON with `refillOpensOn` (YYYY-MM-DD, the Lagos day
   * the refill opens),
   * PHARMACY_PRESCRIPTION_NOT_DISPENSABLE (held, stopped or changed),
   * PHARMACY_WORK_ITEM_ALREADY_DISPENSED (a first fill on an item that has one),
   * PHARMACY_DISPENSED_IN_FUTURE (the database found the fill dated after
   * now; pharmacy-api never sets that time, so a caller does not meet it).
   */
  fillNumber?: number;
}

export interface ReversePharmacyDispensingInput {
  expectedDispensingVersion: number;
  reason: string;
}

export class PharmacyApiProblem extends Error {
  constructor(readonly status: number, readonly payload: unknown) {
    super(typeof payload === 'object' && payload !== null && 'detail' in payload
      ? String((payload as { detail: unknown }).detail)
      : `Pharmacy API request failed (${status})`);
    this.name = 'PharmacyApiProblem';
  }
}

export class PharmacyApiClient {
  constructor(private readonly options: PharmacyClientOptions) {}

  async acceptEhrPrescription(
    input: unknown,
    context: PharmacyRequestContext,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<PharmacyResourceReference> {
    return this.resourceCommand(
      '/api/v1/pharmacy/work-items/accept-ehr-prescription',
      input,
      context,
      idempotencyKey,
      'ehr-api',
      signal,
    );
  }

  async createOcrImport(
    input: unknown,
    context: PharmacyRequestContext,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<PharmacyResourceReference> {
    return this.resourceCommand(
      '/api/v1/pharmacy/imports/from-ocr',
      input,
      context,
      idempotencyKey,
      'ocr-api',
      signal,
    );
  }

  /**
   * Several medicines from one OCR review. Pharmacy stores each as its own
   * record in one transaction (all or none) and answers every record, in the
   * order sent; `id` is the first one.
   */
  async createOcrImportBatch(
    input: unknown,
    context: PharmacyRequestContext,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<PharmacyImportBatch> {
    const result = await this.request('/api/v1/pharmacy/imports/from-ocr/batch', 'POST', input, context,
      idempotencyKey, 'ocr-api', signal);
    const value = record(result, 'Imported medication evidence batch');
    if (!Array.isArray(value.items) || value.items.length < 1) throw new PharmacyApiProblem(502, result);
    const items = value.items.map(parseImport);
    const count = integer(value, 'count');
    if (count !== items.length || text(value, 'id') !== items[0]?.id) throw new PharmacyApiProblem(502, result);
    return { id: items[0].id, count, items };
  }

  get(path: string, context: PharmacyRequestContext, signal?: AbortSignal): Promise<unknown> {
    return this.request(path, 'GET', undefined, context, undefined, undefined, signal);
  }

  async listWorkItems(context: PharmacyRequestContext, signal?: AbortSignal): Promise<PharmacyWorkItem[]> {
    return (await this.listWorkQueue(context, signal)).items;
  }

  /**
   * The work list and what it says about itself (PharmacyWorkQueue): today's
   * items, and ORD-12's `refillsUnavailable`. A front end that shows refills
   * reads the list through this, so a refill missing because pharmacy-api
   * could not read the refills is shown as such.
   */
  async listWorkQueue(context: PharmacyRequestContext, signal?: AbortSignal): Promise<PharmacyWorkQueue> {
    const value = record(await this.get('/api/v1/pharmacy/work-items', context, signal), 'Pharmacy work queue');
    if (!Array.isArray(value.items)) throw new PharmacyApiProblem(502, value);
    return { items: value.items.map(parseWorkItem), refillsUnavailable: value.refillsUnavailable === true };
  }

  async getWorkItem(workItemId: string, context: PharmacyRequestContext,
    signal?: AbortSignal): Promise<PharmacyWorkItem> {
    return parseWorkItem(await this.get(
      `/api/v1/pharmacy/work-items/${encodeURIComponent(workItemId)}`, context, signal));
  }

  async dispense(workItemId: string, input: CreatePharmacyDispensingInput,
    context: PharmacyRequestContext, idempotencyKey: string,
    signal?: AbortSignal): Promise<PharmacyDispensing> {
    return parseDispensing(await this.request(
      `/api/v1/pharmacy/work-items/${encodeURIComponent(workItemId)}/dispensings`,
      'POST', input, context, idempotencyKey, undefined, signal));
  }

  async getDispensing(dispensingId: string, context: PharmacyRequestContext,
    signal?: AbortSignal): Promise<PharmacyDispensing> {
    return parseDispensing(await this.get(
      `/api/v1/pharmacy/dispensings/${encodeURIComponent(dispensingId)}`, context, signal));
  }

  async reverseDispensing(dispensingId: string, input: ReversePharmacyDispensingInput,
    context: PharmacyRequestContext, idempotencyKey: string,
    signal?: AbortSignal): Promise<PharmacyDispensingReversal> {
    return parseReversal(await this.request(
      `/api/v1/pharmacy/dispensings/${encodeURIComponent(dispensingId)}/reversals`,
      'POST', input, context, idempotencyKey, undefined, signal));
  }

  async getImportedMedicationEvidence(importId: string, context: PharmacyRequestContext,
    signal?: AbortSignal): Promise<PharmacyImportedMedicationEvidence> {
    return parseImport(await this.get(
      `/api/v1/pharmacy/imports/${encodeURIComponent(importId)}`, context, signal));
  }

  /** One patient's imported medication records at the request's facility, newest first (GET pharmacy/imports). */
  async listImportedMedicationEvidence(patientId: string, context: PharmacyRequestContext,
    options: ListPharmacyImportedMedicationsOptions = {}, signal?: AbortSignal): Promise<PharmacyImportedMedicationPage> {
    const query = new URLSearchParams({ patientId });
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    const value = record(await this.get(`/api/v1/pharmacy/imports?${query.toString()}`, context, signal),
      'Imported medication evidence page');
    if (!Array.isArray(value.items)) throw new PharmacyApiProblem(502, value);
    if (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor)) {
      throw new PharmacyApiProblem(502, value);
    }
    // Never pass on more than a page, or a record of another patient, to the chart.
    if (value.items.length > 100) throw new PharmacyApiProblem(502, { code: 'INVALID_PHARMACY_IMPORT_RESPONSE' });
    const items = value.items.map(parseImport);
    if (items.some((item) => item.patientId !== patientId)) {
      throw new PharmacyApiProblem(502, { code: 'INVALID_PHARMACY_IMPORT_RESPONSE' });
    }
    return { items, nextCursor: value.nextCursor };
  }

  private async resourceCommand(
    path: string,
    body: unknown,
    context: PharmacyRequestContext,
    idempotencyKey: string,
    caller: PharmacyInternalCaller,
    signal?: AbortSignal,
  ): Promise<PharmacyResourceReference> {
    const result = await this.request(path, 'POST', body, context, idempotencyKey, caller, signal);
    if (typeof result !== 'object' || result === null
      || typeof (result as { id?: unknown }).id !== 'string') {
      throw new PharmacyApiProblem(502, result);
    }
    return result as PharmacyResourceReference;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    context: PharmacyRequestContext,
    idempotencyKey?: string,
    caller?: PharmacyInternalCaller,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const attempts = idempotencyKey ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const serviceAuthorization = caller && this.options.serviceAuthorizationProvider
          ? await this.options.serviceAuthorizationProvider(caller)
          : undefined;
        const { response, payload } = await requestJson({
          baseUrl: this.options.baseUrl,
          path,
          method,
          body,
          timeoutMs: this.options.timeoutMs ?? 10_000,
          credentials: caller ? 'omit' : 'include',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-correlation-id': context.correlationId,
            'x-facility-id': context.facilityId,
            'x-purpose-of-use': context.purposeOfUse,
            ...(context.authorization ? { authorization: context.authorization } : {}),
            ...(context.cookie ? { cookie: context.cookie } : {}),
            ...(context.csrfToken ? { 'x-csrf-token': context.csrfToken } : {}),
            ...(context.origin ? { origin: context.origin } : {}),
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
            ...(caller ? {
              'x-hid-internal-caller': caller,
              ...(serviceAuthorization
                ? { 'x-hid-service-authorization': serviceAuthorization }
                : { 'x-hid-service-token': this.options.internalServiceToken ?? '' }),
            } : {}),
          },
        });
        if (!response.ok) {
          if (attempt < attempts && [502, 503, 504].includes(response.status)) continue;
          throw new PharmacyApiProblem(response.status, payload);
        }
        return payload;
      } catch (error) {
        lastError = error;
        if (signal?.aborted || error instanceof PharmacyApiProblem || attempt >= attempts) throw error;
      }
    }
    throw lastError;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  const unwrapped = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (!isRecord(unwrapped)) throw new PharmacyApiProblem(502, { detail: `${label} response is malformed.` });
  return unwrapped;
}

function text(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string' || !value[key]) {
    throw new PharmacyApiProblem(502, { detail: `Pharmacy field ${key} is malformed.` });
  }
  return value[key];
}

function integer(value: Record<string, unknown>, key: string): number {
  if (typeof value[key] !== 'number' || !Number.isInteger(value[key])) {
    throw new PharmacyApiProblem(502, { detail: `Pharmacy field ${key} is malformed.` });
  }
  return value[key];
}

function finiteNumber(value: Record<string, unknown>, key: string): number {
  if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
    throw new PharmacyApiProblem(502, { detail: `Pharmacy field ${key} is malformed.` });
  }
  return value[key];
}

function nullableText(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === 'string' ? value[key] : null;
}

function parseMedication(value: unknown): PharmacyMedicationReference {
  const item = record(value, 'Pharmacy medication');
  return { codeSystem: nullableText(item, 'codeSystem'), code: nullableText(item, 'code'), display: text(item, 'display') };
}

/**
 * The optional prescription details (0125): each left out when absent; a
 * malformed one is refused like any other field.
 */
function parseWorkItemDetails(value: Record<string, unknown>): Pick<PharmacyWorkItem,
  'priority' | 'duration' | 'quantityToDispense' | 'quantityUnit'> {
  const duration = value.duration === undefined ? undefined : record(value.duration, 'Pharmacy work item duration');
  return {
    ...(value.priority === undefined ? {} : { priority: text(value, 'priority') }),
    ...(duration === undefined ? {} : { duration: { value: integer(duration, 'value'), unit: text(duration, 'unit') } }),
    ...(value.quantityToDispense === undefined ? {} : { quantityToDispense: finiteNumber(value, 'quantityToDispense') }),
    ...(value.quantityUnit === undefined ? {} : { quantityUnit: text(value, 'quantityUnit') }),
  };
}

function parseWorkItemMedication(value: unknown): PharmacyWorkItemMedication {
  const medication = parseMedication(value);
  const item = record(value, 'Pharmacy medication');
  return { ...medication, ...(item.strength === undefined ? {} : { strength: text(item, 'strength') }),
    ...(item.doseForm === undefined ? {} : { doseForm: text(item, 'doseForm') }) };
}

/** The optional patient: left out when absent; a malformed one is refused like any other field. */
function parseWorkItemPatient(value: unknown): { patient?: PharmacyWorkItemPatient } {
  if (value === undefined) return {};
  const patient = record(value, 'Pharmacy work item patient');
  return { patient: { fullName: text(patient, 'fullName'), sex: nullableText(patient, 'sex'),
    dateOfBirth: nullableText(patient, 'dateOfBirth'), healthIdLast4: nullableText(patient, 'healthIdLast4') } };
}

const PHARMACY_STEPS: readonly PharmacyStep[] = ['received', 'accepted', 'dispensed', 'dispensing_reversed'];
const ACCEPTED_WITH: readonly PharmacistAcceptance['acceptedWith'][] = ['accept', 'dispensing', 'order_route', 'hand_off'];

function malformedField(key: string): PharmacyApiProblem {
  return new PharmacyApiProblem(502, { detail: `Pharmacy field ${key} is malformed.` });
}

/**
 * ORD-4's step and acceptance, kept together or left out together.
 *
 * Lenient for a value. Both are left out, and the item reads as on Release
 * A, when `pharmacyStep` is absent (an older pharmacy-api, or a database
 * without 0144), and when `pharmacyStep` or `acceptedWith` is a string this
 * client does not know (a newer pharmacy-api). listWorkItems parses every
 * item, so refusing one newer value would leave the pharmacist with no work
 * list at all. An unknown step is not looked at further, and neither is the
 * rest of an acceptance with an unknown `acceptedWith`: a newer value may
 * come with another shape (no member, say).
 *
 * Strict for a type only, refused with 502 like any other field:
 * - `pharmacyStep` present but not a string (null included);
 * - next to a known step, `pharmacistAcceptance` missing, or neither null
 *   nor an object (pharmacy-api always sends the two together);
 * - `acceptedWith` not a string;
 * - with a known `acceptedWith`, `acceptedAt` or `acceptedByMembershipId`
 *   not a non-empty string (both are NOT NULL wherever pharmacy-api reads
 *   them: 0023's work item and 0144's acceptance).
 * None of these is a newer value, only a broken answer.
 */
function parseWorkItemStep(value: Record<string, unknown>): Pick<PharmacyWorkItem, 'pharmacyStep' | 'pharmacistAcceptance'> {
  const step = value.pharmacyStep;
  if (step === undefined) return {};
  if (typeof step !== 'string') throw malformedField('pharmacyStep');
  if (!(PHARMACY_STEPS as readonly string[]).includes(step)) return {};
  const raw = value.pharmacistAcceptance;
  if (raw === null) return { pharmacyStep: step as PharmacyStep, pharmacistAcceptance: null };
  if (!isRecord(raw)) throw malformedField('pharmacistAcceptance');
  const acceptedWith = raw.acceptedWith;
  if (typeof acceptedWith !== 'string') throw malformedField('acceptedWith');
  if (!(ACCEPTED_WITH as readonly string[]).includes(acceptedWith)) return {};
  return { pharmacyStep: step as PharmacyStep, pharmacistAcceptance: { acceptedAt: text(raw, 'acceptedAt'),
    acceptedByMembershipId: text(raw, 'acceptedByMembershipId'),
    acceptedWith: acceptedWith as PharmacistAcceptance['acceptedWith'] } };
}

const CHANGES_AFTER_DISPENSING: readonly PharmacyChangeAfterDispensing[] = ['on_hold', 'cancelled', 'entered_in_error',
  'edited', 'resumed'];

/**
 * Q132 A's notice on a dispensed item.
 *
 * Lenient for a value: absent, it is left out (an older pharmacy-api or
 * database, or no change). A `change` string this client does not know (a
 * newer pharmacy-api) keeps the notice without `change`, so the screen still
 * says "Changed after dispensing by the prescribing team". This differs on
 * purpose from ORD-4's steps (parseWorkItemStep), which leave an unknown
 * value out: a step is where the item is in the pharmacy's own work, while
 * this notice tells the pharmacist to contact the patient, and dropping it
 * is worse than showing it without its reason (open point 5, accepted by Ola
 * on 20 November 2026). Keys other than the three are dropped.
 *
 * Strict for a type only, refused with 502 like any other broken field:
 * the notice not an object (null and arrays included); `changedAt` not a
 * non-empty string; `changeCount` not a whole number of 1 or more (a notice
 * always counts at least its own change); `change` present but not a string
 * (null included). None of these is a newer value, only a broken answer.
 */
function parseChangedAfterDispensing(value: unknown): Pick<PharmacyWorkItem, 'changedAfterDispensing'> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw malformedField('changedAfterDispensing');
  const changedAt = text(value, 'changedAt');
  const changeCount = value.changeCount;
  if (typeof changeCount !== 'number' || !Number.isSafeInteger(changeCount) || changeCount < 1) {
    throw malformedField('changeCount');
  }
  const change = value.change;
  if (change !== undefined && typeof change !== 'string') throw malformedField('change');
  const known = CHANGES_AFTER_DISPENSING.find((code) => code === change);
  return { changedAfterDispensing: { ...(known ? { change: known } : {}), changedAt, changeCount } };
}

/**
 * The optional order route card: left out when absent (this facility's own
 * item, or a route-backed item whose card pharmacy-api could not read); a
 * malformed one is refused like any other field. Keys the card does not
 * define are dropped, so nothing else from the route reaches a screen.
 */
function parseWorkItemOrderRoute(value: unknown): { orderRoute?: PharmacyWorkItemOrderRoute } {
  if (value === undefined) return {};
  const route = record(value, 'Pharmacy work item order route');
  const licence = route.ordererLicence === undefined ? undefined
    : record(route.ordererLicence, 'Pharmacy work item orderer licence');
  return { orderRoute: { id: text(route, 'id'), reference: nullableText(route, 'reference'),
    effectiveState: text(route, 'effectiveState'), access: text(route, 'access'), version: integer(route, 'version'),
    endedKind: nullableText(route, 'endedKind'), orderingFacilityName: nullableText(route, 'orderingFacilityName'),
    ordererName: nullableText(route, 'ordererName'),
    ...(licence === undefined ? {} : { ordererLicence: { body: text(licence, 'body'),
      number: nullableText(licence, 'number') } }) } };
}

function parseWorkItem(payload: unknown): PharmacyWorkItem {
  const value = record(payload, 'Pharmacy work item');
  const dispensing = value.dispensing === null ? null : record(value.dispensing, 'Pharmacy dispensing summary');
  return {
    id: text(value, 'id'), patientId: text(value, 'patientId'), facilityId: text(value, 'facilityId'),
    // Both source ids are left out on an item from another facility's order
    // route (PRIV P4.3); when sent, each must still be a non-empty string.
    ...(value.sourceEhrPrescriptionId === undefined ? {}
      : { sourceEhrPrescriptionId: text(value, 'sourceEhrPrescriptionId') }),
    sourceEhrPrescriptionVersion: integer(value, 'sourceEhrPrescriptionVersion'),
    ...(value.sourceEncounterId === undefined ? {} : { sourceEncounterId: text(value, 'sourceEncounterId') }),
    status: 'accepted',
    medication: parseWorkItemMedication(value.medication),
    doseQuantity: typeof value.doseQuantity === 'number' ? value.doseQuantity : null,
    doseUnit: nullableText(value, 'doseUnit'), routeCode: nullableText(value, 'routeCode'),
    frequency: text(value, 'frequency'), instructions: text(value, 'instructions'),
    acceptedAt: text(value, 'acceptedAt'), version: integer(value, 'version'),
    dispensing: dispensing ? {
      id: text(dispensing, 'id'), status: 'dispensed', reversed: dispensing.reversed === true,
      ...parseFillNumber(dispensing.fillNumber),
    } : null,
    ...parseWorkItemOrderRoute(value.orderRoute),
    ...parseWorkItemPatient(value.patient),
    ...parseWorkItemDetails(value),
    ...(value.withdrawn === true ? { withdrawn: true as const,
      ...(value.withdrawnReason === 'changed' || value.withdrawnReason === 'sent_elsewhere'
        ? { withdrawnReason: value.withdrawnReason } : {}) } : {}),
    ...parseWorkItemStep(value),
    ...(typeof value.lastFilledAt === 'string' && value.lastFilledAt.length > 0 ? { lastFilledAt: value.lastFilledAt } : {}),
    ...parseWorkItemRefills(value.refills),
    ...parseChangedAfterDispensing(value.changedAfterDispensing),
  };
}

const REFILLS_CLOSED_REASONS: readonly PharmacyRefillsClosedReason[] = ['none_left', 'changed', 'stopped', 'ended',
  'not_yet'];
const LAGOS_DAY = /^\d{4}-\d{2}-\d{2}$/;

const wholeNumber = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** ORD-12's fill number on a dispensing: kept only when it is a whole number 1-12 (lenient: left out otherwise). */
function parseFillNumber(value: unknown): { fillNumber?: number } {
  return wholeNumber(value, 1, 12) ? { fillNumber: value } : {};
}

/**
 * ORD-12's refills on a work item. Lenient, as the work list parses every
 * item and refusing one would leave the pharmacist with no list: absent (an
 * older pharmacy-api, the setting off) or malformed (not an object, `allowed`
 * not a whole number 0-11, `recorded` not a whole number 0-12, `open` not a
 * boolean), it is left out and the item reads as before. A `closedReason` this
 * client does not know is read as null, and a `nextFillOn` or `endsOn` that is
 * not a day (YYYY-MM-DD), or absent, as null. Keys other than the six are
 * dropped.
 */
function parseWorkItemRefills(value: unknown): Pick<PharmacyWorkItem, 'refills'> {
  if (!isRecord(value) || !wholeNumber(value.allowed, 0, 11) || !wholeNumber(value.recorded, 0, 12)
    || typeof value.open !== 'boolean') return {};
  const closedReason = REFILLS_CLOSED_REASONS.find((reason) => reason === value.closedReason) ?? null;
  const lagosDay = (day: unknown) => (typeof day === 'string' && LAGOS_DAY.test(day) ? day : null);
  return { refills: { allowed: value.allowed, recorded: value.recorded, open: value.open, closedReason,
    nextFillOn: lagosDay(value.nextFillOn), endsOn: lagosDay(value.endsOn) } };
}

function parseDispensing(payload: unknown): PharmacyDispensing {
  const value = record(payload, 'Pharmacy dispensing');
  return {
    id: text(value, 'id'), workItemId: text(value, 'workItemId'), patientId: text(value, 'patientId'),
    facilityId: text(value, 'facilityId'), status: 'dispensed',
    effectiveStatus: value.effectiveStatus === 'reversed' ? 'reversed' : 'dispensed',
    medication: parseMedication(value.medication),
    quantityDispensed: finiteNumber(value, 'quantityDispensed'),
    quantityUnit: text(value, 'quantityUnit'), dispensedAt: text(value, 'dispensedAt'),
    reversalId: nullableText(value, 'reversalId'), version: integer(value, 'version'),
    ...parseFillNumber(value.fillNumber),
  };
}

function parseReversal(payload: unknown): PharmacyDispensingReversal {
  const value = record(payload, 'Pharmacy dispensing reversal');
  return {
    id: text(value, 'id'), dispensingId: text(value, 'dispensingId'), workItemId: text(value, 'workItemId'),
    patientId: text(value, 'patientId'), facilityId: text(value, 'facilityId'), status: 'reversed',
    reversedAt: text(value, 'reversedAt'), version: integer(value, 'version'),
  };
}

function parseImport(payload: unknown): PharmacyImportedMedicationEvidence {
  const value = record(payload, 'Imported medication evidence');
  return {
    id: text(value, 'id'), patientId: text(value, 'patientId'), facilityId: text(value, 'facilityId'),
    sourceType: 'IMPORTED_MEDICATION_EVIDENCE', activityStatus: 'unknown',
    medicationText: text(value, 'medicationText'), strengthText: nullableText(value, 'strengthText'),
    doseText: nullableText(value, 'doseText'), frequencyText: nullableText(value, 'frequencyText'),
    historicalContext: nullableText(value, 'historicalContext'), sourceDocumentId: text(value, 'sourceDocumentId'),
    ocrJobId: text(value, 'ocrJobId'), extractionId: text(value, 'extractionId'),
    validationId: text(value, 'validationId'), validationVersion: integer(value, 'validationVersion'),
    publicationId: text(value, 'publicationId'), version: integer(value, 'version'),
    createdAt: text(value, 'createdAt'),
  };
}
