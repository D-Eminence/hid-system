import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import { measureWarning, USUAL_RANGES_VERSION, WARNED_MEASURES, type WarnedMeasure } from '../vitals/usual-ranges';
import type {
  CancelTaskDto, CompleteTaskDto, CreateShiftDto, CreateTaskDto, FluidEntryDto, HandoverNoteDto,
  NewHandoverNoteDto, NursingEnteredInErrorDto, RecordDoseDto, SetAssignmentsDto, TaskListQueryDto, UpdateShiftDto,
  UpdateTaskDto,
} from './nursing.dto';

/**
 * NUR-1 (0174-0177): nursing on the ward, built at the owner's decisions of 25
 * November 2026 (Q147-Q290 at the recommended options: Q193-Q202, Q157, Q158,
 * Q161) and the section's smaller choices Q-NUR-6 A to Q-NUR-16 A.
 *
 * Every route works through 0174-0176's SECURITY DEFINER functions, which
 * check the caller (an active membership here, the route's access code, the
 * purpose and, for chart content, the patient's chart access), decide, and
 * audit in the request's transaction, refusals included. The functions answer
 * JSON; this service turns their refusals into plain words, adds VIT-1's soft
 * flags to the chart (worked out on each read, never stored) and never adds a
 * Health ID, NIN, name, medicine, dose or value to a log or audit row. No
 * early-warning or severity score is ever computed (Q199 A): the chart's
 * `score` is always null.
 *
 * Until the owner's go-live NURSING_ENABLED is off in production and every
 * route answers 503 NURSING_NOT_AVAILABLE; it needs ADT-1's INPATIENT_ENABLED
 * too, and a database without 0174-0176 answers the same. No Health ID or NIN
 * appears in any path, query, body or answer.
 */

/** The plain-words messages of the nursing refusals. Staff screens show these and never the word "permission". */
export const NURSING_MESSAGES = {
  notAvailable: 'The medicine round and nursing tasks are not switched on yet.',
  validation: 'Check the highlighted fields.',
  nursingNotAllowed: 'Only nurses, clinicians and doctors of this facility can use the medicine round and nursing tasks.',
  marRecordNotAllowed: 'Only nurses, clinicians and doctors can record doses.',
  shiftSetupNotAllowed: 'Only the facility\'s admins can set up clinical shifts.',
  shiftAssignNotAllowed: 'Only nurses in charge and admins can assign shifts.',
  chartAccessRequired: 'Open this patient\'s record first, then try again.',
  notFound: 'This record is not at this facility.',
  admissionNotOpen: 'This patient has been discharged. The record can still be read.',
  orderNotActive: 'This order is not active. Ask the prescriber.',
  doseAlreadyRecorded: 'This dose is already recorded. Mark it entered in error if it is wrong.',
  alreadyEnteredInError: 'This entry is already marked entered in error.',
  taskStateInvalid: 'This task has moved on. Reload it.',
  handoverNotYours: 'Only a nurse on the next shift for this ward can accept the handover.',
  handoverNotDraft: 'This handover has been given. Write any change in the next one.',
  handoverNotGiven: 'This handover has not been given yet.',
  handoverAccepted: 'This handover has already been accepted.',
  versionConflict: 'Someone else changed this. Reload it and try again.',
  keyReused: 'Idempotency-Key was already used with a different request',
  doseReasonRequired: 'Choose a reason for a dose that was not given.',
  doseDiffersReasonRequired: 'Say why the dose differs from the order.',
  supplySourceRequired: 'The pharmacy has not dispensed this medicine. Say where it came from.',
  overrideReasonRequired: 'This is sooner or more often than ordered. Say why.',
  doseTimeInvalid: 'The time can be up to 12 hours ago, and not in the future.',
  assigneeInvalid: 'Choose a nurse, clinician or doctor who works at this facility.',
  shiftTimesInvalid: 'Enter a start and end time. A shift can run past midnight.',
  fluidEntryInvalid: 'Enter the amount in mL, or mark it as not measured.',
  nameTaken: 'This name is already used. Choose another.',
  shiftLimit: 'This facility already has 8 active shifts. Stop one first.',
  purpose: 'X-Purpose-Of-Use must be direct-care (healthcare-operations for clinical shift setup)',
} as const;

