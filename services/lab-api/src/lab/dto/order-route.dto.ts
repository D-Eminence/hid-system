import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

export const ORDER_ROUTE_VIEWS = ['incoming', 'recent'] as const;

/**
 * GET lab/order-routes (SPEC-FINAL §10.2): Incoming or Recent. The
 * healthId query parameter is kept for the website build that still sends it
 * (deprecated): a Health ID in a URL is in the request line access logs keep
 * (CODEX §26). The gateway no longer logs query strings; the website moves to
 * POST lab/order-routes/search, and then this parameter is refused.
 */
export class ListOrderRoutesQueryDto {
  @IsOptional() @IsIn(ORDER_ROUTE_VIEWS)
  view?: (typeof ORDER_ROUTE_VIEWS)[number];

  /** Deprecated: finds incoming orders by the patient's Health ID (P2: never by date of birth). Use the POST. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(64)
  healthId?: string;
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
