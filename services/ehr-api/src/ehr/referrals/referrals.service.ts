import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import {
  REFERRAL_EFFECTIVE_STATES, REFERRAL_PACKAGE_LIMITS, type AcceptReferralDto, type ArriveReferralDto,
  type CompleteReferralDto, type DeclineReferralDto, type ReferralDestinationKind, type ReferralListQueryDto,
  type SendReferralDto, type WithdrawReferralDto,
} from './referrals.dto';

/**
 * REF-1 (0191-0193): referrals between facilities.
 *
 * Every staff route works through 0191's and 0192's SECURITY DEFINER
 * functions, which check the caller (an active membership here, the route's
 * referral code, direct care, the facility's seal), decide and audit in the
 * request's transaction, refusals that answer included. The receiving
 * facility reads only the frozen package the clinician selected, and only
 * while accepted, arrived or completed, before access_ends_at, with the
 * control on (Q261 A); the arrival never opens the chart (Q168 A's
 * principle). The database builds the card and the package; this service
 * passes them on and maps refusals to the contract's plain words.
 *
 * Switches: REFERRALS_ENABLED (off by default: every route answers 503
 * REFERRALS_NOT_AVAILABLE) and the platform control
 * cross_facility_referrals_enabled (0191, seeded off; routes 2 to a Health ID
 * facility, 11 and 14 answer 423, and the receiving side reads at view level
 * metadata). Printed letters need only the flag (Q162 A, Q-REF-15 A).
 *
 * No Health ID or NIN is in any path, query, body or answer: the card carries
 * the last 4 characters of the Health ID only, and the printed letter none.
 */

/** The contract's plain words. Staff screens show these and never the word "permission". */
export const REFERRAL_MESSAGES = {
  notAvailable: 'Referrals are not available yet.',
  notAllowed: 'Only doctors and clinicians can send, answer or read referrals.',
  arrivalNotAllowed: 'Only the front desk, clinicians and doctors of this facility can mark a referred patient as arrived.',
  validation: 'Check the highlighted fields.',
  destinationRequired: 'Choose a facility on Health ID, or print a letter for a facility that is not on Health ID.',
  packageInvalid: 'Some of the details you ticked can no longer be sent. Reload the visit and tick them again.',
  attestationRequired: 'Confirm that the patient agreed before sending.',
  reasonRequired: 'Say why in at least 8 characters.',
  outcomeInvalid: 'Choose \'Did not attend\' only before the patient arrives, and another outcome only after.',
  arrivalNeedsOnePatient: 'Choose one patient: from a search result or from this facility\'s patients.',
  visitInvalid: 'Choose a visit of this patient at this facility.',
  arrivalNeedsSearch: 'Search for the patient named on the referral, then mark them arrived. A search result can be used for 10 minutes.',
  consentRequired: 'Active consent and facility membership are required',
  patientSessionRequired: 'An active patient session is required',
  notFound: 'No such referral.',
  visitNotSigned: 'Sign the visit\'s note first, then send the referral.',
  patientNotIdentified: 'Identify the patient first (verify the NIN or merge the record), then refer them.',
  patientAppRequired: 'This patient has no Health ID app account, so they could not see or withdraw the referral. Print a referral letter instead.',
  patientDenied: 'The patient has asked that their records are not shared with this facility.',
  destinationUnavailable: 'This facility is not taking referrals on Health ID now. Choose another, or print a letter.',
  destinationBusy: 'This facility has too many referrals waiting for an answer. Try again later, or choose another.',
  visitLimit: 'This visit already has 5 referrals.',
  attestationOutdated: 'The agreement wording has changed. Read it again and confirm.',
  notPending: 'This referral was already answered or withdrawn. Reload it.',
  expired: 'The time for this step has passed. The referring facility can send a new referral.',
  notAccepted: 'This referral has not been accepted yet. Ask a doctor or clinician to accept it first.',
  notArrived: 'Mark the patient as arrived first, or record \'Did not attend\'.',
  closed: 'This referral is closed.',
  keyReused: 'Idempotency-Key was already used with a different request',
  versionConflict: 'Someone else changed this referral. Reload it and try again.',
  controlOff: 'Referrals between facilities on Health ID are switched off for now. You can print a referral letter instead.',
  sendLimited: 'You have sent the most referrals allowed today. Try again tomorrow.',
  purposeRequired: 'X-Purpose-Of-Use must be direct-care for referrals',
} as const;