export function nursingRoutesEnabled(): boolean {
  const environment = getEnvironment();
  return environment.NURSING_ENABLED && environment.INPATIENT_ENABLED;
}

export function notAvailable(): DomainProblem {
  return new DomainProblem(503, 'NURSING_NOT_AVAILABLE', NURSING_MESSAGES.notAvailable);
}

/** The access a route needs, checked on the session's codes at this facility before the database decides again. */
export type NursingAccess = 'chart' | 'mar_read' | 'mar_record' | 'task_read' | 'task_write' | 'fluid_read'
  | 'fluid_write' | 'handover' | 'assign' | 'assign_read' | 'shift_list' | 'shift_setup';

export function requireNursingAccess(request: HidRequest, access: NursingAccess): void {
  const held = new Set(request.actor?.permissions ?? []);
  const has = (code: string) => held.has(code);
  const refuse = (code = 'NURSING_NOT_ALLOWED', message: string = NURSING_MESSAGES.nursingNotAllowed) => {
    throw new DomainProblem(403, code, message);
  };
  switch (access) {
    case 'chart':
      if (!has('ehr.vital.read') || !has('ehr.admission.read')) refuse();
      return;
    case 'mar_read':
      if (!has('ehr.mar.read')) refuse();
      return;
    case 'mar_record':
      if (!has('ehr.mar.read') || !has('ehr.mar.record')) refuse('MAR_RECORD_NOT_ALLOWED', NURSING_MESSAGES.marRecordNotAllowed);
      return;
    case 'task_read':
      if (!has('ehr.nursing-task.read')) refuse();
      return;
    case 'task_write':
      if (!has('ehr.nursing-task.read') || !has('ehr.nursing-task.write')) refuse();
      return;
    case 'fluid_read':
      if (!has('ehr.vital.read')) refuse();
      return;
    case 'fluid_write':
      if (!has('ehr.vital.read') || !has('ehr.vital.write')) refuse();
      return;
    case 'handover':
      if (!has('ehr.nursing-task.read') || !has('ehr.handover.write')) refuse();
      return;
    case 'assign':
      if (!has('ehr.shift-assignment.manage')) refuse('SHIFT_ASSIGN_NOT_ALLOWED', NURSING_MESSAGES.shiftAssignNotAllowed);
      return;
    case 'assign_read':
      if (!has('ehr.nursing-task.read') && !has('ehr.shift-assignment.manage')) refuse();
      return;
    case 'shift_list':
      if (!has('ehr.nursing-task.read') && !has('ehr.shift-assignment.manage') && !has('ehr.clinical-shift.manage')) refuse();
      return;
    case 'shift_setup':
      if (!has('ehr.clinical-shift.manage')) refuse('SHIFT_SETUP_NOT_ALLOWED', NURSING_MESSAGES.shiftSetupNotAllowed);
      return;
    default:
      refuse();
  }
}

/** Which record a route is about, for its 404 code. */
export type NursingResource = 'admission' | 'administration' | 'task' | 'fluid' | 'handover' | 'shift' | 'ward';

const NOT_FOUND_CODES: Record<NursingResource, string> = {
  admission: 'ADMISSION_NOT_FOUND', administration: 'ADMINISTRATION_NOT_FOUND', task: 'TASK_NOT_FOUND',
  fluid: 'FLUID_ENTRY_NOT_FOUND', handover: 'HANDOVER_NOT_FOUND', shift: 'SHIFT_NOT_FOUND', ward: 'WARD_NOT_FOUND',
};

type Answer = Record<string, unknown> & { outcome?: string; replayed?: boolean };

function validation(field: string, message: string): DomainProblem {
  return new DomainProblem(400, 'VALIDATION_FAILED', NURSING_MESSAGES.validation, [{ field, messages: [message] }]);
}

