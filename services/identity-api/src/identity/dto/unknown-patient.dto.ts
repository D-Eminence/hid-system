import { Transform, Type, type TransformFnParams } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';
import { COLLECTED_PHONE_E164, NIGERIA_STATE_CODES, toCollectedPhone } from './facility-profile.dto';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

/** 0146 (ID-7): why a person cannot say who they are. */
export const UNKNOWN_PATIENT_REASONS = ['unconscious', 'confused', 'unaccompanied_child', 'cannot_communicate',
  'other'] as const;
export type UnknownPatientReason = typeof UNKNOWN_PATIENT_REASONS[number];

export const PATIENT_GENDERS = ['female', 'male', 'intersex', 'other', 'unknown'] as const;

/** POST identity/unknown-patients: make an unknown patient record. */
export class CreateUnknownPatientDto {
  @IsIn(PATIENT_GENDERS)
  gender!: typeof PATIENT_GENDERS[number];

  @IsOptional() @IsInt() @Min(0) @Max(120)
  estimatedAgeYears?: number;

  @IsIn(UNKNOWN_PATIENT_REASONS)
  unknownReason!: UnknownPatientReason;

  /** Encrypted; never in a list, a log or an audit row. */
  @IsOptional() @Transform(trim) @IsString() @Length(1, 1000)
  arrivalNote?: string;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;
}

/** GET identity/unknown-patients. */
export class ListUnknownPatientsDto {
  @IsOptional() @IsIn(['open', 'all'])
  status?: 'open' | 'all';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{16,200}$/)
  cursor?: string;
}

/** The phone and address come together, or (for a child only) not at all, as ID-2's. */
const CONTACT_FIELDS = ['phone', 'addressLine', 'city', 'stateCode', 'lga'] as const;
function hasContact(body: object): boolean {
  const values = body as Partial<Record<typeof CONTACT_FIELDS[number], unknown>>;
  return CONTACT_FIELDS.some((field) => values[field] !== undefined && values[field] !== null);
}

/**
 * POST identity/unknown-patients/:patientId/identify: ID-2's fields and the
 * record's version. A phone and an address are required unless the person is
 * a child (under 18 on today's Lagos date), which the database decides.
 */
export class IdentifyUnknownPatientDto {
  @Transform(trim) @IsString() @Length(1, 100)
  firstName!: string;

  @Transform(trim) @IsString() @Length(1, 100)
  lastName!: string;

  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) @IsDateString({ strict: true })
  dateOfBirth!: string;

  @IsOptional() @IsIn(PATIENT_GENDERS)
  gender?: typeof PATIENT_GENDERS[number];

  @ValidateIf((body: IdentifyUnknownPatientDto) => hasContact(body))
  @Transform(toCollectedPhone) @IsString() @Matches(COLLECTED_PHONE_E164)
  phone?: string;

  @ValidateIf((body: IdentifyUnknownPatientDto) => hasContact(body))
  @Transform(trim) @IsString() @Length(5, 300)
  addressLine?: string;

  @ValidateIf((body: IdentifyUnknownPatientDto) => hasContact(body))
  @Transform(trim) @IsString() @Length(2, 100)
  city?: string;

  @ValidateIf((body: IdentifyUnknownPatientDto) => hasContact(body))
  @IsIn(NIGERIA_STATE_CODES)
  stateCode?: typeof NIGERIA_STATE_CODES[number];

  @ValidateIf((body: IdentifyUnknownPatientDto) => hasContact(body))
  @Transform(trim) @IsString() @Length(2, 100)
  lga?: string;

  @IsInt() @Min(1)
  expectedVersion!: number;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;
}

/** POST .../confirm-separate and .../cancel: the approver's reason and the record's version. */
export class DecideUnknownPatientDto {
  @IsInt() @Min(1)
  expectedVersion!: number;

  @Transform(trim) @IsString() @Length(8, 500)
  reason!: string;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;
}
