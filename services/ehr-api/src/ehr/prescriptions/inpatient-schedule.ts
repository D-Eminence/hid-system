import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Length,
  Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { DomainProblem } from '../../common/problem';
import { getEnvironment } from '../../config/environment';
import { IsOptionalButNotNull } from '../../common/validation';
import { CreatePrescriptionDto, CreatePrescriptionWithDetailsDto } from '../shared/clinical.dto';

/**
 * NUR-1 (0175, owner decision Q197 A): an inpatient medicine order's
 * schedule: set times (Lagos), "as needed" with its reason, minimum gap and
 * most doses in 24 hours, STAT, once only, and an infusion rate. Set at
 * creation only (0175's guard refuses any change), and only on an open
 * admission's inpatient visit (400 INPATIENT_SCHEDULE_NOT_ALLOWED). Accepted
 * only while NURSING_ENABLED is on; off, a body carrying it is refused with 400
 * NURSING_FIELDS_NOT_AVAILABLE and the prescriptions routes are exactly as
 * before. The pharmacy sees these as ordinary prescriptions.
 */
export class InpatientAsNeededDto {
  @IsString()
  @Length(1, 200)
  reason!: string;

  @IsInt()
  @Min(15)
  @Max(1440)
  minIntervalMinutes!: number;

  @IsInt()
  @Min(1)
  @Max(24)
  maxDosesPer24h!: number;
}

export class InpatientInfusionDto {
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.1)
  @Max(2000)
  rateMlPerHour!: number;

  @IsInt()
  @Min(1)
  @Max(5000)
  volumeMl!: number;

  @IsOptionalButNotNull()
  @IsString()
  @MaxLength(120)
  fluid?: string;
}

export const SCHEDULE_KINDS = ['regular', 'as_needed', 'stat', 'once'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export class InpatientScheduleDto {
  @IsIn(SCHEDULE_KINDS)
  kind!: ScheduleKind;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, { each: true })
  times?: string[] | null;

  @IsOptional()
  @IsDateString({ strict: true })
  firstDueAt?: string | null;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => InpatientAsNeededDto)
  asNeeded?: InpatientAsNeededDto | null;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => InpatientInfusionDto)
  infusion?: InpatientInfusionDto | null;
}

/** Today's create body plus the schedule (NUR-1), while NURSING_ENABLED is on. */
export class CreatePrescriptionWithScheduleDto extends CreatePrescriptionDto {
  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => InpatientScheduleDto)
  inpatientSchedule?: InpatientScheduleDto;
}

/** The 0125 details body plus the schedule (NUR-1), while both settings are on. */
export class CreatePrescriptionWithDetailsAndScheduleDto extends CreatePrescriptionWithDetailsDto {
  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => InpatientScheduleDto)
  inpatientSchedule?: InpatientScheduleDto;
}

export const SCHEDULE_MESSAGES = {
  notAvailable: 'These fields are not switched on yet.',
  notAllowed: 'Set times, as needed, STAT and infusions are for admitted patients only.',
  invalid: 'Check the schedule: times, gap and most doses in 24 hours.',
} as const;

/** The schedule as a prescription answer carries it (null keys left out of nothing: the whole object or null). */
export interface InpatientScheduleAnswer {
  kind: ScheduleKind;
  times: string[] | null;
  firstDueAt: string | null;
  asNeeded: { reason: string; minIntervalMinutes: number; maxDosesPer24h: number } | null;
  infusion: { rateMlPerHour: number; volumeMl: number; fluid: string | null } | null;
}

interface ScheduleColumns {
  scheduleKind?: string | null;
  scheduledTimes?: string[] | null;
  firstDueAt?: string | Date | null;
  asNeededReason?: string | null;
  asNeededMinIntervalMinutes?: number | null;
  asNeededMaxDosesPer24h?: number | null;
  infusionRateMlPerHour?: string | null;
  infusionVolumeMl?: number | null;
  infusionFluid?: string | null;
}

export function nursingEnabled(): boolean {
  const environment = getEnvironment();
  return environment.NURSING_ENABLED && environment.INPATIENT_ENABLED;
}

/**
 * The schedule on the prescriptions routes: off (the default and the tests'),
 * every statement and answer is today's; on, the create may carry
 * `inpatientSchedule`, the INSERT stores it and every answer carries it.
 */
export class PrescriptionInpatientSchedule {
  constructor(readonly enabled: boolean) {}

  /** Appended to the SELECT and RETURNING lists (through the whole row, so a schema without 0175 answers nulls). */
  selectList(): string {
    if (!this.enabled) return '';
    const row = 'to_jsonb(prescriptions)';
    return `, ${row}->>'schedule_kind' as "scheduleKind",
  case when jsonb_typeof(${row}->'scheduled_times') = 'array' then array(select jsonb_array_elements_text(${row}->'scheduled_times')) end as "scheduledTimes",
  ${row}->>'first_due_at' as "firstDueAt", ${row}->>'as_needed_reason' as "asNeededReason",
  (${row}->>'as_needed_min_interval_minutes')::integer as "asNeededMinIntervalMinutes",
  (${row}->>'as_needed_max_doses_per_24h')::integer as "asNeededMaxDosesPer24h",
  ${row}->>'infusion_rate_ml_per_hour' as "infusionRateMlPerHour",
  (${row}->>'infusion_volume_ml')::integer as "infusionVolumeMl", ${row}->>'infusion_fluid' as "infusionFluid"`;
  }