/** A refusal the function answered, in plain words. */
export function refusal(outcome: string | undefined, resource: NursingResource, answer?: Answer,
  assigneeCode = 'TASK_ASSIGNEE_INVALID'): DomainProblem {
  switch (outcome) {
    case 'ward_not_found':
      return new DomainProblem(404, 'WARD_NOT_FOUND', NURSING_MESSAGES.notFound);
    case 'shift_not_found':
      return new DomainProblem(404, 'SHIFT_NOT_FOUND', NURSING_MESSAGES.notFound);
    case 'admission_not_found':
      return new DomainProblem(404, 'ADMISSION_NOT_FOUND', NURSING_MESSAGES.notFound);
    case 'chart_access_required':
      return new DomainProblem(403, 'CHART_ACCESS_REQUIRED', NURSING_MESSAGES.chartAccessRequired);
    case 'admission_not_open':
      return new DomainProblem(409, 'ADMISSION_NOT_OPEN', NURSING_MESSAGES.admissionNotOpen);
    case 'order_not_active':
      return new DomainProblem(409, 'MAR_ORDER_NOT_ACTIVE', NURSING_MESSAGES.orderNotActive);
    case 'already_recorded':
      return new DomainProblem(409, 'DOSE_ALREADY_RECORDED', NURSING_MESSAGES.doseAlreadyRecorded, undefined,
        typeof answer?.administrationId === 'string' ? { administrationId: answer.administrationId } : undefined);
    case 'already_entered_in_error':
      return new DomainProblem(409, 'ALREADY_ENTERED_IN_ERROR', NURSING_MESSAGES.alreadyEnteredInError);
    case 'state_invalid':
      return new DomainProblem(409, 'TASK_STATE_INVALID', NURSING_MESSAGES.taskStateInvalid);
    case 'not_yours':
      return new DomainProblem(409, 'HANDOVER_NOT_YOURS', NURSING_MESSAGES.handoverNotYours);
    case 'not_draft':
      return new DomainProblem(409, 'HANDOVER_NOT_DRAFT', NURSING_MESSAGES.handoverNotDraft);
    case 'not_given':
      return new DomainProblem(409, 'HANDOVER_NOT_GIVEN', NURSING_MESSAGES.handoverNotGiven);
    case 'already_accepted':
      return new DomainProblem(409, 'HANDOVER_ALREADY_ACCEPTED', NURSING_MESSAGES.handoverAccepted);
    case 'changed':
      return new DomainProblem(412, 'NURSING_VERSION_CONFLICT', NURSING_MESSAGES.versionConflict);
    case 'key_reused':
      return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', NURSING_MESSAGES.keyReused);
    case 'scheduled_for_invalid':
      return validation('scheduledFor', 'choose a due time of this order (none for "as needed" or an order with no schedule)');
    case 'infusion_invalid':
      return validation('infusionAction', 'only for an order with an infusion rate');
    case 'dose_differs_reason_required':
      return new DomainProblem(400, 'DOSE_DIFFERS_REASON_REQUIRED', NURSING_MESSAGES.doseDiffersReasonRequired);
    case 'supply_source_required':
      return new DomainProblem(400, 'SUPPLY_SOURCE_REQUIRED', NURSING_MESSAGES.supplySourceRequired);
    case 'override_reason_required':
      return new DomainProblem(400, 'AS_NEEDED_OVERRIDE_REASON_REQUIRED', NURSING_MESSAGES.overrideReasonRequired);
    case 'assignee_invalid':
      return new DomainProblem(400, assigneeCode, NURSING_MESSAGES.assigneeInvalid);
    case 'admission_invalid':
      return validation('assignments', 'each patient must be an open admission on this ward, with one nurse per shift');
    case 'name_taken':
      return new DomainProblem(409, 'SHIFT_NAME_TAKEN', NURSING_MESSAGES.nameTaken);
    case 'limit_reached':
      return new DomainProblem(409, 'SHIFT_LIMIT_REACHED', NURSING_MESSAGES.shiftLimit);
    default:
      return new DomainProblem(404, NOT_FOUND_CODES[resource], NURSING_MESSAGES.notFound);
  }
}

