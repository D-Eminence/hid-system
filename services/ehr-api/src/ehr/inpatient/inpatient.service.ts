import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import type {
  AdmissionListQueryDto, AdmitDto, BandPrintDto, BedStatusDto, CancelAdmissionDto, CreateBedDto, CreateWardDto,
  DeathRecordAmendDto, DeathRecordDto, DischargeDto, PrepareDischargeDto, RequestAdmissionDto, TransferDto,
  UpdateAdmissionDto, UpdateBedDto, UpdateWardDto, WardChargesDto, WardStaffDto,
} from './inpatient.dto';

/**
 * ADT-1 (0170-0173): inpatient admission, wards and beds, transfers and
 * discharge, built at the owner's decisions of 25 November 2026 (Q147-Q290 at
 * the recommended options: Q184-Q194, Q156, Q149, Q201, Q202) and the
 * section's smaller choices Q-ADT-9 A to Q-ADT-18 A.
 *
 * Every route works through 0170-0172's SECURITY DEFINER functions, which
 * check the caller (an active membership here, the route's access code, the
 * purpose, the facility's seal and, for a clinical step, write access to the
 * chart), decide, and audit in the request's transaction, refusals included.
 * The functions answer JSON; this service turns their refusals into plain
 * words and never adds a Health ID, NIN or name to a log or audit row.
 *
 * Until the owner's go-live, INPATIENT_ENABLED is off in production and every
 * route answers 503 INPATIENT_NOT_AVAILABLE; a database without 0170 answers
 * the same. No Health ID or NIN appears in any path or query.
 */

/** The plain-words messages of the inpatient refusals. Staff screens show these and never the word "permission". */
export const INPATIENT_MESSAGES = {
  notAvailable: 'Inpatient care is not switched on yet.',
  validation: 'Check the highlighted fields.',
  sourceInvalid: 'Choose where this admission comes from: a visit, the emergency board, the waiting list, or direct.',
  responsibleInvalid: 'Choose a doctor or clinician who works at this facility.',
  wardStaffInvalid: 'Choose nurses, clinicians and doctors who work at this facility.',
  motherInvalid: 'Choose the mother\'s current admission at this facility.',
  summaryRequired: 'Write the discharge summary before discharging the patient.',
  diedAtRequired: 'Enter the time of death.',
  dischargeTimeInvalid: 'The discharge time must be after admission, and not in the future.',
  signatureRequired: 'Type SIGN to sign.',
  reprintReasonRequired: 'Say why the band is being printed again.',
  inpatientNotAllowed: 'Only nurses, clinicians and doctors of this facility can use the wards.',
  wardSetupNotAllowed: 'Only the facility\'s admins can set up wards and beds.',
  decideNotAllowed: 'Only doctors and clinicians can admit, change or discharge a patient.',
  allocateNotAllowed: 'Only nurses, clinicians and doctors can give or change a bed.',
  chartAccessRequired: 'Open this patient\'s record first, then try again.',
  notFound: 'This ward, bed or admission is not at this facility.',
  nameTaken: 'This name is already used. Choose another.',
  wardNotEmpty: 'Move every patient out of this ward first.',
  bedOccupied: 'A patient is in this bed. Move or discharge them first.',
  bedNotAvailable: 'This bed is not free. Choose another bed or overflow space.',
  bedLimit: 'This ward has as many beds (200) or overflow spaces (50) as it can have.',
  sexMismatch: 'This ward takes only men (or only women). Confirm to admit this patient here.',
  alreadyOpen: 'This patient is already admitted or waiting for a bed here.',
  stateInvalid: 'This admission has moved on. Reload it to see where it is now.',
  notPrepared: 'Prepare the discharge first.',
  versionConflict: 'Someone else changed this. Reload it and try again.',
  keyReused: 'Idempotency-Key was already used with a different request',
  deathRecordNotAvailable: 'The death certificate is not switched on yet. The outcome and time of death are recorded.',
  deathRecordExists: 'A death certificate is already recorded for this admission. Amend it instead.',
  directCareOnly: 'X-Purpose-Of-Use must be direct-care for the wards (healthcare-operations for ward setup)',
  billingNotAllowed: 'Only billing staff of this facility can do this.',
} as const;

export type WardResource = 'ward' | 'bed' | 'admission';

export function inpatientEnabled(): boolean {
  return getEnvironment().INPATIENT_ENABLED;
}