/** At most this many cards in the incoming and expected lists. */
export const REFERRAL_LIST_LIMIT = 200;

export type ReferralCard = Record<string, unknown> & { referralId: string; rowVersion: number };
export type ReferralPackage = Record<string, unknown> & { sections: Record<string, unknown[]> };

export interface ReferralSent {
  referral: ReferralCard;
  package: ReferralPackage | null;
  replayed: boolean;
}

export interface ReferralWrite {
  referral: ReferralCard;
  replayed: boolean;
}

export interface ReferralAccepted extends ReferralWrite {
  package: ReferralPackage | null;
}

export interface ReferralDetail {
  referral: ReferralCard;
  package: ReferralPackage | null;
  packageHidden: null | 'chart_access_needed' | 'not_accepted' | 'access_ended';
  history: unknown[];
}

export interface ReferralLetter {
  referral: ReferralCard;
  package: ReferralPackage | null;
  letter: { referringFacilityAddress: string | null; printedAt: string };
}

/** The waiting-list card (EHR-C7) of an arrival, as the waiting list answers it. */
export interface ReferralQueueEntry {
  entryId: string;
  patientId: string;
  fullName: string;
  sex: string | null;
  dateOfBirth: string | null;
  healthIdLast4: string;
  stage: string;
  triageLevel: number | null;
  assignedMembershipId: string | null;
  checkInBasis: 'search' | 'own-facility';
  checkedInAt: string;
  checkInDay: string;
  stageChangedAt: string;
  closedAt: string | null;
  rowVersion: number;
  chartBlocked: boolean;
  recordKind: 'standard';
  dateOfBirthEstimated: boolean;
}

export interface ReferralArrival {
  outcome: 'checked_in' | 'already_on_list';
  referral: ReferralCard;
  entry: ReferralQueueEntry | null;
  replayed: boolean;
}

export type ReferralAccess = 'read' | 'send' | 'receive' | 'arrive' | 'readOrReceive';

export const ATTESTATION_SQL = 'select version, text from ehr.referral_attestation_text($1)';
export const SEND_SQL = `select outcome, replayed, referral, package from ehr.referral_send($1, $2, $3, $4, $5, $6, $7,
  $8, $9, $10, $11, $12::uuid[], $13::uuid[], $14::uuid[], $15::uuid[], $16::uuid[], $17, $18, $19, $20)`;
export const SENT_LIST_SQL = 'select card, next_cursor from ehr.referral_sent_list($1::text[], $2, $3) order by ord';
export const WITHDRAW_SQL = 'select outcome, replayed, referral from ehr.referral_withdraw($1, $2, $3, $4, $5, $6)';
export const LETTER_SQL = 'select outcome, referral, package, letter from ehr.referral_letter($1)';
export const READ_SQL = 'select outcome, referral, package, package_hidden, history from ehr.referral_read($1)';
export const PATIENT_LIST_SQL = 'select outcome, card from ehr.referral_patient_list($1, $2) order by ord';
export const INCOMING_SQL = `select card, waiting_count, urgent_count, has_more from ehr.referral_incoming_list()
  order by ord`;
export const RECEIVED_LIST_SQL = 'select card, next_cursor from ehr.referral_received_list($1::text[], $2, $3) order by ord';
export const ACCEPT_SQL = 'select outcome, replayed, referral, package from ehr.referral_accept($1, $2, $3, $4, $5)';
export const DECLINE_SQL = 'select outcome, replayed, referral from ehr.referral_decline($1, $2, $3, $4, $5, $6)';
export const EXPECTED_SQL = 'select item, has_more from ehr.referral_expected_list() order by ord';
export const ARRIVE_SQL = 'select outcome, replayed, referral, entry from ehr.referral_arrive($1, $2, $3, $4, $5, $6)';
export const COMPLETE_SQL = 'select outcome, replayed, referral from ehr.referral_complete($1, $2, $3, $4, $5, $6)';
export const MY_LIST_SQL = 'select item from ehr.referral_my_list() order by ord';
export const MY_WITHDRAW_SQL = 'select outcome, row_version, state, effective_state from ehr.referral_my_withdraw($1, $2)';