  /** A row as the EHR answers it: the schedule as one object (or null) while on; off, the row itself. */
  project<Row extends object>(row: Row): Row & { inpatientSchedule?: InpatientScheduleAnswer | null } {
    if (!this.enabled) return row;
    const { scheduleKind, scheduledTimes, firstDueAt, asNeededReason, asNeededMinIntervalMinutes, asNeededMaxDosesPer24h,
      infusionRateMlPerHour, infusionVolumeMl, infusionFluid, ...rest } = row as Row & ScheduleColumns;
    if (!scheduleKind) return { ...rest, inpatientSchedule: null } as Row & { inpatientSchedule: null };
    return {
      ...rest,
      inpatientSchedule: {
        kind: scheduleKind as ScheduleKind,
        times: scheduledTimes ?? null,
        firstDueAt: firstDueAt ? new Date(firstDueAt).toISOString() : null,
        asNeeded: asNeededReason ? { reason: asNeededReason, minIntervalMinutes: Number(asNeededMinIntervalMinutes),
          maxDosesPer24h: Number(asNeededMaxDosesPer24h) } : null,
        infusion: infusionRateMlPerHour ? { rateMlPerHour: Number(infusionRateMlPerHour),
          volumeMl: Number(infusionVolumeMl), fluid: infusionFluid ?? null } : null,
      },
    } as Row & { inpatientSchedule: InpatientScheduleAnswer };
  }

  /** The shape of each kind (400 INPATIENT_SCHEDULE_INVALID); the visit's check is 0175's guard. */
  check(input: { inpatientSchedule?: InpatientScheduleDto; routeCode?: string }): void {
    const schedule = input.inpatientSchedule;
    if (!schedule) return;
    if (!this.enabled) {
      throw new DomainProblem(400, 'NURSING_FIELDS_NOT_AVAILABLE', SCHEDULE_MESSAGES.notAvailable);
    }
    const times = schedule.times ?? null;
    const sorted = times ? [...new Set(times)].sort() : null;
    const invalid = (schedule.kind === 'regular') !== (times !== null)
      || (times !== null && JSON.stringify(sorted) !== JSON.stringify(times))
      || (schedule.kind === 'as_needed') !== Boolean(schedule.asNeeded)
      || (schedule.infusion && !['regular', 'stat', 'once'].includes(schedule.kind))
      || (schedule.kind === 'once' && !schedule.firstDueAt);
    if (invalid) throw new DomainProblem(400, 'INPATIENT_SCHEDULE_INVALID', SCHEDULE_MESSAGES.invalid);
  }

  /** The body for the Idempotency-Key digest: without an absent schedule, so today's bodies hash as before. */
  digestInput<Input extends object>(input: Input): object {
    if ((input as { inpatientSchedule?: unknown }).inpatientSchedule !== undefined) return input;
    return Object.fromEntries(Object.entries(input).filter(([field]) => field !== 'inpatientSchedule'));
  }

  insertColumns(input: { inpatientSchedule?: InpatientScheduleDto }): string {
    return this.enabled && input.inpatientSchedule ? `,
               schedule_kind, scheduled_times, first_due_at, as_needed_reason, as_needed_min_interval_minutes,
               as_needed_max_doses_per_24h, infusion_rate_ml_per_hour, infusion_volume_ml, infusion_fluid` : '';
  }

  insertPlaceholders(input: { inpatientSchedule?: InpatientScheduleDto }, from: number): string {
    if (!this.enabled || !input.inpatientSchedule) return '';
    return Array.from({ length: 9 }, (_, index) => `,$${from + index}`).join('');
  }

  insertValues(input: { inpatientSchedule?: InpatientScheduleDto }): unknown[] {
    const schedule = input.inpatientSchedule;
    if (!this.enabled || !schedule) return [];
    return [schedule.kind, schedule.times ?? null, schedule.firstDueAt ?? null, schedule.asNeeded?.reason?.trim() ?? null,
      schedule.asNeeded?.minIntervalMinutes ?? null, schedule.asNeeded?.maxDosesPer24h ?? null,
      schedule.infusion?.rateMlPerHour ?? null, schedule.infusion?.volumeMl ?? null, schedule.infusion?.fluid ?? null];
  }
}

/** Off: exactly today (the tests' and every direct caller's default). */
export const PRESCRIPTION_INPATIENT_SCHEDULE_OFF = new PrescriptionInpatientSchedule(false);

/** 0175's guard refusals, in plain words; anything else is passed on. */
export function scheduleProblem(error: unknown): unknown {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : '';
  if (code === '22023' && message === 'INPATIENT_SCHEDULE_NOT_ALLOWED') {
    return new DomainProblem(400, 'INPATIENT_SCHEDULE_NOT_ALLOWED', SCHEDULE_MESSAGES.notAllowed);
  }
  if ((code === '22023' && message === 'INPATIENT_SCHEDULE_INVALID')
    || (code === '23514' && message.includes('prescriptions_inpatient_schedule_ck'))) {
    return new DomainProblem(400, 'INPATIENT_SCHEDULE_INVALID', SCHEDULE_MESSAGES.invalid);
  }
  return error;
}
