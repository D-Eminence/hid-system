import { Transform, Type } from 'class-transformer';
import { IsDefined, IsIn, IsInt, IsOptional, IsString, Length, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export const ORDER_ROUTE_VIEWS = ['incoming', 'recent'] as const;

/** GET pharmacy/order-routes (SPEC-FINAL §10.2). */
export class ListOrderRoutesQueryDto {
  @IsOptional() @IsIn(ORDER_ROUTE_VIEWS)
  view?: (typeof ORDER_ROUTE_VIEWS)[number];

  /** Finds incoming prescriptions by the patient's Health ID only (P2: never by date of birth). */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(64)
  healthId?: string;
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
}

export const DECLINE_REASONS = ['test_not_offered', 'medicine_unavailable', 'cannot_meet_priority', 'patient_not_seen',
  'other'] as const;

export class DeclineOrderRouteDto {
  @IsInt() @Min(1)
  expectedVersion!: number;

  @IsIn(DECLINE_REASONS)
  reason!: (typeof DECLINE_REASONS)[number];
}