export function referralsEnabled(): boolean {
  return getEnvironment().REFERRALS_ENABLED;
}

export function notAvailable(): DomainProblem {
  return new DomainProblem(503, 'REFERRALS_NOT_AVAILABLE', REFERRAL_MESSAGES.notAvailable);
}

/**
 * The session's codes at this facility, checked before the database decides
 * again: sending also needs ehr.encounter.write, and arrival 0135's pair.
 */
export function requireReferralAccess(request: HidRequest, access: ReferralAccess): void {
  const held = new Set(request.actor?.permissions ?? []);
  if (access === 'arrive') {
    if (!held.has('ehr.referral.arrive') || !held.has('ehr.encounter.read') || !held.has('ehr.encounter.write')) {
      throw new DomainProblem(403, 'REFERRAL_ARRIVAL_NOT_ALLOWED', REFERRAL_MESSAGES.arrivalNotAllowed);
    }
    return;
  }
  const allowed = access === 'readOrReceive' ? held.has('ehr.referral.read') || held.has('ehr.referral.receive')
    : held.has(`ehr.referral.${access}`);
  if (!allowed) throw new DomainProblem(403, 'REFERRAL_NOT_ALLOWED', REFERRAL_MESSAGES.notAllowed);
}

function validation(field: string, message: string): DomainProblem {
  return new DomainProblem(400, 'VALIDATION_FAILED', REFERRAL_MESSAGES.validation, [{ field, messages: [message] }]);
}

/** The states of a list query, each one the list accepts. */
export function listStates(value: string | undefined, allowed: readonly string[]): string[] | null {
  if (value === undefined || value === '') return null;
  const states = [...new Set(value.split(','))];
  if (states.some((state) => !allowed.includes(state))) throw validation('state', 'state must name known states');
  return states;
}

function listLimit(value: string | undefined): number {
  return value === undefined ? 50 : Number(value);
}

/** Every package list without duplicates and within its kind's limit, else REFERRAL_PACKAGE_INVALID. */
export function packageLists(input: SendReferralDto['package']): Record<keyof typeof REFERRAL_PACKAGE_LIMITS, string[]> {
  const lists = {
    diagnosisIds: input?.diagnosisIds ?? [], prescriptionIds: input?.prescriptionIds ?? [],
    allergyIds: input?.allergyIds ?? [], vitalIds: input?.vitalIds ?? [], labResultIds: input?.labResultIds ?? [],
  };
  for (const [key, ids] of Object.entries(lists) as [keyof typeof REFERRAL_PACKAGE_LIMITS, string[]][]) {
    const lower = ids.map((id) => id.toLowerCase());
    if (ids.length > REFERRAL_PACKAGE_LIMITS[key] || new Set(lower).size !== lower.length) {
      throw new DomainProblem(400, 'REFERRAL_PACKAGE_INVALID', REFERRAL_MESSAGES.packageInvalid);
    }
    lists[key] = lower;
  }
  return lists;
}

/** The destination's shape: a facility on Health ID, or a printed letter's facility name (and town). */
export function destinationOf(input: SendReferralDto): { kind: ReferralDestinationKind; facilityId: string | null;
  facilityName: string | null; town: string | null } {
  const destination = input.destination;
  if (destination?.kind === 'health_id' && destination.facilityId !== undefined
      && destination.facilityName === undefined && destination.town === undefined) {
    return { kind: 'health_id', facilityId: destination.facilityId.toLowerCase(), facilityName: null, town: null };
  }
  if (destination?.kind === 'printed' && destination.facilityId === undefined && destination.facilityName !== undefined) {
    return { kind: 'printed', facilityId: null, facilityName: destination.facilityName,
      town: destination.town === undefined || destination.town === '' ? null : destination.town };
  }
  throw new DomainProblem(400, 'REFERRAL_DESTINATION_REQUIRED', REFERRAL_MESSAGES.destinationRequired);
}