export function notAvailable(): DomainProblem {
  return new DomainProblem(503, 'INPATIENT_NOT_AVAILABLE', INPATIENT_MESSAGES.notAvailable);
}

/**
 * The access a route needs, checked on the session's codes at this facility
 * before the database decides again (403 in plain words).
 */
export type InpatientAccess = 'ward_read' | 'ward_list' | 'ward_manage' | 'bed_status' | 'bed_allocate'
  | 'admission_read' | 'admission_decide' | 'wristband' | 'death_record';

export function requireInpatientAccess(request: HidRequest, access: InpatientAccess): void {
  const held = new Set(request.actor?.permissions ?? []);
  const has = (code: string) => held.has(code);
  switch (access) {
    case 'ward_manage':
      if (!has('ehr.ward.manage')) throw new DomainProblem(403, 'WARD_SETUP_NOT_ALLOWED', INPATIENT_MESSAGES.wardSetupNotAllowed);
      return;
    case 'ward_list':
      if (!has('ehr.ward.read') && !has('ehr.ward.manage')) {
        throw new DomainProblem(403, 'INPATIENT_NOT_ALLOWED', INPATIENT_MESSAGES.inpatientNotAllowed);
      }
      return;
    case 'bed_status':
      if (!(has('ehr.ward.read') && has('ehr.bed.allocate')) && !has('ehr.ward.manage')) {
        throw new DomainProblem(403, 'BED_ALLOCATE_NOT_ALLOWED', INPATIENT_MESSAGES.allocateNotAllowed);
      }
      return;
    default:
  }
  if (!has('ehr.ward.read')) throw new DomainProblem(403, 'INPATIENT_NOT_ALLOWED', INPATIENT_MESSAGES.inpatientNotAllowed);
  if (access === 'bed_allocate' && !has('ehr.bed.allocate')) {
    throw new DomainProblem(403, 'BED_ALLOCATE_NOT_ALLOWED', INPATIENT_MESSAGES.allocateNotAllowed);
  }
  if ((access === 'admission_read' || access === 'death_record') && !has('ehr.admission.read')) {
    throw new DomainProblem(403, 'INPATIENT_NOT_ALLOWED', INPATIENT_MESSAGES.inpatientNotAllowed);
  }
  if (access === 'wristband' && !has('ehr.wristband.print')) {
    throw new DomainProblem(403, 'INPATIENT_NOT_ALLOWED', INPATIENT_MESSAGES.inpatientNotAllowed);
  }
  if (access === 'admission_decide' && !(has('ehr.admission.read') && has('ehr.admission.decide'))) {
    throw new DomainProblem(403, 'ADMISSION_DECIDE_NOT_ALLOWED', INPATIENT_MESSAGES.decideNotAllowed);
  }
}

function validation(field: string, message: string): DomainProblem {
  return new DomainProblem(400, 'VALIDATION_FAILED', INPATIENT_MESSAGES.validation, [{ field, messages: [message] }]);
}

type Answer = Record<string, unknown> & { outcome?: string; replayed?: boolean };