const RAISED_400: Readonly<Record<string, [string, string]>> = {
  NURSING_INVALID: ['VALIDATION_FAILED', NURSING_MESSAGES.validation],
  DOSE_REASON_REQUIRED: ['DOSE_REASON_REQUIRED', NURSING_MESSAGES.doseReasonRequired],
  DOSE_TIME_INVALID: ['DOSE_TIME_INVALID', NURSING_MESSAGES.doseTimeInvalid],
  FLUID_ENTRY_INVALID: ['FLUID_ENTRY_INVALID', NURSING_MESSAGES.fluidEntryInvalid],
  FLUID_TIME_INVALID: ['VALIDATION_FAILED', NURSING_MESSAGES.validation],
  SHIFT_TIMES_INVALID: ['SHIFT_TIMES_INVALID', NURSING_MESSAGES.shiftTimesInvalid],
  NURSING_PURPOSE_REQUIRED: ['PURPOSE_OF_USE_REQUIRED', NURSING_MESSAGES.purpose],
  NURSING_IDEMPOTENCY_KEY_INVALID: ['IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key must contain 16 to 128 URL-safe characters'],
};

const RAISED_403: Readonly<Record<string, string>> = {
  NURSING_NOT_ALLOWED: NURSING_MESSAGES.nursingNotAllowed,
  MAR_RECORD_NOT_ALLOWED: NURSING_MESSAGES.marRecordNotAllowed,
  SHIFT_SETUP_NOT_ALLOWED: NURSING_MESSAGES.shiftSetupNotAllowed,
  SHIFT_ASSIGN_NOT_ALLOWED: NURSING_MESSAGES.shiftAssignNotAllowed,
};

/** The functions' own refusals, in plain words; anything else is passed on. */
export function translate(error: unknown): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? String((error as { message?: unknown }).message) : '';
  if (code === '42501') {
    return new DomainProblem(403, RAISED_403[message] ? message : 'NURSING_NOT_ALLOWED',
      RAISED_403[message] ?? NURSING_MESSAGES.nursingNotAllowed);
  }
  if (code === '22023') {
    const known = RAISED_400[message];
    if (known) return new DomainProblem(400, known[0], known[1]);
    return new DomainProblem(400, 'VALIDATION_FAILED', NURSING_MESSAGES.validation);
  }
  if (code === '40P01' || code === '23505') {
    return new DomainProblem(412, 'NURSING_VERSION_CONFLICT', NURSING_MESSAGES.versionConflict);
  }
  if (code === '42883' || code === '42P01') {
    // A new image on a schema without 0174-0176: the routes stay closed until the migrations are applied.
    return notAvailable();
  }
  return error;
}

/** VIT-1's soft flags of one reading's values (each value its own flag; never a total or a score, Q199 A). */
export function readingFlags(values: Record<string, unknown>): { measure: WarnedMeasure; level: string }[] {
  const flags: { measure: WarnedMeasure; level: string }[] = [];
  for (const measure of WARNED_MEASURES) {
    const raw = values[measure];
    const warning = measureWarning(measure, raw === null || raw === undefined ? null : Number(raw));
    if (warning) flags.push({ measure, level: warning.level });
  }
  return flags;
}

const STORED_MEASURES: Readonly<Record<string, WarnedMeasure>> = {
  pulse_bpm: 'pulseBpm', respiratory_rate: 'respiratoryRate', oxygen_saturation_percent: 'oxygenSaturationPercent',
  systolic_mmhg: 'systolicMmhg', diastolic_mmhg: 'diastolicMmhg', temperature_c: 'temperatureC',
};

/** A stored reading (snake_case columns) as the measures VIT-1 flags. */
function storedValues(reading: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(STORED_MEASURES).map(([column, measure]) => [measure, reading[column]]));
}

const HOUR = 60 * 60_000;

@Injectable()
export class NursingService {
  constructor(private readonly database: DatabaseService) {}

  // Observation chart (route 2).