interface OutcomeRow extends QueryResultRow {
  outcome: string;
  replayed?: boolean | null;
  referral?: ReferralCard | null;
  package?: ReferralPackage | null;
}

@Injectable()
export class ReferralsService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityApiService) {}

  /** Route 1: the current agreement text of a destination kind. */
  async attestation(context: DataAccessContext, destinationKind: ReferralDestinationKind) {
    const row = await this.one<{ version: string; text: string }>(context, ATTESTATION_SQL, [destinationKind]);
    if (!row) throw notAvailable();
    return { version: row.version, text: row.text };
  }

  /** Route 2: send to a facility on Health ID, or record a printed letter. */
  async send(context: DataAccessContext, patientId: string, encounterId: string, input: SendReferralDto,
    idempotencyKey: string): Promise<ReferralSent> {
    const destination = destinationOf(input);
    const lists = packageLists(input.package);
    if (input.patientAgreed !== true) {
      throw new DomainProblem(400, 'REFERRAL_ATTESTATION_REQUIRED', REFERRAL_MESSAGES.attestationRequired);
    }
    const expectedPrefix = destination.kind === 'health_id' ? 'referral-health-id-attestation-v'
      : 'referral-printed-attestation-v';
    if (!input.attestationTextVersion.startsWith(expectedPrefix)) {
      throw new DomainProblem(409, 'REFERRAL_ATTESTATION_OUTDATED', REFERRAL_MESSAGES.attestationOutdated);
    }
    const serviceWanted = input.serviceWanted === undefined || input.serviceWanted === '' ? null : input.serviceWanted;
    const digest = requestDigest('referral.send', {
      patientId: patientId.toLowerCase(), encounterId: encounterId.toLowerCase(), destination,
      departmentCode: input.departmentCode, serviceWanted, urgency: input.urgency, reason: input.reason,
      letterText: input.letterText, package: lists, attestationTextVersion: input.attestationTextVersion,
      patientAgreed: input.patientAgreed,
    });
    const row = await this.one<OutcomeRow>(context, SEND_SQL, [patientId, encounterId, destination.kind,
      destination.facilityId, destination.facilityName, destination.town, input.departmentCode, serviceWanted,
      input.urgency, input.reason, input.letterText, lists.diagnosisIds, lists.prescriptionIds, lists.allergyIds,
      lists.vitalIds, lists.labResultIds, input.attestationTextVersion, input.patientAgreed, idempotencyKey, digest]);
    if ((row?.outcome === 'sent' || row?.outcome === 'printed') && row.referral) {
      return { referral: row.referral, package: row.package ?? null, replayed: row.replayed === true };
    }
    throw refusal(row?.outcome);
  }

  /** Route 3: this facility's sent referrals (90 days), newest first, without the reason or notes. */
  async sentList(context: DataAccessContext, query: ReferralListQueryDto) {
    const states = listStates(query.state, REFERRAL_EFFECTIVE_STATES);
    const rows = await this.query<{ card: ReferralCard; next_cursor: string | null }>(context, SENT_LIST_SQL,
      [states, listLimit(query.limit), query.cursor ?? null]);
    return { items: rows.map((row) => row.card), nextCursor: rows[0]?.next_cursor ?? null };
  }

  /** Route 4: the referring facility withdraws (sent before respond_by, or a printed letter). */
  async withdraw(context: DataAccessContext, referralId: string, input: WithdrawReferralDto,
    idempotencyKey: string): Promise<ReferralWrite> {
    const note = input.note === undefined || input.note === '' ? null : input.note;
    if ((input.reasonCode === 'sent_in_error' || input.reasonCode === 'other' || note !== null)
        && (note === null || note.length < 8)) {
      throw new DomainProblem(400, 'REFERRAL_REASON_REQUIRED', REFERRAL_MESSAGES.reasonRequired);
    }
    const digest = requestDigest('referral.withdraw', { referralId: referralId.toLowerCase(),
      expectedRowVersion: input.expectedRowVersion, reasonCode: input.reasonCode, note });
    return this.write(context, WITHDRAW_SQL, [referralId, input.expectedRowVersion, input.reasonCode, note,
      idempotencyKey, digest], 'withdrawn');
  }

  /** Route 5: the printable letter; each call is one print (audited). */
  async letter(context: DataAccessContext, referralId: string): Promise<ReferralLetter> {
    const row = await this.one<OutcomeRow & { letter: ReferralLetter['letter'] }>(context, LETTER_SQL, [referralId]);
    if (row?.outcome === 'found' && row.referral) {
      return { referral: row.referral, package: row.package ?? null, letter: row.letter };
    }
    throw refusal(row?.outcome);
  }

  /** Route 7: one referral, from either side, with the package by view level and the history. */
  async read(context: DataAccessContext, referralId: string): Promise<ReferralDetail> {
    const row = await this.one<OutcomeRow & { package_hidden: ReferralDetail['packageHidden']; history: unknown[] }>(
      context, READ_SQL, [referralId]);
    if (row?.outcome === 'found' && row.referral) {
      return { referral: row.referral, package: row.package ?? null, packageHidden: row.package_hidden ?? null,
        history: Array.isArray(row.history) ? row.history : [] };
    }
    throw refusal(row?.outcome);
  }

  /** Route 8: the visit's or the patient page's referrals at this facility. */
  async patientList(context: DataAccessContext, patientId: string, encounterId: string | undefined) {
    const rows = await this.query<{ outcome: string; card: ReferralCard | null }>(context, PATIENT_LIST_SQL,
      [patientId, encounterId ?? null]);
    if (rows[0]?.outcome && rows[0].outcome !== 'found') throw refusal(rows[0].outcome);
    return { items: rows.map((row) => row.card).filter((card): card is ReferralCard => card !== null) };
  }

  /** Route 9: referrals waiting for an answer here, urgent first, then oldest first. */
  async incoming(context: DataAccessContext) {
    const rows = await this.query<{ card: ReferralCard; waiting_count: number; urgent_count: number;
      has_more: boolean }>(context, INCOMING_SQL, []);
    return { items: rows.map((row) => row.card),
      counts: { waiting: Number(rows[0]?.waiting_count ?? 0), urgent: Number(rows[0]?.urgent_count ?? 0) },
      hasMore: rows.some((row) => row.has_more), limit: REFERRAL_LIST_LIMIT };
  }

  /** Route 10: referrals this facility was asked and that no longer wait (90 days), newest first. */
  async receivedList(context: DataAccessContext, query: ReferralListQueryDto) {
    const states = listStates(query.state, ['accepted', 'arrived', 'completed', 'declined', 'withdrawn', 'expired']);
    const rows = await this.query<{ card: ReferralCard; next_cursor: string | null }>(context, RECEIVED_LIST_SQL,
      [states, listLimit(query.limit), query.cursor ?? null]);
    return { items: rows.map((row) => row.card), nextCursor: rows[0]?.next_cursor ?? null };
  }

  /** Route 11: accept (control on, before respond_by). */
  async accept(context: DataAccessContext, referralId: string, input: AcceptReferralDto,
    idempotencyKey: string): Promise<ReferralAccepted> {
    const note = input.note === undefined || input.note === '' ? null : input.note;
    const digest = requestDigest('referral.accept', { referralId: referralId.toLowerCase(),
      expectedRowVersion: input.expectedRowVersion, note });
    const row = await this.one<OutcomeRow>(context, ACCEPT_SQL, [referralId, input.expectedRowVersion, note,
      idempotencyKey, digest]);
    if (row?.outcome === 'accepted' && row.referral) {
      return { referral: row.referral, package: row.package ?? null, replayed: row.replayed === true };
    }
    throw refusal(row?.outcome);
  }

  /** Route 12: decline with a reason and a note (works with the control off). */
  async decline(context: DataAccessContext, referralId: string, input: DeclineReferralDto,
    idempotencyKey: string): Promise<ReferralWrite> {
    const note = input.note ?? '';
    if (note.length < 8) throw new DomainProblem(400, 'REFERRAL_REASON_REQUIRED', REFERRAL_MESSAGES.reasonRequired);
    const digest = requestDigest('referral.decline', { referralId: referralId.toLowerCase(),
      expectedRowVersion: input.expectedRowVersion, reasonCode: input.reasonCode, note });
    return this.write(context, DECLINE_SQL, [referralId, input.expectedRowVersion, input.reasonCode, note,
      idempotencyKey, digest], 'declined');
  }

  /** Route 13: the front desk's expected arrivals: no reason, letter or package (Q-REF-14 A). */
  async expected(context: DataAccessContext) {
    const rows = await this.query<{ item: Record<string, unknown>; has_more: boolean }>(context, EXPECTED_SQL, []);
    return { items: rows.map((row) => row.item), hasMore: rows.some((row) => row.has_more), limit: REFERRAL_LIST_LIMIT };
  }

  /** Route 14: the patient arrived: a fresh search here, or this facility's own patient, then 0135's check-in. */
  async arrive(context: DataAccessContext, referralId: string, input: ArriveReferralDto,
    idempotencyKey: string): Promise<ReferralArrival> {
    const matchRef = input.matchRef === undefined || input.matchRef === '' ? null : input.matchRef;
    const patientId = input.patientId === undefined ? null : input.patientId.toLowerCase();
    if ((matchRef === null) === (patientId === null)) {
      throw new DomainProblem(400, 'REFERRAL_ARRIVAL_NEEDS_ONE_PATIENT', REFERRAL_MESSAGES.arrivalNeedsOnePatient);
    }
    const digest = requestDigest('referral.arrive', { referralId: referralId.toLowerCase(),
      expectedRowVersion: input.expectedRowVersion, matchRef, patientId });
    const row = await this.one<OutcomeRow & { entry: Record<string, unknown> | null }>(context, ARRIVE_SQL,
      [referralId, input.expectedRowVersion, matchRef, patientId, idempotencyKey, digest]);
    if ((row?.outcome === 'checked_in' || row?.outcome === 'already_on_list') && row.referral) {
      return { outcome: row.outcome, referral: row.referral, entry: queueEntry(row.entry),
        replayed: row.replayed === true };
    }
    throw refusal(row?.outcome);
  }

  /** Route 15: the counter-referral (works with the control off). */
  async complete(context: DataAccessContext, referralId: string, input: CompleteReferralDto,
    idempotencyKey: string): Promise<ReferralWrite> {
    const digest = requestDigest('referral.complete', { referralId: referralId.toLowerCase(),
      expectedRowVersion: input.expectedRowVersion, outcome: input.outcome, feedbackNote: input.feedbackNote });
    return this.write(context, COMPLETE_SQL, [referralId, input.expectedRowVersion, input.outcome, input.feedbackNote,
      idempotencyKey, digest], 'completed');
  }

  /** Route 16: the signed-in patient's own referrals from every facility (Q-REF-12 A). */
  async myList(request: HidRequest) {
    const authorization = await this.authorizeSelf(request);
    try {
      return await this.database.withPatientTransaction(authorization, request.correlationId, async (client) => {
        const rows = (await client.query<{ item: Record<string, unknown> }>(MY_LIST_SQL)).rows;
        return { items: rows.map((row) => row.item) };
      });
    } catch (error) {
      throw translate(error);
    }
  }

  /** Route 17: the patient withdraws while the referral waits for an answer (works with the control off). */
  async myWithdraw(request: HidRequest, referralId: string, expectedRowVersion: number) {
    const authorization = await this.authorizeSelf(request);
    let row: { outcome: string; row_version: string | null; state: string | null; effective_state: string | null }
      | undefined;
    try {
      row = await this.database.withPatientTransaction(authorization, request.correlationId, async (client) =>
        (await client.query<{ outcome: string; row_version: string | null; state: string | null;
          effective_state: string | null }>(MY_WITHDRAW_SQL, [referralId, expectedRowVersion])).rows[0]);
    } catch (error) {
      throw translate(error);
    }
    if (row?.outcome === 'withdrawn') {
      return { rowVersion: Number(row.row_version), state: row.state, effectiveState: row.effective_state };
    }
    throw refusal(row?.outcome);
  }

  /** The session's patient, confirmed again by Identity (as the patient's orders sent to other facilities). */
  private async authorizeSelf(request: HidRequest) {
    const actor = request.actor;
    if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', REFERRAL_MESSAGES.patientSessionRequired);
    }
    const authorization = await this.identity.authorizeSelf(request);
    if (authorization.patientId !== actor.patientId || authorization.accountId !== actor.accountId
      || authorization.subject !== actor.subject || authorization.sessionId !== actor.sessionId) {
      throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
    }
    return authorization;
  }

  private async write(context: DataAccessContext, sql: string, values: readonly unknown[],
    success: string): Promise<ReferralWrite> {
    const row = await this.one<OutcomeRow>(context, sql, values);
    if (row?.outcome === success && row.referral) return { referral: row.referral, replayed: row.replayed === true };
    throw refusal(row?.outcome);
  }

  private async one<Row extends QueryResultRow>(context: DataAccessContext, sql: string,
    values: readonly unknown[]): Promise<Row | undefined> {
    return (await this.query<Row>(context, sql, values))[0];
  }

  private async query<Row extends QueryResultRow>(context: DataAccessContext, sql: string,
    values: readonly unknown[]): Promise<Row[]> {
    try {
      return await this.database.withTransaction(context, async (client: PoolClient) =>
        (await client.query<Row>(sql, [...values])).rows);
    } catch (error) {
      throw translate(error);
    }
  }
}

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const time = new Date(String(value));
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
};

