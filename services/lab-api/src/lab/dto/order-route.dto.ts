import { Type } from 'class-transformer';
import { Equals, IsBoolean, IsDefined, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength,
  ValidateNested } from 'class-validator';

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

/** How the laboratory found out that the order's patient was not the person it accepted it for (D17, CL11). */
export const DISCOVERED_BY = ['patient', 'ordering_facility', 'own_check', 'support', 'other'] as const;

/**
 * POST lab/order-routes/:routeId/wrong-patient-correction (C29, D17 SPEC-FINAL
 * §5.1): the late correction of an order the laboratory accepted for the
 * wrong person, after the order has ended or its window lapsed, until 180
 * days after acceptance. Every field is required. `discoveredOn` is the Lagos
 * day the laboratory found out, a calendar date not after today nor before
 * the acceptance day (the service checks the calendar, the command the
 * bounds: 400 ORDER_ROUTE_INVALID). The note is for Health ID support only:
 * 8 to 500 characters once trimmed, never in an audit row.
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
 * Why a laboratory that accepted a lab request can't complete it (D18-5,
 * SPEC-FINAL D18 §4.3): fixed codes, no free text (D18-6), none about
 * identity or money. 0091's command and its endings table hold the same
 * list, and so does the shared fixture
 * services/ehr-api/test/fixtures/order-route-cannot-complete-reasons.sql
 * (tested equal).
 */
export const LAB_CANNOT_COMPLETE_REASONS = ['test_not_offered', 'supplies_unavailable', 'equipment_unavailable',
  'sample_unusable', 'sample_not_obtained', 'cannot_meet_priority', 'patient_declined', 'patient_did_not_return',
  'other'] as const;

/**
 * POST lab/order-routes/:routeId/cannot-complete (C31, D18 SPEC-FINAL §5.1):
 * the laboratory accepted this order and can't complete it. One reason of the
 * laboratory's list; `confirmedPatient` must be `true`: the member states
 * that the person it accepted the order for was the order's patient (one who
 * was not uses "This isn't the order's patient"). `criticalValueTold: true`
 * states that the ordering facility was phoned about a possibly critical
 * value recorded on the order; the command requires it only when there is
 * one (D18-15), and anything but `true` is read as not told. Unknown fields
 * are refused.
 */
export class CannotCompleteOrderRouteDto {
  @IsInt() @Min(1)
  expectedVersion!: number;

  @IsIn(LAB_CANNOT_COMPLETE_REASONS)
  reason!: (typeof LAB_CANNOT_COMPLETE_REASONS)[number];

  @Equals(true)
  confirmedPatient!: true;

  @IsOptional() @IsBoolean()
  criticalValueTold?: boolean;
}

/**
 * POST lab/order-routes/correctable (C30, D17-8): an order this laboratory
 * accepted, found by its exact 8-character reference, sent in the body so it
 * is in no request line (with a date of birth it names an order at
 * acceptance). 1 to 16 characters as `AcceptOrderRouteDto.reference`; the
 * service trims, upper-cases and checks it (400 ORDER_ROUTE_INVALID).
 */
export class FindCorrectableDto {
  @IsString() @MinLength(1) @MaxLength(16)
  reference!: string;
}
