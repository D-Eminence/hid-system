import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export const ORDER_ROUTE_VIEWS = ['incoming', 'recent'] as const;

/**
 * GET lab/order-routes (SPEC-FINAL §10.2): Incoming or Recent. It takes no
 * Health ID: a Health ID in a URL is in the request line access logs and
 * browser history keep (CODEX §26), so a healthId query parameter is refused
 * 400 HEALTH_ID_NOT_ACCEPTED_IN_URL before the guard (health-id-in-url.ts).
 * Find by Health ID is POST lab/order-routes/search.
 */
export class ListOrderRoutesQueryDto {
  @IsOptional() @IsIn(ORDER_ROUTE_VIEWS)
  view?: (typeof ORDER_ROUTE_VIEWS)[number];
}

/** POST lab/order-routes/search: the same lists, found by the patient's Health ID in the body (P2: never by date of birth). */
export class SearchOrderRoutesDto {
  @IsOptional() @IsIn(ORDER_ROUTE_VIEWS)
  view?: (typeof ORDER_ROUTE_VIEWS)[number];

  @IsString() @MinLength(1) @MaxLength(64)
  healthId!: string;
}

export const PATIENT_IDENTIFIER_KINDS = ['health_id', 'date_of_birth'] as const;

/** What the receiver confirms of the patient to accept (owner Q3, PRIV P2). */
export class PatientIdentifierDto {
  @IsIn(PATIENT_IDENTIFIER_KINDS)
  kind!: (typeof PATIENT_IDENTIFIER_KINDS)[number];

  @IsString() @MinLength(1) @MaxLength(64)
  value!: string;
}

export class AcceptOrderRouteDto {
  @IsInt() @Min(1)
  expectedVersion!: number;

  @IsDefined() @ValidateNested() @Type(() => PatientIdentifierDto)
  patientIdentifier!: PatientIdentifierDto;

  /**
   * The order's reference, as the patient sees it in the app (8 characters).
   * With a date of birth it names this order, so a wrong date counts towards
   * this order's 5 tries; a date of birth without it counts only towards the
   * member's day and the order's 20 in all (C9). Optional.
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
 * POST lab/order-routes/:routeId/wrong-patient (C25): the laboratory accepted
 * this order for someone who was not its patient. The note is for Health ID
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
