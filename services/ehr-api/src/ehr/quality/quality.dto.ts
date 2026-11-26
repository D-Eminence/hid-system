import { Transform, type TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

/**
 * QUAL-1 (0197, 0198): quality and safety reporting's request bodies and
 * queries. Owner decisions Q248 A-Q253 A (25 November 2026), built at the
 * recommended options Q-QUAL-1 A to Q-QUAL-8 A (not yet answered by the
 * owner). No Health ID or NIN in any field: incidents, actions and leads are
 * named by UUID, staff by membership UUID, the patient by the patient's UUID
 * in a body only. Every body takes only its declared fields (the global
 * validation pipe refuses any other as 400 VALIDATION_FAILED).
 */

/** The incident categories of every list version (Q250 A; the words come from route 1, DRAFT QS-DRAFT-1). */
export const QUALITY_CATEGORIES = ['medication', 'patient_fall', 'identification_documentation', 'procedure_treatment',
  'infection_control', 'equipment_device', 'blood_transfusion', 'safety_security', 'facility_environment',
  'other'] as const;
export type QualityCategory = (typeof QUALITY_CATEGORIES)[number];

/** The harm scale: near miss plus five levels. */
export const QUALITY_HARM_LEVELS = ['near_miss', 'no_harm', 'mild', 'moderate', 'severe', 'death'] as const;
export type QualityHarmLevel = (typeof QUALITY_HARM_LEVELS)[number];

/** "Patient or family told" is required for these (Q252 A). */
export const QUALITY_TOLD_REQUIRED_FOR: readonly QualityHarmLevel[] = ['moderate', 'severe', 'death'];

export const QUALITY_TOLD_VALUES = ['yes', 'no', 'not_applicable'] as const;
export type QualityTold = (typeof QUALITY_TOLD_VALUES)[number];

export const QUALITY_STATUSES = ['reported', 'assigned', 'investigated', 'resolved'] as const;
export type QualityStatus = (typeof QUALITY_STATUSES)[number];

export const QUALITY_ACTION_STATUSES = ['open', 'done', 'cancelled'] as const;
export type QualityActionStatus = (typeof QUALITY_ACTION_STATUSES)[number];

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
/** A query number: digits only become a number; anything else stays as given and fails @IsInt. */
const queryInteger = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : value;
/** One line: no control characters at all (as the database's [[:cntrl:]] check). */
export const ONE_LINE = /^[^\u0000-\u001f\u007f]*$/;
/** Several lines: new lines and tabs, but no other control character. */
export const SEVERAL_LINES = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
/** ISO 8601 in UTC with a Z, as every other time the API takes. */
export const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?Z$/;
/** A calendar day, YYYY-MM-DD. */
export const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A code's shape (the database decides whether it is one of the list's or the facility's). */
const CODE = /^[a-z][a-z_]{1,39}$/;

/** Route 2, POST ehr/quality/incidents. */
export class QualityReportDto {
  @Transform(trim)
  @IsString()
  @Length(3, 120)
  @Matches(ONE_LINE, { message: 'title must not contain control characters' })
  title!: string;

  /** "What happened". */
  @Transform(trim)
  @IsString()
  @Length(10, 4000)
  @Matches(SEVERAL_LINES, { message: 'description must not contain control characters' })
  description!: string;

  @IsString()
  @Matches(UTC_INSTANT, { message: 'occurredAt must be a UTC time ending in Z' })
  occurredAt!: string;

  /** One of this facility's departments (route 1's departmentCodes). */
  @IsOptional()
  @IsString()
  @Matches(CODE, { message: 'departmentCode must be a department code' })
  departmentCode?: string | null;

  /** "Where exactly". */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  @Matches(ONE_LINE, { message: 'locationText must not contain control characters' })
  locationText?: string | null;

  @IsString()
  @Matches(CODE, { message: 'category must be a code from the list' })
  category!: string;

  @IsString()
  @Matches(CODE, { message: 'harmLevel must be a code from the list' })
  harmLevel!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 2000)
  @Matches(SEVERAL_LINES, { message: 'immediateAction must not contain control characters' })
  immediateAction?: string | null;

  @IsOptional()
  @IsIn(QUALITY_TOLD_VALUES)
  patientOrFamilyTold?: QualityTold | null;

  /** The patient of the page the report was started from (Q-QUAL-2 A); only while the patient link is on. */
  @IsOptional()
  @IsUUID('all')
  patientId?: string | null;
}

/** Route 3, GET ehr/quality/incidents. */
export class QualityListQueryDto {
  @IsOptionalButNotNull()
  @IsIn([...QUALITY_STATUSES, 'open'])
  status?: QualityStatus | 'open';

  @IsOptionalButNotNull()
  @IsIn(QUALITY_CATEGORIES)
  category?: QualityCategory;

  @IsOptionalButNotNull()
  @IsIn(QUALITY_HARM_LEVELS)
  harmLevel?: QualityHarmLevel;

  @IsOptionalButNotNull()
  @IsString()
  @Matches(CODE, { message: 'departmentCode must be a department code' })
  departmentCode?: string;