/** The waiting-list row of an arrival, mapped as the waiting list maps its card (EHR-C7). */
export function queueEntry(value: Record<string, unknown> | null | undefined): ReferralQueueEntry | null {
  if (!value || typeof value.entry_id !== 'string') return null;
  const text = (key: string): string | null => typeof value[key] === 'string' ? value[key] as string : null;
  return {
    entryId: value.entry_id,
    patientId: String(value.patient_id),
    fullName: String(value.full_name),
    sex: text('sex'),
    dateOfBirth: text('date_of_birth'),
    healthIdLast4: String(value.health_id_last4),
    stage: String(value.stage),
    triageLevel: value.triage_level === null || value.triage_level === undefined ? null : Number(value.triage_level),
    assignedMembershipId: text('assigned_membership_id'),
    checkInBasis: value.check_in_basis === 'own_facility' ? 'own-facility' : 'search',
    checkedInAt: iso(value.checked_in_at) ?? '',
    checkInDay: String(value.queue_day),
    stageChangedAt: iso(value.stage_changed_at) ?? '',
    closedAt: iso(value.closed_at),
    rowVersion: Number(value.row_version),
    chartBlocked: value.chart_blocked === true,
    recordKind: 'standard',
    dateOfBirthEstimated: false,
  };
}

/** An answer that refuses, in plain words. */
export function refusal(outcome: string | undefined): DomainProblem {
  switch (outcome) {
    case 'control_off':
      return new DomainProblem(423, 'CROSS_FACILITY_REFERRALS_UNAVAILABLE', REFERRAL_MESSAGES.controlOff);
    case 'consent_required':
      return new DomainProblem(403, 'CONSENT_REQUIRED', REFERRAL_MESSAGES.consentRequired);
    case 'visit_invalid':
      return new DomainProblem(400, 'REFERRAL_VISIT_INVALID', REFERRAL_MESSAGES.visitInvalid);
    case 'visit_not_signed':
      return new DomainProblem(409, 'REFERRAL_VISIT_NOT_SIGNED', REFERRAL_MESSAGES.visitNotSigned);
    case 'patient_not_identified':
      return new DomainProblem(409, 'REFERRAL_PATIENT_NOT_IDENTIFIED', REFERRAL_MESSAGES.patientNotIdentified);
    case 'attestation_required':
      return new DomainProblem(400, 'REFERRAL_ATTESTATION_REQUIRED', REFERRAL_MESSAGES.attestationRequired);
    case 'attestation_outdated':
      return new DomainProblem(409, 'REFERRAL_ATTESTATION_OUTDATED', REFERRAL_MESSAGES.attestationOutdated);
    case 'patient_app_required':
      return new DomainProblem(409, 'REFERRAL_PATIENT_APP_REQUIRED', REFERRAL_MESSAGES.patientAppRequired);
    case 'patient_denied':
      return new DomainProblem(409, 'REFERRAL_PATIENT_DENIED', REFERRAL_MESSAGES.patientDenied);
    case 'destination_unavailable':
      return new DomainProblem(409, 'REFERRAL_DESTINATION_UNAVAILABLE', REFERRAL_MESSAGES.destinationUnavailable);
    case 'destination_busy':
      return new DomainProblem(409, 'REFERRAL_DESTINATION_BUSY', REFERRAL_MESSAGES.destinationBusy);
    case 'send_limited':
      return new DomainProblem(429, 'REFERRAL_SEND_LIMITED', REFERRAL_MESSAGES.sendLimited);
    case 'visit_limit':
      return new DomainProblem(409, 'REFERRAL_VISIT_LIMIT', REFERRAL_MESSAGES.visitLimit);
    case 'package_invalid':
      return new DomainProblem(400, 'REFERRAL_PACKAGE_INVALID', REFERRAL_MESSAGES.packageInvalid);
    case 'key_reused':
      return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', REFERRAL_MESSAGES.keyReused);
    case 'changed':
      return new DomainProblem(412, 'REFERRAL_VERSION_CONFLICT', REFERRAL_MESSAGES.versionConflict);
    case 'closed':
      return new DomainProblem(409, 'REFERRAL_CLOSED', REFERRAL_MESSAGES.closed);
    case 'not_pending':
      return new DomainProblem(409, 'REFERRAL_NOT_PENDING', REFERRAL_MESSAGES.notPending);
    case 'expired':
      return new DomainProblem(409, 'REFERRAL_EXPIRED', REFERRAL_MESSAGES.expired);
    case 'reason_required':
      return new DomainProblem(400, 'REFERRAL_REASON_REQUIRED', REFERRAL_MESSAGES.reasonRequired);
    case 'not_accepted':
      return new DomainProblem(409, 'REFERRAL_NOT_ACCEPTED', REFERRAL_MESSAGES.notAccepted);
    case 'not_arrived':
      return new DomainProblem(409, 'REFERRAL_NOT_ARRIVED', REFERRAL_MESSAGES.notArrived);
    case 'outcome_invalid':
      return new DomainProblem(400, 'REFERRAL_OUTCOME_INVALID', REFERRAL_MESSAGES.outcomeInvalid);
    case 'needs_search':
      return new DomainProblem(403, 'REFERRAL_ARRIVAL_NEEDS_SEARCH', REFERRAL_MESSAGES.arrivalNeedsSearch);
    default:
      return new DomainProblem(404, 'REFERRAL_NOT_FOUND', REFERRAL_MESSAGES.notFound);
  }
}