/** A refusal the function answered, in plain words. */
export function refusal(outcome: string | undefined, resource: WardResource, answer?: Answer): DomainProblem {
  const versionCode = resource === 'admission' ? 'ADMISSION_VERSION_CONFLICT' : 'WARD_VERSION_CONFLICT';
  switch (outcome) {
    case 'not_found':
      return new DomainProblem(404, `${resource.toUpperCase()}_NOT_FOUND`, INPATIENT_MESSAGES.notFound);
    case 'bed_not_found':
      return new DomainProblem(404, 'BED_NOT_FOUND', INPATIENT_MESSAGES.notFound);
    case 'ward_not_found':
      return new DomainProblem(404, 'WARD_NOT_FOUND', INPATIENT_MESSAGES.notFound);
    case 'name_taken':
      return new DomainProblem(409, resource === 'bed' ? 'BED_NAME_TAKEN' : 'WARD_NAME_TAKEN', INPATIENT_MESSAGES.nameTaken);
    case 'not_empty':
      return new DomainProblem(409, 'WARD_NOT_EMPTY', INPATIENT_MESSAGES.wardNotEmpty);
    case 'occupied':
      return new DomainProblem(409, 'BED_OCCUPIED', INPATIENT_MESSAGES.bedOccupied);
    case 'limit_reached':
      return new DomainProblem(409, 'BED_LIMIT_REACHED', INPATIENT_MESSAGES.bedLimit);
    case 'staff_invalid':
      return new DomainProblem(400, 'WARD_STAFF_INVALID', INPATIENT_MESSAGES.wardStaffInvalid);
    case 'status_invalid':
      return validation('status', 'this bed cannot move to that status');
    case 'note_required':
      return validation('note', 'say why the bed is placed in maintenance (8-300 characters)');
    case 'changed':
      return new DomainProblem(412, versionCode, INPATIENT_MESSAGES.versionConflict);
    case 'key_reused':
      return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', INPATIENT_MESSAGES.keyReused);
    case 'chart_access_required':
      return new DomainProblem(403, 'ADMISSION_CHART_ACCESS_REQUIRED', INPATIENT_MESSAGES.chartAccessRequired);
    case 'already_open':
      return new DomainProblem(409, 'ADMISSION_ALREADY_OPEN', INPATIENT_MESSAGES.alreadyOpen, undefined,
        typeof answer?.openAdmissionId === 'string' ? { admissionId: answer.openAdmissionId } : undefined);
    case 'source_invalid':
      return new DomainProblem(400, 'ADMISSION_SOURCE_INVALID', INPATIENT_MESSAGES.sourceInvalid);
    case 'responsible_invalid':
      return new DomainProblem(400, 'RESPONSIBLE_DOCTOR_INVALID', INPATIENT_MESSAGES.responsibleInvalid);
    case 'mother_invalid':
      return new DomainProblem(400, 'MOTHER_ADMISSION_INVALID', INPATIENT_MESSAGES.motherInvalid);
    case 'state_invalid':
      return new DomainProblem(409, 'ADMISSION_STATE_INVALID', INPATIENT_MESSAGES.stateInvalid);
    case 'bed_not_available':
      return new DomainProblem(409, 'BED_NOT_AVAILABLE', INPATIENT_MESSAGES.bedNotAvailable);
    case 'sex_mismatch':
      return new DomainProblem(409, 'WARD_SEX_MISMATCH', INPATIENT_MESSAGES.sexMismatch);
    case 'not_prepared':
      return new DomainProblem(409, 'DISCHARGE_NOT_PREPARED', INPATIENT_MESSAGES.notPrepared);
    case 'time_invalid':
      return new DomainProblem(400, 'DISCHARGE_TIME_INVALID', INPATIENT_MESSAGES.dischargeTimeInvalid);
    case 'expected_date_invalid':
      return validation('expectedDischargeOn', 'the expected discharge date must be from the admission day, within a year');
    case 'medicines_invalid':
      return validation('dischargeMedicineIds', 'choose prescriptions written during this stay');
    case 'reprint_reason_required':
      return new DomainProblem(400, 'REPRINT_REASON_REQUIRED', INPATIENT_MESSAGES.reprintReasonRequired);
    case 'already_recorded':
      return new DomainProblem(409, 'DEATH_RECORD_EXISTS', INPATIENT_MESSAGES.deathRecordExists);
    default:
      return new DomainProblem(404, `${resource.toUpperCase()}_NOT_FOUND`, INPATIENT_MESSAGES.notFound);
  }
}

const RAISED_400: Readonly<Record<string, [string, string]>> = {
  ADMISSION_SOURCE_INVALID: ['ADMISSION_SOURCE_INVALID', INPATIENT_MESSAGES.sourceInvalid],
  DISCHARGE_SUMMARY_REQUIRED: ['DISCHARGE_SUMMARY_REQUIRED', INPATIENT_MESSAGES.summaryRequired],
  DIED_AT_REQUIRED: ['DIED_AT_REQUIRED', INPATIENT_MESSAGES.diedAtRequired],
  SIGNATURE_REQUIRED: ['SIGNATURE_REQUIRED', INPATIENT_MESSAGES.signatureRequired],
  INPATIENT_PURPOSE_REQUIRED: ['PURPOSE_OF_USE_REQUIRED', INPATIENT_MESSAGES.directCareOnly],
  INPATIENT_IDEMPOTENCY_KEY_INVALID: ['IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key must contain 16 to 128 URL-safe characters'],
};

