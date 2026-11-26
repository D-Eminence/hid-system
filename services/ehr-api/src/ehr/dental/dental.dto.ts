import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min,
  ValidateNested,
} from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

/**
 * DEN-1 (0194, 0195): the dental clinic's request bodies and queries. Built at
 * the recommended options Q-DEN-1 A to Q-DEN-6 A (not yet answered by the
 * owner). No Health ID or NIN in any field: patients, visits, chart versions
 * and procedures are named by UUID. The shapes are checked here (unknown
 * fields refused by the global pipe); the dental rules (FDI teeth, surfaces,
 * sites, the anaesthetic, reasons) are checked by DentalService, which answers
 * the contract's DENTAL_* codes, and again by the database.
 */

export const DENTITIONS = ['permanent', 'primary', 'mixed'] as const;
export type Dentition = (typeof DENTITIONS)[number];

export const DENTAL_SITES = ['tooth', 'tooth_surfaces', 'quadrant', 'arch', 'whole_mouth'] as const;
export type DentalSite = (typeof DENTAL_SITES)[number];

export const DENTAL_PROCEDURE_STATUSES = ['planned', 'done', 'cancelled', 'entered_in_error'] as const;
export type DentalProcedureStatus = (typeof DENTAL_PROCEDURE_STATUSES)[number];

export const DENTAL_LIST_FILTERS = ['planned', 'done', 'all'] as const;
export type DentalListFilter = (typeof DENTAL_LIST_FILTERS)[number];

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
/** A query number: digits only become a number; anything else stays as given and fails @IsInt. */
const queryInteger = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : value;
/** ISO 8601 in UTC with a Z, as every other time the API takes. */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?Z$/;
/** A calendar date, YYYY-MM-DD. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Route 5, GET ehr/dental-visits?days=1-30 (default 1: today, Lagos). */
export class DentalVisitsQueryDto {
  @IsOptionalButNotNull()
  @Transform(queryInteger)
  @IsInt()
  @Min(1)
  @Max(30)
  days?: number;
}

/** Route 6, GET ehr/patients/:patientId/dental-chart?versionId=uuid. */
export class DentalChartQueryDto {
  @IsOptionalButNotNull()
  @IsUUID('all')
  versionId?: string;
}

/** Route 13, GET ehr/patients/:patientId/dental-procedures?status=planned|done|all (default all). */
export class DentalProceduresQueryDto {
  @IsOptionalButNotNull()
  @IsIn(DENTAL_LIST_FILTERS)
  status?: DentalListFilter;
}

/**
 * Route 4, PATCH .../dental-visit: the follow-up date (a Lagos calendar day,
 * tomorrow to two years ahead) and the recall note, each set when sent (null
 * clears it); at least one of the two.
 */
export class DentalFollowUpDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsOptional()
  @IsString()
  @Matches(CALENDAR_DATE, { message: 'followUpOn must be a date YYYY-MM-DD' })
  followUpOn?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  followUpNote?: string | null;
}

/** One finding of a chart: an FDI tooth, a condition of the list, its surfaces, a short note. */
export class DentalFindingDto {
  @IsInt()
  tooth!: number;

  @IsString()
  @MaxLength(40)
  condition!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  surfaces?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  note?: string | null;
}

/** Route 7, POST .../dental-chart: the whole chart, a new version based on the newest one. */
export class DentalChartSaveDto {
  @IsOptional()
  @IsUUID('all')
  basedOnVersionId?: string | null;

  @IsIn(DENTITIONS)
  dentition!: Dentition;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => DentalFindingDto)
  findings!: DentalFindingDto[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

/** Route 8, POST .../dental-chart/:versionId/entered-in-error: the reason (8-500 characters). */
export class DentalChartErrorDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

/** The local anaesthetic of a done procedure (Q-DEN-6 A): an agent, or "none". */
export class DentalAnaestheticDto {
  @IsString()
  @MaxLength(40)
  agentCode!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  agentOther?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  techniqueCode?: string | null;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  cartridges?: number | null;
}

/** Route 9, POST .../dental-procedures: plan a procedure, or record one done (signed by the caller). */
export class DentalProcedureRecordDto {
  @IsIn(['planned', 'done'])
  status!: 'planned' | 'done';

  @IsOptional()
  @IsString()
  @MaxLength(20)
  procedureCode?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  procedureName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  site?: string | null;

  @IsOptional()
  @IsInt()
  tooth?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  surfaces?: string | null;

  @IsOptional()
  @IsInt()
  quadrant?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  arch?: string | null;

  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(UTC_INSTANT, { message: 'doneAt must be a UTC time ending in Z' })
  doneAt?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => DentalAnaestheticDto)
  anaesthetic?: DentalAnaestheticDto | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

/** Every change to a procedure names the `rowVersion` it was made on. */
export class DentalVersionedDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;
}

/** Route 10, POST .../dental-procedures/:procedureId/done: record a planned procedure done here, signed. */
export class DentalProcedureDoneDto extends DentalVersionedDto {
  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(UTC_INSTANT, { message: 'doneAt must be a UTC time ending in Z' })
  doneAt?: string | null;

  @ValidateNested()
  @Type(() => DentalAnaestheticDto)
  anaesthetic!: DentalAnaestheticDto;

  @IsOptionalButNotNull()
  @IsString()
  @MaxLength(10)
  surfaces?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

/** Routes 11 and 12: cancel a planned procedure, or mark a done one entered in error, with a reason. */
export class DentalProcedureReasonDto extends DentalVersionedDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
