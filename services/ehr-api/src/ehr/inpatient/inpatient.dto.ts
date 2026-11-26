import { Transform, type TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID,
  Length, Matches, Min, ValidateNested,
} from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

/**
 * ADT-1 (0170-0173): the inpatient routes' request bodies and queries. Built
 * at the owner's decisions of 25 November 2026 (Q147-Q290 at the recommended
 * options) and the section's smaller choices Q-ADT-9 A to Q-ADT-18 A. No
 * Health ID or NIN in any field: patients, admissions, wards and beds are
 * named by UUID.
 */

export const WARD_TYPES = ['general', 'paediatric', 'maternity', 'icu', 'private', 'other'] as const;
export type WardType = (typeof WARD_TYPES)[number];
export const WARD_TAKES = ['any', 'male', 'female'] as const;
export type WardTakes = (typeof WARD_TAKES)[number];
export const BED_KINDS = ['bed', 'overflow'] as const;
export type BedKind = (typeof BED_KINDS)[number];
/** The statuses a member may set by hand (occupied is set by an admission only). */
export const BED_HAND_STATUSES = ['available', 'cleaning', 'maintenance'] as const;
export type BedHandStatus = (typeof BED_HAND_STATUSES)[number];
export const ADMISSION_SOURCES = ['consultation', 'ed', 'waiting_list', 'direct'] as const;
export type AdmissionSource = (typeof ADMISSION_SOURCES)[number];
export const ADMISSION_STATUSES = ['open', 'requested', 'admitted', 'discharge_ready', 'discharged', 'cancelled'] as const;
/** Q187 A. */
export const DISCHARGE_OUTCOMES = ['routine', 'dama', 'referred_out', 'absconded', 'died'] as const;
export type DischargeOutcome = (typeof DISCHARGE_OUTCOMES)[number];
export const DISCHARGE_CONDITIONS = ['improved', 'unchanged', 'worse', 'not_applicable'] as const;
/** Q-ADT-16 A: why a band is printed again. */
export const REPRINT_REASONS = ['lost', 'damaged', 'details_changed', 'moved_ward'] as const;
export type ReprintReason = (typeof REPRINT_REASONS)[number];
export const DEATH_MANNERS = ['natural', 'accident', 'intentional_self_harm', 'assault', 'pending_investigation',
  'unknown'] as const;
export const DEATH_AUTOPSY = ['not_requested', 'requested', 'done'] as const;
export const DEATH_RECORD_FORMS = ['certificate', 'registration-notice'] as const;

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
/** A query flag: exactly "true" or "false"; anything else stays as given and fails @IsBoolean. */
const queryFlag = ({ value }: TransformFnParams): unknown => value === 'true' ? true : value === 'false' ? false : value;
/** No control characters (as the database's [[:cntrl:]] check). */
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
/** No control characters but line breaks (handover, plans and summaries are written in lines). */
const TEXT_LINES = /^[^\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]*$/;
/** ISO 8601 in UTC with a Z, as every other time the API takes. */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?Z$/;
const LAGOS_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every write on a ward, bed or admission names the row version it was made on (412 when stale). */
export class VersionedDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;
}

/** Route 1, GET ehr/wards. */
export class WardListQueryDto {
  @IsOptionalButNotNull()
  @Transform(queryFlag)
  @IsBoolean()
  includeInactive?: boolean;

  /** Each ward's beds and staff list (the ward configuration screen). */
  @IsOptionalButNotNull()
  @Transform(queryFlag)
  @IsBoolean()
  includeBeds?: boolean;
}

/** Route 2, POST ehr/wards. */
export class CreateWardDto {
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  @Matches(NO_CONTROL, { message: 'name must not contain control characters' })
  name!: string;

  @IsIn(WARD_TYPES)
  wardType!: WardType;

  @IsOptionalButNotNull()
  @IsIn(WARD_TAKES)
  takes?: WardTakes;
}

/** Route 3, PATCH ehr/wards/:wardId. */
export class UpdateWardDto extends VersionedDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  @Matches(NO_CONTROL, { message: 'name must not contain control characters' })
  name?: string;

  @IsOptionalButNotNull()
  @IsIn(WARD_TYPES)
  wardType?: WardType;

  @IsOptionalButNotNull()
  @IsIn(WARD_TAKES)
  takes?: WardTakes;

  @IsOptionalButNotNull()
  @IsBoolean()
  active?: boolean;
}

/** Route 4, POST ehr/wards/:wardId/beds. */
export class CreateBedDto {
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  @Matches(NO_CONTROL, { message: 'name must not contain control characters' })
  name!: string;

  @IsOptionalButNotNull()
  @IsIn(BED_KINDS)
  kind?: BedKind;
}