/** The functions' own raised refusals, in plain words; anything else is passed on. */
export function translate(error: unknown): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if (code === '42501') {
    if (message === 'REFERRAL_ARRIVAL_NOT_ALLOWED') {
      return new DomainProblem(403, 'REFERRAL_ARRIVAL_NOT_ALLOWED', REFERRAL_MESSAGES.arrivalNotAllowed);
    }
    if (message === 'PATIENT_SESSION_REQUIRED') {
      return new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', REFERRAL_MESSAGES.patientSessionRequired);
    }
    return new DomainProblem(403, 'REFERRAL_NOT_ALLOWED', REFERRAL_MESSAGES.notAllowed);
  }
  if (code === '22023') {
    switch (message) {
      case 'REFERRAL_ARRIVAL_NEEDS_ONE_PATIENT':
        return new DomainProblem(400, 'REFERRAL_ARRIVAL_NEEDS_ONE_PATIENT', REFERRAL_MESSAGES.arrivalNeedsOnePatient);
      case 'REFERRAL_IDEMPOTENCY_KEY_INVALID':
        return new DomainProblem(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key must contain 16 to 128 URL-safe characters');
      default:
        return new DomainProblem(400, 'VALIDATION_FAILED', REFERRAL_MESSAGES.validation);
    }
  }
  if (code === '40P01' || code === '40001') {
    return new DomainProblem(412, 'REFERRAL_VERSION_CONFLICT', REFERRAL_MESSAGES.versionConflict);
  }
  if (code === '42883' || code === '42P01') {
    // A new image on a schema without 0191 (or, for routes 7-17, 0192): the routes stay closed.
    return notAvailable();
  }
  return error;
}
