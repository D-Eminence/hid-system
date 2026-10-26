import { Transform, Type } from 'class-transformer';
import { IsDefined, IsIn, IsInt, IsOptional, IsString, Length, Matches, MaxLength, Min, MinLength, ValidateNested }
  from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export const ORDER_ROUTE_VIEWS = ['incoming', 'recent'] as const;

/**
 * GET pharmacy/order-routes (SPEC-FINAL §10.2): Incoming or Recent. It takes
 * no Health ID: a Health ID in a URL is in the request line access logs and
 * browser history keep (CODEX §26), so a healthId query parameter is refused
 * 400 HEALTH_ID_NOT_ACCEPTED_IN_URL before the guard (health-id-in-url.ts).
 * Find by Health ID is POST pharmacy/order-routes/search.
 */
export class ListOrderRoutesQueryDto {
  @IsOptional() @IsIn(ORDER_ROUTE_VIEWS)
  view?: (typeof ORDER_ROUTE_VIEWS)[number];
}

/** POST pharmacy/order-routes/search: the same lists, found by the patient's Health ID in the body (P2: never by date of birth). */
export class SearchOrderRoutesDto {
  @IsOptional() @IsIn(ORDER_ROUTE_VIEWS)
  view?: (typeof ORDER_ROUTE_VIEWS)[number];

  @IsString() @MinLength(1) @MaxLength(64)
  healthId!: string;
}

export const PATIENT_IDENTIFIER_KINDS = ['health_id', 'date_of_birth'] as const;

export class PatientIdentifierDto {
  @IsIn(PATIENT_IDENTIFIER_KINDS)
  kind!: (typeof PATIENT_IDENTIFIER_KINDS)[number];

  @IsString() @MinLength(1) @MaxLength(64)
  value!: string;
}

/** Acceptance: the patient's identifier and the pharmacist's acceptance reason (8-500, NMIG 0023:78). */
export class AcceptOrderRouteDto {
  @IsInt() @Min(1)
  expectedVersion!: number;

  @IsDefined() @ValidateNested() @Type(() => PatientIdentifierDto)
  patientIdentifier!: PatientIdentifierDto;

  @Transform(trim) @IsString() @Length(8, 500)
  reason!: string;

  /**
   * The order's reference, as the patient sees it in the app (8 characters).
   * With a date of birth it names this order, so a wrong date counts towards
   * this order's 5 tries; a date of birth without it counts only towards the
   * member's day and the order's 20 in all (C15). Optional.
   */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(16)
  reference?: string;
}

export const DECLINE_REASONS = ['test_not_offered', 'medicine_unavailable', 'cannot_meet_priority', 'patient_not_seen',
  'other'] as const;

export class DeclineOrderRouteDto {
  @IsInt() @Min(1)
  expectedVersion!: number;

  @IsIn(DECLINE_REASONS)
  reason!: (typeof DECLINE_REASONS)[number];
}

/** What happened at the counter (SPEC-FINAL item 3 §4.3, D6, D18: "other" is "not the patient for another reason"). */
export const WRONG_PATIENT_REASONS = ['wrong_order_chosen', 'someone_elses_details', 'suspected_misuse', 'other'] as const;

/**
 * POST pharmacy/order-routes/:routeId/wrong-patient (C25): the pharmacy
 * accepted this prescription for someone who was not its patient (someone
 * collecting with the patient's agreement is not). The note is for Health ID
 * support only (D7): 8 to 500 characters once trimmed (the service refuses a
 * shorter one after the trim, 400 ORDER_ROUTE_INVALID), never in an audit row.
 */
export class ReportWrongPatientDto {
  @IsInt() @Min(1)
  expectedVersion!: number;

  @IsIn(WRONG_PATIENT_REASONS)
  reason!: (typeof WRONG_PATIENT_REASONS)[number];

  @IsString() @MinLength(8) @MaxLength(500)
  note!: string;
}

/** How the pharmacy found out that the prescription's patient was not the person it accepted it for (D17, CL11). */
export const DISCOVERED_BY = ['patient', 'ordering_facility', 'own_check', 'support', 'other'] as const;

/**
 * POST pharmacy/order-routes/:routeId/wrong-patient-correction (C29, D17
 * SPEC-FINAL §5.1): the late correction of a prescription the pharmacy
 * accepted for the wrong person, after it ended or its window lapsed, until
 * 180 days after acceptance. Every field is required. `discoveredOn` is the
 * Lagos day the pharmacy found out, a calendar date not after today nor
 * before the acceptance day (the service checks the calendar, the command
 * the bounds: 400 ORDER_ROUTE_INVALID). The note is for Health ID support
 * only: 8 to 500 characters once trimmed, never in an audit row.
 */
export class CorrectWrongPatientDto {
  @IsInt() @Min(1)
  expectedVersion!: number;

  @IsIn(WRONG_PATIENT_REASONS)
  reason!: (typeof WRONG_PATIENT_REASONS)[number];

  @IsIn(DISCOVERED_BY)
  discoveredBy!: (typeof DISCOVERED_BY)[number];

  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  discoveredOn!: string;

  @IsString() @MinLength(8) @MaxLength(500)
  note!: string;
}

/**
 * POST pharmacy/order-routes/correctable (C30, D17-8): a prescription this
 * pharmacy accepted, found by its exact 8-character reference, sent in the
 * body so it is in no request line. 1 to 16 characters as
 * `AcceptOrderRouteDto.reference`; the service trims, upper-cases and checks
 * it (400 ORDER_ROUTE_INVALID).
 */
export class FindCorrectableDto {
  @IsString() @MinLength(1) @MaxLength(16)
  reference!: string;
}