/** Route 5, PATCH ehr/beds/:bedId. */
export class UpdateBedDto extends VersionedDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  @Matches(NO_CONTROL, { message: 'name must not contain control characters' })
  name?: string;

  @IsOptionalButNotNull()
  @IsBoolean()
  active?: boolean;
}

/** Route 6, PUT ehr/wards/:wardId/staff. */
export class WardStaffDto extends VersionedDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  membershipIds!: string[];
}

/** Route 7, GET ehr/bed-board: exactly one of wardId or wardType. */
export class BedBoardQueryDto {
  @IsOptionalButNotNull()
  @IsUUID('all')
  wardId?: string;

  @IsOptionalButNotNull()
  @IsIn(WARD_TYPES)
  wardType?: WardType;
}

/** Route 8, GET ehr/census[?date=YYYY-MM-DD] (a Lagos day, up to 90 days back). */
export class CensusQueryDto {
  @IsOptionalButNotNull()
  @Matches(LAGOS_DATE, { message: 'date must be YYYY-MM-DD' })
  @IsDateString({ strict: true })
  date?: string;
}

/** Route 9, POST ehr/beds/:bedId/status. */
export class BedStatusDto extends VersionedDto {
  @IsIn(BED_HAND_STATUSES)
  status!: BedHandStatus;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  @Matches(NO_CONTROL, { message: 'note must not contain control characters' })
  note?: string;
}

/** Route 10, POST ehr/admissions. */
export class RequestAdmissionDto {
  @IsUUID('all')
  patientId!: string;

  @IsIn(ADMISSION_SOURCES)
  source!: AdmissionSource;

  @IsOptionalButNotNull()
  @IsUUID('all')
  fromEncounterId?: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  edAttendanceId?: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  visitQueueEntryId?: string;

  @Transform(trim)
  @IsString()
  @Length(1, 300)
  @Matches(NO_CONTROL, { message: 'reason must not contain control characters' })
  reason!: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  @Matches(NO_CONTROL, { message: 'careTeam must not contain control characters' })
  careTeam?: string;

  /** Required, except for an ED request, where it defaults to ED-1's admitting doctor. */
  @IsOptionalButNotNull()
  @IsUUID('all')
  responsibleMembershipId?: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  requestedWardId?: string;

  /** Q-ADT-17 A: a newborn's admission names the mother's open admission. */
  @IsOptionalButNotNull()
  @IsUUID('all')
  motherAdmissionId?: string;
}

/** Route 11, GET ehr/admissions. */
export class AdmissionListQueryDto {
  @IsOptionalButNotNull()
  @IsIn(ADMISSION_STATUSES)
  status?: (typeof ADMISSION_STATUSES)[number];

  @IsOptionalButNotNull()
  @IsUUID('all')
  wardId?: string;

  @IsOptionalButNotNull()
  @IsIn(WARD_TYPES)
  wardType?: WardType;
}

/** Route 13, POST ehr/admissions/:admissionId/admit. */
export class AdmitDto extends VersionedDto {
  @IsUUID('all')
  bedId!: string;

  @IsOptionalButNotNull()
  @IsBoolean()
  confirmSexMismatch?: boolean;
}

/** Route 14, POST ehr/admissions/:admissionId/transfer. */
export class TransferDto extends AdmitDto {
  /** Clinical: giving it needs write access to the chart (Q-ADT-11 A). */
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  @Matches(TEXT_LINES, { message: 'handover must not contain control characters' })
  handover?: string;
}

/** Route 15, POST ehr/admissions/:admissionId/prepare-discharge. */
export class PrepareDischargeDto extends VersionedDto {
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  @Matches(TEXT_LINES, { message: 'followUpPlan must not contain control characters' })
  followUpPlan!: string;

  @IsOptionalButNotNull()
  @Matches(LAGOS_DATE, { message: 'expectedDischargeOn must be YYYY-MM-DD' })
  @IsDateString({ strict: true })
  expectedDischargeOn?: string;

  @IsOptionalButNotNull()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  dischargeMedicineIds?: string[];
}

/** The discharge summary (route 16). Each text 0-4000 characters; the first two at least 1. */
export class DischargeSummaryDto {
  @Transform(trim)
  @IsString()
  @Length(1, 4000)
  @Matches(TEXT_LINES, { message: 'presentingProblem must not contain control characters' })
  presentingProblem!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 4000)
  @Matches(TEXT_LINES, { message: 'courseInHospital must not contain control characters' })
  courseInHospital!: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(0, 4000)
  @Matches(TEXT_LINES, { message: 'proceduresDone must not contain control characters' })
  proceduresDone?: string;

  @IsOptionalButNotNull()
  @IsIn(DISCHARGE_CONDITIONS)
  conditionAtDischarge?: (typeof DISCHARGE_CONDITIONS)[number];

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(0, 4000)
  @Matches(TEXT_LINES, { message: 'followUpPlan must not contain control characters' })
  followUpPlan?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(0, 4000)
  @Matches(TEXT_LINES, { message: 'patientAdvice must not contain control characters' })
  patientAdvice?: string;
}