  async observationChart(context: DataAccessContext, admissionId: string, from: string | undefined,
    to: string | undefined, view: 'all' | 'hourly' | undefined): Promise<unknown> {
    const toValue = to ? new Date(to) : new Date();
    const fromValue = from ? new Date(from) : new Date(toValue.getTime() - 24 * HOUR);
    if (!(fromValue < toValue) || toValue.getTime() - fromValue.getTime() > 7 * 24 * HOUR) {
      throw validation('from', 'the window is up to 7 days, from before to');
    }
    // The ICU grid is the default view for an ICU ward; the function decides the ward, so the hours are asked for
    // unless the view is "all", and left out for another ward when no view was asked for.
    const answer = await this.one(context, 'select ehr.observation_chart($1, $2, $3, $4) as answer',
      [admissionId, fromValue.toISOString(), toValue.toISOString(), view !== 'all']);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, 'admission', answer);
    const hourly = view === 'hourly' || (view === undefined && answer.wardType === 'icu');
    const readings = (Array.isArray(answer.readings) ? answer.readings : []) as Record<string, unknown>[];
    return {
      admissionId: answer.admissionId, encounterId: answer.encounterId, wardType: answer.wardType ?? null,
      from: answer.from, to: answer.to,
      readings: readings.map((reading) => ({
        ...reading,
        flags: reading.status === 'recorded' ? readingFlags((reading.values ?? {}) as Record<string, unknown>) : [],
      })),
      ...(hourly ? { hours: answer.hours ?? [] } : {}),
      rangesVersion: USUAL_RANGES_VERSION,
      // Q199 A: no early-warning or severity score is computed; null, so a screen cannot read a missing score as low.
      score: null,
    };
  }

  // The medicine round (routes 4-7).

  async medicineRound(context: DataAccessContext, admissionId: string, from: string | undefined,
    to: string | undefined): Promise<unknown> {
    const now = Date.now();
    const fromValue = from ? new Date(from) : new Date(now - 24 * HOUR);
    const toValue = to ? new Date(to) : new Date(now + 24 * HOUR);
    if (!(fromValue < toValue) || toValue.getTime() - fromValue.getTime() > 7 * 24 * HOUR) {
      throw validation('from', 'the window is up to 7 days, from before to');
    }
    const answer = await this.one(context, 'select ehr.mar_read($1, $2, $3) as answer',
      [admissionId, fromValue.toISOString(), toValue.toISOString()]);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, 'admission', answer);
    return { admissionId: answer.admissionId, from: answer.from, to: answer.to, orders: answer.orders,
      administrations: answer.administrations };
  }

  async wardRound(context: DataAccessContext, wardId: string, window: 'now' | 'next_4h'): Promise<unknown> {
    const answer = await this.one(context, 'select ehr.mar_ward_round($1, $2) as answer', [wardId, window]);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, 'ward', answer);
    const { outcome: _outcome, ...rest } = answer;
    return rest;
  }

  async recordDose(context: DataAccessContext, admissionId: string, input: RecordDoseDto, key: string): Promise<unknown> {
    if (input.outcome === 'given' && (!input.dose || !input.route)) {
      throw validation('dose', 'a dose and route are needed for a dose given');
    }
    if (input.outcome !== 'given' && !input.reasonCode) {
      throw new DomainProblem(400, 'DOSE_REASON_REQUIRED', NURSING_MESSAGES.doseReasonRequired);
    }
    const digest = requestDigest('nursing.mar.record', { admissionId, ...input });
    const answer = await this.one(context,
      `select ehr.mar_record($1, $2, $3::timestamptz, $4, $5::timestamptz, $6::numeric, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16) as answer`,
      [admissionId, input.prescriptionId, input.scheduledFor ?? null, input.outcome, input.givenAt,
        input.dose?.quantity ?? null, input.dose?.unit ?? null, input.route ?? null, input.doseDiffersReason ?? null,
        input.reasonCode ?? null, input.reasonText ?? null, input.supplySource ?? null, input.overrideReason ?? null,
        input.infusionAction ?? null, key, digest]);
    if (answer.outcome !== 'created') throw refusal(answer.outcome, 'admission', answer);
    return { administration: answer.administration, warnings: answer.warnings ?? [], replayed: answer.replayed === true };
  }

  async doseEnteredInError(context: DataAccessContext, administrationId: string, input: NursingEnteredInErrorDto,
    key: string): Promise<unknown> {
    const digest = requestDigest('nursing.mar.entered-in-error', { administrationId, ...input });
    const answer = await this.one(context, 'select ehr.mar_entered_in_error($1, $2, $3, $4, $5) as answer',
      [administrationId, input.expectedRowVersion, input.reason, key, digest]);
    if (answer.outcome !== 'updated') throw refusal(answer.outcome, 'administration', answer);
    return { administration: answer.administration, replayed: answer.replayed === true };
  }

  // Nursing tasks (routes 8-10).

  async tasks(context: DataAccessContext, query: TaskListQueryDto): Promise<unknown> {
    if ((query.wardId === undefined) === (query.admissionId === undefined)) {
      throw validation('wardId', 'give a ward or an admission');
    }
    const answer = await this.one(context, 'select ehr.nursing_task_list($1, $2, $3, $4) as answer',
      [query.wardId ?? null, query.admissionId ?? null, query.status ?? 'open', query.mine === true]);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, query.wardId ? 'ward' : 'admission', answer);
    return { items: answer.items };
  }

  async createTask(context: DataAccessContext, admissionId: string, input: CreateTaskDto, key: string): Promise<unknown> {
    const digest = requestDigest('nursing.task.create', { admissionId, ...input });
    return this.taskWrite(context, 'select ehr.nursing_task_create($1, $2, $3, $4, $5, $6, $7) as answer',
      [admissionId, input.name, input.dueAt, input.assignedMembershipId ?? null, input.repeatEveryHours ?? null, key, digest],
      'created', 'admission');
  }

  async startTask(context: DataAccessContext, taskId: string, expectedRowVersion: number, key: string): Promise<unknown> {
    const digest = requestDigest('nursing.task.start', { taskId, expectedRowVersion });
    return this.taskWrite(context, 'select ehr.nursing_task_start($1, $2, $3, $4) as answer',
      [taskId, expectedRowVersion, key, digest], 'updated', 'task');
  }

  async completeTask(context: DataAccessContext, taskId: string, input: CompleteTaskDto, key: string): Promise<unknown> {
    const digest = requestDigest('nursing.task.complete', { taskId, ...input });
    return this.taskWrite(context, 'select ehr.nursing_task_complete($1, $2, $3, $4, $5) as answer',
      [taskId, input.expectedRowVersion, input.completionRecord ?? null, key, digest], 'updated', 'task');
  }

  async cancelTask(context: DataAccessContext, taskId: string, input: CancelTaskDto, key: string): Promise<unknown> {
    const digest = requestDigest('nursing.task.cancel', { taskId, ...input });
    return this.taskWrite(context, 'select ehr.nursing_task_cancel($1, $2, $3, $4, $5) as answer',
      [taskId, input.expectedRowVersion, input.reason, key, digest], 'updated', 'task');
  }

  async updateTask(context: DataAccessContext, taskId: string, input: UpdateTaskDto, key: string): Promise<unknown> {
    if (input.assignedMembershipId === undefined && input.dueAt === undefined) {
      throw validation('assignedMembershipId', 'choose what to change');
    }
    const digest = requestDigest('nursing.task.update', { taskId, ...input });
    return this.taskWrite(context, 'select ehr.nursing_task_update($1, $2, $3, $4, $5, $6) as answer',
      [taskId, input.expectedRowVersion, input.assignedMembershipId ?? null, input.dueAt ?? null, key, digest],
      'updated', 'task');
  }

  // Fluid balance (routes 11-13).

  async fluidDay(context: DataAccessContext, admissionId: string, day: string | undefined): Promise<unknown> {
    const answer = await this.one(context, 'select ehr.fluid_balance_read($1, $2::date) as answer', [admissionId, day ?? null]);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, 'admission', answer);
    const { outcome: _outcome, ...rest } = answer;
    return rest;
  }

  async recordFluid(context: DataAccessContext, admissionId: string, input: FluidEntryDto, key: string): Promise<unknown> {
    if ((input.volumeMl === undefined) === (input.notMeasured !== true)) {
      throw new DomainProblem(400, 'FLUID_ENTRY_INVALID', NURSING_MESSAGES.fluidEntryInvalid);
    }
    const digest = requestDigest('nursing.fluid.record', { admissionId, ...input });
    const answer = await this.one(context,
      'select ehr.fluid_balance_record($1, $2, $3, $4, $5, $6, $7, $8, $9) as answer',
      [admissionId, input.direction, input.kind, input.volumeMl ?? null, input.notMeasured === true, input.recordedAt,
        input.note ?? null, key, digest]);
    if (answer.outcome !== 'created') throw refusal(answer.outcome, 'admission', answer);
    return { entryId: answer.entryId, replayed: answer.replayed === true };
  }

  async fluidEnteredInError(context: DataAccessContext, entryId: string, input: NursingEnteredInErrorDto,
    key: string): Promise<unknown> {
    const digest = requestDigest('nursing.fluid.entered-in-error', { entryId, ...input });
    const answer = await this.one(context, 'select ehr.fluid_balance_entered_in_error($1, $2, $3, $4, $5) as answer',
      [entryId, input.expectedRowVersion, input.reason, key, digest]);
    if (answer.outcome !== 'updated') throw refusal(answer.outcome, 'fluid', answer);
    return { entryId: answer.entryId, replayed: answer.replayed === true };
  }

  // Clinical shifts and assignments (routes 14-15).

  async shifts(context: DataAccessContext): Promise<unknown> {
    const answer = await this.one(context, 'select ehr.clinical_shift_list() as answer', []);
    return { items: answer.items ?? [], fluidDayStartsAtHour: answer.fluidDayStartsAtHour };
  }

  async createShift(context: DataAccessContext, input: CreateShiftDto, key: string): Promise<unknown> {
    if (input.startsAt === input.endsAt) {
      throw new DomainProblem(400, 'SHIFT_TIMES_INVALID', NURSING_MESSAGES.shiftTimesInvalid);
    }
    const digest = requestDigest('nursing.shift.create', { ...input });
    const answer = await this.one(context, 'select ehr.clinical_shift_create($1, $2, $3, $4, $5) as answer',
      [input.name, input.startsAt, input.endsAt, key, digest]);
    if (answer.outcome !== 'created') throw refusal(answer.outcome, 'shift', answer);
    return { shiftId: answer.shiftId, replayed: answer.replayed === true };
  }

  async updateShift(context: DataAccessContext, shiftId: string, input: UpdateShiftDto, key: string): Promise<unknown> {
    if (input.name === undefined && input.active === undefined) throw validation('name', 'choose what to change');
    const digest = requestDigest('nursing.shift.update', { shiftId, ...input });
    const answer = await this.one(context, 'select ehr.clinical_shift_update($1, $2, $3, $4, $5, $6) as answer',
      [shiftId, input.expectedRowVersion, input.name ?? null, input.active ?? null, key, digest]);
    if (answer.outcome !== 'updated') throw refusal(answer.outcome, 'shift', answer);
    return { shiftId: answer.shiftId, replayed: answer.replayed === true };
  }

  async assignments(context: DataAccessContext, date: string, shiftId: string, wardId: string): Promise<unknown> {
    const answer = await this.one(context, 'select ehr.shift_assignments_read($1::date, $2, $3) as answer',
      [date, shiftId, wardId]);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, 'shift', answer);
    const { outcome: _outcome, ...rest } = answer;
    return rest;
  }

  async setAssignments(context: DataAccessContext, input: SetAssignmentsDto, key: string): Promise<unknown> {
    const assignments = input.assignments.map((row) => ({ membershipId: row.membershipId, duty: row.duty,
      admissionIds: [...new Set(row.admissionIds ?? [])] }));
    const digest = requestDigest('nursing.assignments.set', { ...input, assignments });
    const answer = await this.one(context,
      'select ehr.shift_assignments_set($1::date, $2, $3, $4, $5::jsonb, $6, $7) as answer',
      [input.date, input.shiftId, input.wardId, input.expectedVersion, JSON.stringify(assignments), key, digest]);
    if (answer.outcome !== 'updated') throw refusal(answer.outcome, 'shift', answer, 'SHIFT_ASSIGNEE_INVALID');
    const list = (answer.list ?? {}) as Answer;
    const { outcome: _outcome, ...rest } = list;
    return { list: rest, warnings: answer.warnings ?? [], replayed: answer.replayed === true };
  }

  // Shift handover (routes 16-18).

  async handover(context: DataAccessContext, wardId: string, date: string, shiftId: string): Promise<unknown> {
    const answer = await this.one(context, 'select ehr.handover_read($1, $2::date, $3) as answer', [wardId, date, shiftId]);
    if (answer.outcome !== 'found') throw refusal(answer.outcome, 'handover', answer);
    const { outcome: _outcome, patients, ...rest } = answer;
    return {
      ...rest,
      patients: ((Array.isArray(patients) ? patients : []) as Record<string, unknown>[]).map((patient) => {
        const { shiftReadings, ...shown } = patient;
        // The readings of this shift come only for a chart the member can read; ehr-api counts those with a soft
        // flag (VIT-1) and never passes the values on.
        const flagsSinceLastShift = Array.isArray(shiftReadings)
          ? (shiftReadings as Record<string, unknown>[]).filter((reading) => readingFlags(storedValues(reading)).length > 0).length
          : null;
        return { ...shown, flagsSinceLastShift };
      }),
    };
  }

  async handoverNote(context: DataAccessContext, handoverId: string | null, admissionId: string,
    input: HandoverNoteDto | NewHandoverNoteDto, key: string): Promise<unknown> {
    const fresh = input as NewHandoverNoteDto;
    const digest = requestDigest('nursing.handover.note', { handoverId, admissionId, ...input });
    const answer = await this.one(context,
      'select ehr.handover_note_put($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10) as answer',
      [handoverId, admissionId, handoverId ? null : fresh.wardId, handoverId ? null : fresh.date,
        handoverId ? null : fresh.shiftId, input.expectedRowVersion ?? null, input.note, input.watch === true, key, digest]);
    if (answer.outcome !== 'updated') throw refusal(answer.outcome, 'handover', answer);
    return { handoverId: answer.handoverId, item: answer.item, replayed: answer.replayed === true };
  }

  async handoverStep(context: DataAccessContext, handoverId: string, step: 'give' | 'accept', expectedRowVersion: number,
    key: string): Promise<unknown> {
    const digest = requestDigest(`nursing.handover.${step}`, { handoverId, expectedRowVersion });
    const answer = await this.one(context, `select ehr.handover_${step}($1, $2, $3, $4) as answer`,
      [handoverId, expectedRowVersion, key, digest]);
    if (answer.outcome !== 'updated') throw refusal(answer.outcome, 'handover', answer);
    return { handover: answer.handover, replayed: answer.replayed === true };
  }

  private async taskWrite(context: DataAccessContext, sql: string, values: readonly unknown[], accepted: string,
    resource: NursingResource): Promise<unknown> {
    const answer = await this.one(context, sql, values);
    if (answer.outcome !== accepted) throw refusal(answer.outcome, resource, answer);
    return { task: answer.task, ...(answer.nextTaskId ? { nextTaskId: answer.nextTaskId } : {}),
      replayed: answer.replayed === true };
  }

  private async one(context: DataAccessContext, sql: string, values: readonly unknown[]): Promise<Answer> {
    try {
      return await this.database.withTransaction(context, async (client: PoolClient) =>
        ((await client.query<{ answer: Answer }>(sql, [...values])).rows[0]?.answer ?? {}));
    } catch (error) {
      throw translate(error);
    }
  }
}