const RAISED_403: Readonly<Record<string, string>> = {
  INPATIENT_NOT_ALLOWED: INPATIENT_MESSAGES.inpatientNotAllowed,
  WARD_SETUP_NOT_ALLOWED: INPATIENT_MESSAGES.wardSetupNotAllowed,
  ADMISSION_DECIDE_NOT_ALLOWED: INPATIENT_MESSAGES.decideNotAllowed,
  BED_ALLOCATE_NOT_ALLOWED: INPATIENT_MESSAGES.allocateNotAllowed,
};

/** The functions' own refusals, in plain words; anything else is passed on. */
export function translate(error: unknown, resource: WardResource = 'admission'): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? String((error as { message?: unknown }).message) : '';
  if (code === '42501') {
    return new DomainProblem(403, RAISED_403[message] ? message : 'INPATIENT_NOT_ALLOWED',
      RAISED_403[message] ?? INPATIENT_MESSAGES.inpatientNotAllowed);
  }
  if (code === '22023') {
    const known = RAISED_400[message];
    if (known) return new DomainProblem(400, known[0], known[1]);
    return new DomainProblem(400, 'VALIDATION_FAILED', INPATIENT_MESSAGES.validation);
  }
  if (code === '55000' && message === 'DEATH_RECORD_NOT_AVAILABLE') {
    return new DomainProblem(503, 'DEATH_RECORD_NOT_AVAILABLE', INPATIENT_MESSAGES.deathRecordNotAvailable);
  }
  if (code === '40P01') {
    return new DomainProblem(412, resource === 'admission' ? 'ADMISSION_VERSION_CONFLICT' : 'WARD_VERSION_CONFLICT',
      INPATIENT_MESSAGES.versionConflict);
  }
  if (code === '23505') {
    // Two requests at once on one bed or one patient: the second finds the first's row (one patient per bed).
    return new DomainProblem(409, 'BED_NOT_AVAILABLE', INPATIENT_MESSAGES.bedNotAvailable);
  }
  if (code === '42883' || code === '42P01') {
    // A new image on a schema without 0170-0173: the routes stay closed until the migrations are applied.
    return notAvailable();
  }
  return error;
}

/** BILL-1's SQLSTATEs (HB4nn) for the charge routes, in plain words. */
export function translateBilling(error: unknown): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code) : '';
  const message = typeof error === 'object' && error !== null ? String((error as { message?: unknown }).message) : '';
  switch (code) {
    case 'HB400':
      return new DomainProblem(400, 'VALIDATION_FAILED', INPATIENT_MESSAGES.validation);
    case 'HB403':
      return new DomainProblem(403, 'BILLING_NOT_ALLOWED', INPATIENT_MESSAGES.billingNotAllowed);
    case 'HB404':
      return new DomainProblem(404, message === 'WARD_NOT_FOUND' ? 'WARD_NOT_FOUND' : 'BILL_NOT_FOUND',
        message === 'WARD_NOT_FOUND' ? INPATIENT_MESSAGES.notFound : 'This bill is not at this facility.');
    case 'HB409':
      return new DomainProblem(409, message || 'CONFLICT', 'This cannot be done to this bill now.');
    case 'HB412':
      return new DomainProblem(412, 'VERSION_CONFLICT', INPATIENT_MESSAGES.versionConflict);
    case '42883':
    case '42P01':
      // A database without BILL-1 or 0172: patient billing is not there.
      return new DomainProblem(503, 'BILLING_NOT_AVAILABLE', 'Patient billing is not switched on at this facility yet.');
    default:
      return translate(error);
  }
}

@Injectable()
export class InpatientService {
  constructor(private readonly database: DatabaseService) {}

  // Ward setup (routes 1-6).

  async listWards(context: DataAccessContext, includeInactive: boolean, includeBeds: boolean): Promise<unknown> {
    return this.call(context, 'ward', 'select ehr.ward_list($1, $2) as answer', [includeInactive, includeBeds], true);
  }

  async createWard(context: DataAccessContext, input: CreateWardDto, key: string): Promise<unknown> {
    const digest = requestDigest('inpatient.ward.create', { ...input });
    return this.write(context, 'ward', 'select ehr.ward_create($1, $2, $3, $4, $5) as answer',
      [input.name, input.wardType, input.takes ?? 'any', key, digest], ['created'], 'ward');
  }

