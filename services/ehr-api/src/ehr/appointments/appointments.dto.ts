import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';
import { MATCH_REF_PATTERN } from '../worklist/visit-queue.dto';

/** APPT-1 (0160): the visit types a booking can carry. */
export const APPOINTMENT_VISIT_TYPES = ['new_visit', 'follow_up', 'results_review', 'antenatal', 'procedure', 'other'] as const;
export type AppointmentVisitType = (typeof APPOINTMENT_VISIT_TYPES)[number];
/** APPT-1 (0160): an appointment's status. Cancelled is final. */
export const APPOINTMENT_STATUSES = ['booked', 'checked_in', 'cancelled', 'no_show'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
const queryFlag = ({ value }: TransformFnParams): unknown => value === 'true' ? true : value === 'false' ? false : value;
const queryInt = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : value;
/** A comma list of statuses ("booked,checked_in"); anything else stays as given and fails validation. */
const statusList = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.split(',').map((status) => status.trim()) : value;

/** No control characters (the database refuses them too). */
const NO_CONTROL = /^[^\p{Cc}]*$/u;
/** A Lagos calendar day. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A booking reason: 0-200 characters, a short reason and never a diagnosis. */
const REASON_MAX = 200;

/**
 * POST ehr/appointments. Exactly one of `matchRef` (this member's own
 * direct-care search in the last 10 minutes) or `patientId` (a patient who is
 * already this facility's own). Never a Health ID.
 */
export class BookAppointmentDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(47)
  @Matches(MATCH_REF_PATTERN, { message: 'matchRef must be the match reference a patient search gave' })
  matchRef?: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  patientId?: string;

  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,63}$/, { message: 'departmentCode must be one of the facility departments' })
  departmentCode!: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  clinicId?: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  clinicianMembershipId?: string;

  @IsISO8601({ strict: true })
  startsAt!: string;

  @IsOptionalButNotNull()
  @IsInt()
  @Min(5)
  @Max(240)
  lengthMinutes?: number;

  @IsIn(APPOINTMENT_VISIT_TYPES)
  visitType!: AppointmentVisitType;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(REASON_MAX)
  @Matches(NO_CONTROL, { message: 'reason must not contain control characters' })
  reason?: string | null;
}

/** GET ehr/appointments?day=YYYY-MM-DD[&clinicId][&clinicianMembershipId][&status=booked,checked_in][&limit][&cursor]. */
export class ListAppointmentsQueryDto {
  @Matches(DAY, { message: 'day must be a date (YYYY-MM-DD)' })
  day!: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  clinicId?: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  clinicianMembershipId?: string;

  @IsOptionalButNotNull()
  @Transform(statusList)
  @IsIn(APPOINTMENT_STATUSES, { each: true })
  status?: AppointmentStatus[];

  @IsOptionalButNotNull()
  @Transform(queryInt)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptionalButNotNull()
  @IsString()
  @MaxLength(400)
  cursor?: string;
}

/** POST ehr/appointments/:appointmentId/reschedule. `clinicianMembershipId: null` removes the clinician. */
export class RescheduleAppointmentDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsISO8601({ strict: true })
  startsAt!: string;

  @IsOptionalButNotNull()
  @IsInt()
  @Min(5)
  @Max(240)
  lengthMinutes?: number;

  @IsOptional()
  @IsUUID('all')
  clinicianMembershipId?: string | null;

  @Transform(trim)
  @IsString()
  @MinLength(8)
  @MaxLength(500)
  @Matches(NO_CONTROL, { message: 'reason must not contain control characters' })
  reason!: string;
}

/** POST ehr/appointments/:appointmentId/cancel. */
export class CancelAppointmentDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @Transform(trim)
  @IsString()
  @MinLength(8)
  @MaxLength(500)
  @Matches(NO_CONTROL, { message: 'reason must not contain control characters' })
  reason!: string;
}

/** POST ehr/appointments/:appointmentId/no-show. */
export class MarkNoShowDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;
}

/**
 * POST ehr/appointments/:appointmentId/check-in. `identityConfirmed` must be
 * true: the desk confirmed the patient's name and date of birth with them. An
 * optional `matchRef` from a fresh search must name the appointment's patient.
 */
export class CheckInAppointmentDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsBoolean()
  identityConfirmed!: boolean;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(47)
  @Matches(MATCH_REF_PATTERN, { message: 'matchRef must be the match reference a patient search gave' })
  matchRef?: string;
}

/** GET ehr/appointment-clinics?includeInactive=true. */
export class ListAppointmentClinicsQueryDto {
  @IsOptionalButNotNull()
  @Transform(queryFlag)
  @IsBoolean()
  includeInactive?: boolean;
}

/** POST ehr/appointment-clinics. */
export class CreateAppointmentClinicDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(NO_CONTROL, { message: 'name must not contain control characters' })
  name!: string;

  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,63}$/, { message: 'departmentCode must be one of the facility departments' })
  departmentCode!: string;

  @IsOptionalButNotNull()
  @IsInt()
  @Min(5)
  @Max(240)
  defaultLengthMinutes?: number;
}

/** PATCH ehr/appointment-clinics/:clinicId. `defaultLengthMinutes: null` falls back to the facility's default. */
export class UpdateAppointmentClinicDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(NO_CONTROL, { message: 'name must not contain control characters' })
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(240)
  defaultLengthMinutes?: number | null;

  @IsOptionalButNotNull()
  @IsBoolean()
  active?: boolean;
}

/** PATCH ehr/appointment-settings (the contract's PUT; ehr-api answers GET, POST and PATCH only). */
export class SaveAppointmentSettingsDto {
  @IsInt()
  @Min(0)
  expectedRowVersion!: number;

  @IsInt()
  @Min(5)
  @Max(240)
  defaultLengthMinutes!: number;
}

/** GET ehr/me/appointments?when=upcoming|past[&limit=1..50][&cursor]. */
export class MyAppointmentsQueryDto {
  @IsIn(['upcoming', 'past'])
  when!: 'upcoming' | 'past';

  @IsOptionalButNotNull()
  @Transform(queryInt)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptionalButNotNull()
  @IsString()
  @MaxLength(400)
  cursor?: string;
}