  /** Lagos days, inclusive, at most 366 days apart. */
  @IsOptionalButNotNull()
  @IsString()
  @Matches(DAY, { message: 'occurredFrom must be a day, YYYY-MM-DD' })
  occurredFrom?: string;

  @IsOptionalButNotNull()
  @IsString()
  @Matches(DAY, { message: 'occurredTo must be a day, YYYY-MM-DD' })
  occurredTo?: string;

  @IsOptionalButNotNull()
  @IsIn(['reported', 'assigned'])
  mine?: 'reported' | 'assigned';

  @IsOptionalButNotNull()
  @Transform(queryInteger)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptionalButNotNull()
  @IsString()
  @MaxLength(400)
  cursor?: string;
}

/** Every write but naming and ending a lead names the card's `rowVersion` it was made on. */
export class QualityVersionedDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;
}

/** Route 5, POST ehr/quality/incidents/:incidentId/assign (manager). */
export class QualityAssignDto extends QualityVersionedDto {
  @IsUUID('all')
  reviewerMembershipId!: string;
}

/** Route 6, POST ehr/quality/incidents/:incidentId/investigation (the reviewer or a manager). */
export class QualityInvestigationDto extends QualityVersionedDto {
  @Transform(trim)
  @IsString()
  @Length(10, 4000)
  @Matches(SEVERAL_LINES, { message: 'findings must not contain control characters' })
  findings!: string;
}

/** Route 7, POST ehr/quality/incidents/:incidentId/actions (the reviewer or a manager). */
export class QualityActionAddDto extends QualityVersionedDto {
  @Transform(trim)
  @IsString()
  @Length(5, 500)
  @Matches(SEVERAL_LINES, { message: 'description must not contain control characters' })
  description!: string;

  @IsUUID('all')
  ownerMembershipId!: string;

  @IsString()
  @Matches(DAY, { message: 'dueDate must be a day, YYYY-MM-DD' })
  dueDate!: string;
}

/** Route 8, POST ehr/quality/incidents/:incidentId/actions/:actionId (the reviewer or a manager). */
export class QualityActionUpdateDto extends QualityVersionedDto {
  @IsOptionalButNotNull()
  @IsIn(QUALITY_ACTION_STATUSES)
  status?: QualityActionStatus;

  /** 2-500 characters; required to cancel (QUALITY_REASON_REQUIRED). */
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(2, 500)
  @Matches(SEVERAL_LINES, { message: 'note must not contain control characters' })
  note?: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  ownerMembershipId?: string;

  @IsOptionalButNotNull()
  @IsString()
  @Matches(DAY, { message: 'dueDate must be a day, YYYY-MM-DD' })
  dueDate?: string;
}

/** Route 9, POST ehr/quality/incidents/:incidentId/resolve (manager). */
export class QualityResolveDto extends QualityVersionedDto {
  @Transform(trim)
  @IsString()
  @Length(10, 2000)
  @Matches(SEVERAL_LINES, { message: 'resolution must not contain control characters' })
  resolution!: string;
}

/** Route 10, POST ehr/quality/incidents/:incidentId/reopen (manager): a reason of 8-500 characters. */
export class QualityReopenDto extends QualityVersionedDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  reason?: string;
}

/**
 * Route 11, POST ehr/quality/incidents/:incidentId/correction (manager): a
 * reason, and at least one of the fields; `null` clears departmentCode,
 * locationText, patientOrFamilyTold or patientId. The report as filed never
 * changes.
 */
export class QualityCorrectionDto extends QualityVersionedDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  reason?: string;

  @IsOptionalButNotNull()
  @IsString()
  @Matches(CODE, { message: 'category must be a code from the list' })
  category?: string;

  @IsOptionalButNotNull()
  @IsString()
  @Matches(CODE, { message: 'harmLevel must be a code from the list' })
  harmLevel?: string;

  @IsOptional()
  @IsString()
  @Matches(CODE, { message: 'departmentCode must be a department code' })
  departmentCode?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  @Matches(ONE_LINE, { message: 'locationText must not contain control characters' })
  locationText?: string | null;

  @IsOptional()
  @IsIn(QUALITY_TOLD_VALUES)
  patientOrFamilyTold?: QualityTold | null;

  @IsOptional()
  @IsUUID('all')
  patientId?: string | null;
}

/** Route 12, GET ehr/quality/incident-counts?month=YYYY-MM[&format=csv] (manager). */
export class QualityCountsQueryDto {
  /** A Lagos month that has started; anything else answers QUALITY_MONTH_INVALID. */
  @IsString()
  @MaxLength(20)
  month!: string;

  @IsOptionalButNotNull()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}

/** Route 14, POST ehr/quality/leads (quality.incident.manage). */
export class QualityLeadNameDto {
  @IsUUID('all')
  membershipId!: string;
}

/** Route 15, POST ehr/quality/leads/:leadId/end (quality.incident.manage): a reason of 8-500 characters. */
export class QualityLeadEndDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  reason?: string;
}