  async updateWard(context: DataAccessContext, wardId: string, input: UpdateWardDto, key: string): Promise<unknown> {
    if (input.name === undefined && input.wardType === undefined && input.takes === undefined && input.active === undefined) {
      throw validation('name', 'choose what to change');
    }
    const digest = requestDigest('inpatient.ward.update', { wardId, ...input });
    return this.write(context, 'ward', 'select ehr.ward_update($1, $2, $3, $4, $5, $6, $7, $8) as answer',
      [wardId, input.expectedRowVersion, input.name ?? null, input.wardType ?? null, input.takes ?? null,
        input.active ?? null, key, digest], ['updated'], 'ward');
  }

  async createBed(context: DataAccessContext, wardId: string, input: CreateBedDto, key: string): Promise<unknown> {
    const digest = requestDigest('inpatient.bed.create', { wardId, ...input });
    return this.write(context, 'bed', 'select ehr.bed_create($1, $2, $3, $4, $5) as answer',
      [wardId, input.name, input.kind ?? 'bed', key, digest], ['created'], null);
  }

  async updateBed(context: DataAccessContext, bedId: string, input: UpdateBedDto, key: string): Promise<unknown> {
    if (input.name === undefined && input.active === undefined) throw validation('name', 'choose what to change');
    const digest = requestDigest('inpatient.bed.update', { bedId, ...input });
    return this.write(context, 'bed', 'select ehr.bed_update($1, $2, $3, $4, $5, $6) as answer',
      [bedId, input.expectedRowVersion, input.name ?? null, input.active ?? null, key, digest], ['updated'], null);
  }

  async setWardStaff(context: DataAccessContext, wardId: string, input: WardStaffDto, key: string): Promise<unknown> {
    const digest = requestDigest('inpatient.ward.staff', { wardId, expectedRowVersion: input.expectedRowVersion,
      membershipIds: [...new Set(input.membershipIds)].sort() });
    return this.write(context, 'ward', 'select ehr.ward_staff_set($1, $2, $3::uuid[], $4, $5) as answer',
      [wardId, input.expectedRowVersion, [...new Set(input.membershipIds)], key, digest], ['updated'], 'ward');
  }

  // Bed board, census, bed status (routes 7-9).

