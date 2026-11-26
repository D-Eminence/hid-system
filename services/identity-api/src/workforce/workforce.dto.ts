import { Type } from 'class-transformer';
import {
  ArrayMaxSize, Equals, IsArray, IsIn, IsInt, IsOptional, IsUUID, Matches, Max, Min, registerDecorator, ValidateIf,
  ValidateNested, type ValidationOptions,
} from 'class-validator';

/**
 * ROS-1 (0199-0202) request bodies and queries. The global ValidationPipe
 * whitelists and refuses any other field (400 VALIDATION_FAILED, "Check the
 * highlighted fields."). No Health ID or NIN is accepted anywhere: members by
 * membership UUID, records by UUID.
 */

export const LICENSED_ROLES = ['doctor', 'nurse', 'lab', 'pharmacist'] as const;
export const RENEWAL_PERIODS = ['licence_year', 'expiry_date'] as const;
export const CHECKED_HOW = ['regulator_register', 'certificate_seen', 'in_person'] as const;
export const WITHDRAW_REASONS = ['wrong_member', 'wrong_dates', 'wrong_licence', 'other'] as const;
export const LEAVE_TYPES = ['annual', 'sick', 'maternity', 'study', 'other'] as const;
export const ATTENDANCE_MARKS = ['present', 'absent', 'swapped'] as const;
export const LEAVE_LIST_STATUSES = ['requested', 'decided'] as const;

/** A department code of 0114 (the database checks it is one of this facility's profile departments). */
const DEPARTMENT_CODE = /^[a-z_]{2,40}$/;

/** A Lagos calendar date, YYYY-MM-DD, that exists. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function IsCalendarDate(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => registerDecorator({
    name: 'isCalendarDate', target: target.constructor, propertyName: propertyName as string,
    options: { message: `${String(propertyName)} must be a date (YYYY-MM-DD)`, ...options },
    validator: { validate: (value: unknown) => isCalendarDate(value) },
  });
}

/** Route 4: record a renewal. */
export class RecordLicenceRenewalDto {
  @IsUUID('4') membershipId!: string;
  @IsIn(LICENSED_ROLES) role!: (typeof LICENSED_ROLES)[number];
  @IsIn(RENEWAL_PERIODS) period!: (typeof RENEWAL_PERIODS)[number];
  /** licence_year: the year; expiry_date: null or left out (the pair is checked by the service). */
  @ValidateIf((body: RecordLicenceRenewalDto) => body.licenceYear !== null && body.licenceYear !== undefined)
  @IsInt() @Min(2000) @Max(2200)
  licenceYear?: number | null;
  /** expiry_date: the date; licence_year: null or left out. */
  @ValidateIf((body: RecordLicenceRenewalDto) => body.validUntil !== null && body.validUntil !== undefined)
  @IsCalendarDate()
  validUntil?: string | null;
  @IsIn(CHECKED_HOW) checkedHow!: (typeof CHECKED_HOW)[number];
  @IsCalendarDate() checkedOn!: string;
  /** The administrator confirms the text facility-licence-renewal-v1. */
  @Equals(true) attested!: true;
}

/** Route 5: withdraw a renewal entered by mistake. */
export class WithdrawLicenceRenewalDto {
  @IsIn(WITHDRAW_REASONS) reasonCode!: (typeof WITHDRAW_REASONS)[number];
}

/** Routes 8, 11, 13, 14 and 19: the version the screen read. */
export class ExpectedRowVersionDto {
  @IsInt() @Min(1) expectedRowVersion!: number;
}

/** Route 7: name an in-charge. */
export class NameInChargeDto {
  @Matches(DEPARTMENT_CODE) departmentCode!: string;
  @IsUUID('4') membershipId!: string;
}

/** Route 10: ask for leave (type and dates only; Q244 A, Q-ROS-15 A). */
export class CreateLeaveRequestDto {
  @IsIn(LEAVE_TYPES) leaveType!: (typeof LEAVE_TYPES)[number];
  @IsCalendarDate() startsOn!: string;
  @IsCalendarDate() endsOn!: string;
  @IsOptional() @Matches(DEPARTMENT_CODE) departmentCode?: string;
}

/** Route 12's query. */
export class LeaveToDecideQueryDto {
  @IsOptional() @IsIn(LEAVE_LIST_STATUSES) status?: (typeof LEAVE_LIST_STATUSES)[number];
  @IsOptional() @Matches(DEPARTMENT_CODE) departmentCode?: string;
}

/** Route 15's query. */
export class RosterWeekQueryDto {
  @IsCalendarDate() weekStart!: string;
}

/** Route 17: make the week's draft roster of a department. */
export class CreateRosterDto {
  @Matches(DEPARTMENT_CODE) departmentCode!: string;
  @IsCalendarDate() weekStart!: string;
}

export class RosterAssignmentDto {
  @IsUUID('4') membershipId!: string;
  @IsUUID('4') shiftId!: string;
  @IsCalendarDate() dutyDate!: string;
}

/** Route 18: the week's duties (0-500, each once). */
export class SetRosterAssignmentsDto {
  @IsInt() @Min(1) expectedRowVersion!: number;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => RosterAssignmentDto)
  assignments!: RosterAssignmentDto[];
}

/** Route 20: mark attendance; swapped names who worked instead, the other marks leave it out. */
export class MarkAttendanceDto {
  @IsInt() @Min(1) expectedRowVersion!: number;
  @IsIn(ATTENDANCE_MARKS) attendance!: (typeof ATTENDANCE_MARKS)[number];
  /** Exactly for swapped (checked by the service). */
  @ValidateIf((body: MarkAttendanceDto) => body.coveredByMembershipId !== undefined)
  @IsUUID('4')
  coveredByMembershipId?: string;
}

/** Route 21's query. */
export class OnDutyQueryDto {
  @IsOptional() @Matches(DEPARTMENT_CODE) departmentCode?: string;
}