/** Route 16, POST ehr/admissions/:admissionId/discharge. */
export class DischargeDto extends VersionedDto {
  @IsIn(DISCHARGE_OUTCOMES)
  outcome!: DischargeOutcome;

  @IsOptionalButNotNull()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(UTC_INSTANT, { message: 'dischargedAt must be a UTC time ending in Z' })
  dischargedAt?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DischargeSummaryDto)
  summary?: DischargeSummaryDto | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  @Matches(NO_CONTROL, { message: 'referredToFacilityName must not contain control characters' })
  referredToFacilityName?: string | null;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(UTC_INSTANT, { message: 'diedAt must be a UTC time ending in Z' })
  diedAt?: string | null;

  /** The typed word SIGN (the design's TYPED_WORD_ACTIONS). */
  @IsOptional()
  @IsString()
  signature?: string;
}

/** Route 17, POST ehr/admissions/:admissionId/cancel. */
export class CancelAdmissionDto extends VersionedDto {
  @Transform(trim)
  @IsString()
  @Length(8, 500)
  @Matches(TEXT_LINES, { message: 'reason must not contain control characters' })
  reason!: string;
}

/** Route 18, PATCH ehr/admissions/:admissionId. */
export class UpdateAdmissionDto extends VersionedDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  @Matches(NO_CONTROL, { message: 'careTeam must not contain control characters' })
  careTeam?: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  responsibleMembershipId?: string;

  @IsOptionalButNotNull()
  @Matches(LAGOS_DATE, { message: 'expectedDischargeOn must be YYYY-MM-DD' })
  @IsDateString({ strict: true })
  expectedDischargeOn?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  @Matches(NO_CONTROL, { message: 'reason must not contain control characters' })
  reason?: string;
}

/** Routes 20 and 21: the first print needs no reason; a reprint needs one. */
export class BandPrintDto {
  @IsOptionalButNotNull()
  @IsIn(REPRINT_REASONS)
  reprintReason?: ReprintReason;
}

/** Route 22 (switched off): one cause line of the WHO form. */
export class DeathCauseDto {
  @IsIn(['a', 'b', 'c', 'd'])
  line!: 'a' | 'b' | 'c' | 'd';

  @Transform(trim)
  @IsString()
  @Length(1, 300)
  @Matches(NO_CONTROL, { message: 'text must not contain control characters' })
  text!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  interval?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9A-Z][0-9A-Z.&/]{1,30}$/, { message: 'icd11Code must be an ICD-11 code' })
  icd11Code?: string | null;
}

/** Route 22 (switched off): the medical certificate of cause of death. */
export class DeathRecordDto {
  @IsOptionalButNotNull()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(UTC_INSTANT, { message: 'diedAt must be a UTC time ending in Z' })
  diedAt?: string;

  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => DeathCauseDto)
  causes!: DeathCauseDto[];

  @IsOptionalButNotNull()
  @IsString()
  @Length(0, 2000)
  otherConditions?: string;

  @IsIn(DEATH_MANNERS)
  manner!: (typeof DEATH_MANNERS)[number];

  @IsIn(DEATH_AUTOPSY)
  autopsy!: (typeof DEATH_AUTOPSY)[number];

  @IsOptionalButNotNull()
  @IsIn(['not_applicable', 'not_pregnant', 'pregnant', 'within_42_days', 'within_one_year', 'unknown'])
  pregnancyStatus?: string;

  @IsOptionalButNotNull()
  @IsIn(['ward', 'icu', 'theatre', 'emergency', 'other'])
  placeOfDeath?: string;

  @IsString()
  signature!: string;
}

/** Route 22: amend, with a reason (8-500). */
export class DeathRecordAmendDto extends DeathRecordDto {
  @Transform(trim)
  @IsString()
  @Length(8, 500)
  reason!: string;
}

export class DeathRecordPrintQueryDto {
  @IsIn(DEATH_RECORD_FORMS)
  form!: (typeof DEATH_RECORD_FORMS)[number];
}

/** PUT commercial/ward-charges/:wardId (Q189 A, needs BILL-1). */
export class WardChargesDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsOptional()
  @IsUUID('all')
  bedDayItemId?: string | null;

  @IsOptional()
  @IsUUID('all')
  admissionFeeItemId?: string | null;
}