  async bedBoard(context: DataAccessContext, wardId: string | undefined, wardType: string | undefined): Promise<unknown> {
    if ((wardId === undefined) === (wardType === undefined)) throw validation('wardId', 'give a ward or a ward type');
    const answer = await this.one(context, 'ward', 'select ehr.bed_board($1, $2) as answer', [wardId ?? null, wardType ?? null]);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, 'ward', answer);
    return { wards: answer.wards, waitingForBed: answer.waitingForBed };
  }

  async census(context: DataAccessContext, date: string | undefined): Promise<unknown> {
    return this.call(context, 'ward', 'select ehr.inpatient_census($1::date) as answer', [date ?? null], true);
  }

  async setBedStatus(context: DataAccessContext, bedId: string, input: BedStatusDto, key: string): Promise<unknown> {
    const digest = requestDigest('inpatient.bed.status', { bedId, ...input });
    return this.write(context, 'bed', 'select ehr.bed_set_status($1, $2, $3, $4, $5, $6) as answer',
      [bedId, input.expectedRowVersion, input.status, input.note ?? null, key, digest], ['updated'], 'bed');
  }

  // Admissions (routes 10-21).

  async request(context: DataAccessContext, input: RequestAdmissionDto, key: string): Promise<unknown> {
    if ((input.source === 'consultation') !== (input.fromEncounterId !== undefined)
        || (input.source === 'ed') !== (input.edAttendanceId !== undefined)
        || (input.source === 'waiting_list') !== (input.visitQueueEntryId !== undefined)) {
      throw new DomainProblem(400, 'ADMISSION_SOURCE_INVALID', INPATIENT_MESSAGES.sourceInvalid);
    }
    if (input.source !== 'ed' && input.responsibleMembershipId === undefined) {
      throw new DomainProblem(400, 'RESPONSIBLE_DOCTOR_INVALID', INPATIENT_MESSAGES.responsibleInvalid);
    }
    const digest = requestDigest('inpatient.admission.request', { ...input });
    return this.admissionWrite(context,
      'select ehr.admission_request($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as answer',
      [input.patientId, input.source, input.fromEncounterId ?? null, input.edAttendanceId ?? null,
        input.visitQueueEntryId ?? null, input.reason, input.careTeam ?? null, input.responsibleMembershipId ?? null,
        input.requestedWardId ?? null, input.motherAdmissionId ?? null, key, digest], ['created']);
  }

  async list(context: DataAccessContext, query: AdmissionListQueryDto): Promise<unknown> {
    const answer = await this.one(context, 'admission', 'select ehr.admission_list($1, $2, $3) as answer',
      [query.status ?? null, query.wardId ?? null, query.wardType ?? null]);
    const items = Array.isArray(answer.items) ? answer.items as Record<string, unknown>[] : [];
    return { items: await this.withBills(context, items), hasMore: answer.hasMore === true, limit: answer.limit };
  }

  async read(context: DataAccessContext, admissionId: string): Promise<unknown> {
    const answer = await this.one(context, 'admission', 'select ehr.admission_read($1) as answer', [admissionId]);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, 'admission', answer);
    const [admission] = await this.withBills(context, [answer.admission as Record<string, unknown>]);
    return { admission, movements: answer.movements };
  }

  async admit(context: DataAccessContext, admissionId: string, input: AdmitDto, key: string): Promise<unknown> {
    const digest = requestDigest('inpatient.admission.admit', { admissionId, ...input });
    return this.admissionWrite(context, 'select ehr.admission_admit($1, $2, $3, $4, $5, $6) as answer',
      [admissionId, input.expectedRowVersion, input.bedId, input.confirmSexMismatch === true, key, digest], ['updated']);
  }

  async transfer(context: DataAccessContext, admissionId: string, input: TransferDto, key: string): Promise<unknown> {
    const digest = requestDigest('inpatient.admission.transfer', { admissionId, ...input });
    return this.admissionWrite(context, 'select ehr.admission_transfer($1, $2, $3, $4, $5, $6, $7) as answer',
      [admissionId, input.expectedRowVersion, input.bedId, input.handover ?? null, input.confirmSexMismatch === true,
        key, digest], ['updated']);
  }

  async handover(context: DataAccessContext, admissionId: string, movementId: string): Promise<unknown> {
    const answer = await this.one(context, 'admission', 'select ehr.admission_handover_read($1, $2) as answer',
      [admissionId, movementId]);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, 'admission', answer);
    return { movementId: answer.movementId, handover: answer.handover, at: answer.at, byMembershipId: answer.byMembershipId };
  }

  async prepareDischarge(context: DataAccessContext, admissionId: string, input: PrepareDischargeDto,
    key: string): Promise<unknown> {
    const medicines = [...new Set(input.dischargeMedicineIds ?? [])];
    const digest = requestDigest('inpatient.admission.prepare', { admissionId, ...input, dischargeMedicineIds: medicines });
    return this.admissionWrite(context,
      'select ehr.admission_prepare_discharge($1, $2, $3, $4::date, $5::uuid[], $6, $7) as answer',
      [admissionId, input.expectedRowVersion, input.followUpPlan, input.expectedDischargeOn ?? null, medicines, key, digest],
      ['updated']);
  }

  async discharge(context: DataAccessContext, admissionId: string, input: DischargeDto, key: string): Promise<unknown> {
    if (input.outcome === 'died' && !input.diedAt) {
      throw new DomainProblem(400, 'DIED_AT_REQUIRED', INPATIENT_MESSAGES.diedAtRequired);
    }
    if (input.outcome !== 'died' && input.diedAt) throw validation('diedAt', 'only for the outcome died');
    if ((input.outcome === 'referred_out') !== Boolean(input.referredToFacilityName)) {
      throw validation('referredToFacilityName', 'the facility the patient is referred to, for referred_out only');
    }
    if (!input.summary && ['routine', 'dama', 'referred_out'].includes(input.outcome)) {
      throw new DomainProblem(400, 'DISCHARGE_SUMMARY_REQUIRED', INPATIENT_MESSAGES.summaryRequired);
    }
    if (input.signature?.trim().toUpperCase() !== 'SIGN') {
      throw new DomainProblem(400, 'SIGNATURE_REQUIRED', INPATIENT_MESSAGES.signatureRequired);
    }
    const digest = requestDigest('inpatient.admission.discharge', { admissionId, ...input });
    const result = await this.admissionWrite(context,
      'select ehr.admission_discharge($1, $2, $3, $4::timestamptz, $5::jsonb, $6, $7::timestamptz, $8, $9, $10) as answer',
      [admissionId, input.expectedRowVersion, input.outcome, input.dischargedAt ?? null,
        input.summary ? JSON.stringify(input.summary) : null, input.referredToFacilityName ?? null, input.diedAt ?? null,
        input.signature, key, digest], ['updated'], true);
    return result;
  }

  async cancel(context: DataAccessContext, admissionId: string, input: CancelAdmissionDto, key: string): Promise<unknown> {
    const digest = requestDigest('inpatient.admission.cancel', { admissionId, ...input });
    return this.admissionWrite(context, 'select ehr.admission_cancel($1, $2, $3, $4, $5) as answer',
      [admissionId, input.expectedRowVersion, input.reason, key, digest], ['updated']);
  }

  async update(context: DataAccessContext, admissionId: string, input: UpdateAdmissionDto, key: string): Promise<unknown> {
    if (input.careTeam === undefined && input.responsibleMembershipId === undefined
        && input.expectedDischargeOn === undefined && input.reason === undefined) {
      throw validation('careTeam', 'choose what to change');
    }
    const digest = requestDigest('inpatient.admission.update', { admissionId, ...input });
    return this.admissionWrite(context, 'select ehr.admission_update($1, $2, $3, $4, $5::date, $6, $7, $8) as answer',
      [admissionId, input.expectedRowVersion, input.careTeam ?? null, input.responsibleMembershipId ?? null,
        input.expectedDischargeOn ?? null, input.reason ?? null, key, digest], ['updated']);
  }

  async dischargeSummary(context: DataAccessContext, admissionId: string): Promise<unknown> {
    const answer = await this.one(context, 'admission', 'select ehr.discharge_summary_print($1) as answer', [admissionId]);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, 'admission', answer);
    return answer.print;
  }

  async wristband(context: DataAccessContext, admissionId: string, input: BandPrintDto, key: string,
    newborn: boolean): Promise<unknown> {
    const digest = requestDigest(newborn ? 'inpatient.newborn-band' : 'inpatient.wristband',
      { admissionId, reprintReason: input.reprintReason ?? null });
    const answer = await this.one(context, 'admission',
      `select ehr.${newborn ? 'newborn_band_print' : 'wristband_print'}($1, $2, $3, $4) as answer`,
      [admissionId, input.reprintReason ?? null, key, digest]);
    if (answer.outcome !== 'printed') throw refusal(answer.outcome, 'admission', answer);
    return { ...(answer.band as Record<string, unknown>), replayed: answer.replayed === true };
  }

  // The death record (route 22, switched off).

  async deathRecordWrite(context: DataAccessContext, admissionId: string, input: DeathRecordDto): Promise<unknown> {
    const answer = await this.one(context, 'admission', 'select ehr.death_record_write($1, $2::jsonb) as answer',
      [admissionId, JSON.stringify(input)]);
    if (answer.outcome !== 'created') throw refusal(answer.outcome, 'admission', answer);
    return answer.deathRecord;
  }

  async deathRecordRead(context: DataAccessContext, admissionId: string): Promise<unknown> {
    const answer = await this.one(context, 'admission', 'select ehr.death_record_read($1) as answer', [admissionId]);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, 'admission', answer);
    return answer.deathRecord;
  }

  async deathRecordAmend(context: DataAccessContext, admissionId: string, input: DeathRecordAmendDto): Promise<unknown> {
    const { reason, ...content } = input;
    const answer = await this.one(context, 'admission', 'select ehr.death_record_amend($1, $2::jsonb, $3) as answer',
      [admissionId, JSON.stringify(content), reason]);
    if (answer.outcome !== 'updated') throw refusal(answer.outcome, 'admission', answer);
    return answer.deathRecord;
  }

  async deathRecordPrint(context: DataAccessContext, admissionId: string, form: string): Promise<unknown> {
    const answer = await this.one(context, 'admission', 'select ehr.death_record_print($1, $2) as answer',
      [admissionId, form]);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, 'admission', answer);
    return answer.print;
  }

  // Charges (Q189, needs BILL-1 and 0172).

  async wardCharges(context: DataAccessContext): Promise<unknown> {
    return this.billing(context, 'select commercial.ward_charges_list() as answer', []);
  }

  async setWardCharges(context: DataAccessContext, wardId: string, input: WardChargesDto): Promise<unknown> {
    return this.billing(context, 'select commercial.ward_charges_set($1, $2, $3, $4) as answer',
      [wardId, input.expectedVersion, input.bedDayItemId ?? null, input.admissionFeeItemId ?? null]);
  }

  async interimStatement(context: DataAccessContext, billId: string): Promise<unknown> {
    return this.billing(context, 'select commercial.interim_statement($1) as answer', [billId]);
  }

  private async billing(context: DataAccessContext, sql: string, values: readonly unknown[]): Promise<unknown> {
    try {
      return await this.database.withTransaction(context, async (client: PoolClient) =>
        (await client.query<{ answer: unknown }>(sql, [...values])).rows[0]?.answer);
    } catch (error) {
      throw translateBilling(error);
    }
  }

  /**
   * The admission bill of each card (Q189), when the facility uses billing
   * and 0172 is applied; otherwise every billId stays null. The admission
   * functions never read the bill; this is a read after the answer.
   */
  private async withBills(context: DataAccessContext, cards: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const ids = cards.map((card) => card.admissionId).filter((id): id is string => typeof id === 'string');
    if (ids.length === 0) return cards;
    try {
      const rows = await this.database.withTransaction(context, async (client: PoolClient) =>
        (await client.query<{ admission_id: string; bill_id: string }>(
          'select admission_id, bill_id from commercial.admission_bill_ids($1::uuid[])', [ids])).rows);
      const bills = new Map(rows.map((row) => [row.admission_id, row.bill_id]));
      return cards.map((card) => ({ ...card, billId: bills.get(String(card.admissionId)) ?? null }));
    } catch {
      return cards;
    }
  }

  private async admissionWrite(context: DataAccessContext, sql: string, values: readonly unknown[],
    accepted: readonly string[], withSummary = false): Promise<unknown> {
    const answer = await this.one(context, 'admission', sql, values);
    if (!answer.outcome || !accepted.includes(answer.outcome)) throw refusal(answer.outcome, 'admission', answer);
    const [admission] = await this.withBills(context, [answer.admission as Record<string, unknown>]);
    return withSummary
      ? { admission, summaryNoteId: answer.summaryNoteId ?? null, replayed: answer.replayed === true }
      : { admission, replayed: answer.replayed === true };
  }

  private async write(context: DataAccessContext, resource: WardResource, sql: string, values: readonly unknown[],
    accepted: readonly string[], key: 'ward' | 'bed' | null): Promise<unknown> {
    const answer = await this.one(context, resource, sql, values);
    if (!answer.outcome || !accepted.includes(answer.outcome)) throw refusal(answer.outcome, resource, answer);
    const { outcome: _outcome, ...rest } = answer;
    return key === null ? rest : { [key]: answer[key], replayed: answer.replayed === true };
  }

  private async call(context: DataAccessContext, resource: WardResource, sql: string, values: readonly unknown[],
    _plain: boolean): Promise<unknown> {
    return this.one(context, resource, sql, values);
  }

  private async one(context: DataAccessContext, resource: WardResource, sql: string,
    values: readonly unknown[]): Promise<Answer> {
    try {
      return await this.database.withTransaction(context, async (client: PoolClient) =>
        ((await client.query<{ answer: Answer }>(sql, [...values])).rows[0]?.answer ?? {}));
    } catch (error) {
      throw translate(error, resource);
    }
  }
}

/**
 * Q-ADT-13 A: adds the bed-days due (one per Lagos midnight each open
 * admission has passed, at the ward's rate) every hour, through 0172's
 * commercial.accrue_bed_days_due (one audit row per bed-day added). A bed-day
 * is never added twice. Not started in tests, nor while INPATIENT_ENABLED is
 * off. Failures (a database without BILL-1 or 0172 among them) are logged once
 * with no identifier and tried again next hour.
 */
@Injectable()
export class InpatientBedDaySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InpatientBedDaySweeper.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || !inpatientEnabled()) return;
    this.timer = setInterval(() => { void this.sweep(); }, 60 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    try {
      return await this.database.withSystemTransaction(`inpatient-bed-day-sweep-${randomUUID()}`, async (client) =>
        Number((await client.query<{ added: number }>('select commercial.accrue_bed_days_due(null) as added')).rows[0]?.added
          ?? 0));
    } catch {
      this.logger.warn({ event: 'ehr.inpatient.bed_day_sweep_unavailable' });
      return 0;
    }
  }
}
