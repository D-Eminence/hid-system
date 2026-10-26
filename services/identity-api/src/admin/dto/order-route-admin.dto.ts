import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength }
  from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Support lists or unlists a facility for orders from other facilities (C23, PRIV P6). */
export class SetOrderRouteDestinationDto {
  @IsBoolean()
  listed!: boolean;

  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/** Support closes a live order route (C22). */
export class CloseOrderRouteDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/**
 * Support finds order routes by their reference or by the patient's Health ID
 * (C21): exactly one. The body of POST admin/order-routes/search, so a Health
 * ID goes in no URL, whose request line access logs and browser history keep
 * (CODEX §26, as POST principals/search and P4's CAC search).
 */
export class FindOrderRoutesDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(64)
  reference?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(64)
  healthId?: string;
}

/**
 * The query of GET admin/order-routes: the lookup by reference only. A
 * healthId query parameter is refused 400 HEALTH_ID_NOT_ACCEPTED_IN_URL
 * before the guard (health-id-in-url.ts); by Health ID is the POST.
 */
export class FindOrderRoutesQueryDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(64)
  reference?: string;
}

export const WRONG_PATIENT_REPORT_STATUSES = ['unreviewed', 'recent'] as const;

/**
 * GET admin/wrong-patient-reports (C26, item 3 §5.2): the unreviewed reports
 * (flagged first, then oldest first) or the last 90 days' (newest first),
 * optionally of one receiving facility (the laboratory or pharmacy that
 * reported). Support's Overview tile counts the unreviewed list.
 */
export class ListWrongPatientReportsQueryDto {
  @IsIn(WRONG_PATIENT_REPORT_STATUSES)
  status!: (typeof WRONG_PATIENT_REPORT_STATUSES)[number];

  @IsOptional() @IsUUID('4')
  facilityId?: string;
}

/**
 * What support did about a report (V2, D10, D14): one or more of the five
 * actions, or exactly no_further_action (C27 refuses the mix, 400
 * WRONG_PATIENT_REVIEW_INVALID).
 */
export const WRONG_PATIENT_REVIEW_ACTIONS = ['ordering_facility_told', 'facility_contacted', 'staff_access_changed',
  'facility_suspended', 'referred_to_dpo', 'no_further_action'] as const;

/** POST admin/wrong-patient-reports/:reportId/review (C27): once, with If-Match. */
export class ReviewWrongPatientReportDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(WRONG_PATIENT_REVIEW_ACTIONS.length) @ArrayUnique()
  @IsIn(WRONG_PATIENT_REVIEW_ACTIONS, { each: true })
  actions!: (typeof WRONG_PATIENT_REVIEW_ACTIONS)[number][];

  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  note!: string;

  /** Replace the reporter's note with fixed text, once (D7, C11). Absent means false. */
  @IsOptional() @IsBoolean()
  removeNote?: boolean;
}
