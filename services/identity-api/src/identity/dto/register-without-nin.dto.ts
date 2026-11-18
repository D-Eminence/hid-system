import { Transform, type TransformFnParams } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';
import { COLLECTED_PHONE_E164, NIGERIA_STATE_CODES, toCollectedPhone } from './facility-profile.dto';
import { STATED_HEALTH_ID } from './resolve-nin.dto';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

/** 0130: why the desk registers a patient without a NIN. */
export const NO_NIN_REASONS = ['nin_service_unavailable', 'no_nin', 'not_carried', 'child', 'foreign_national'] as const;
export type NoNinReason = typeof NO_NIN_REASONS[number];

/** The phone and address come together, or (for a child only) not at all. */
const CONTACT_FIELDS = ['phone', 'addressLine', 'city', 'stateCode', 'lga'] as const;

function hasContact(body: object): boolean {
  const values = body as Partial<Record<typeof CONTACT_FIELDS[number], unknown>>;
  return CONTACT_FIELDS.some((field) => values[field] !== undefined && values[field] !== null);
}

/**
 * 0130 (ID-2, owner Q106 of 18 November 2026): POST
 * identity/registration-cases/without-nin. No NIN. The phone and address are
 * required unless the reason is `child` (the database also checks the child
 * is under 18); they are stored encrypted, as the NIN route's desk fields
 * are (0114), and never returned.
 */
export class RegisterWithoutNinDto {
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  firstName!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  lastName!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  dateOfBirth!: string;

  @IsOptional()
  @IsIn(['female', 'male', 'intersex', 'other', 'unknown'])
  gender?: string;

  @IsIn(NO_NIN_REASONS)
  noNinReason!: NoNinReason;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;

  /** E.164 ("+" and 8-15 digits) or a Nigerian local number (0 and 10 digits). Required unless the reason is child. */
  @ValidateIf((body: RegisterWithoutNinDto) => body.noNinReason !== 'child' || hasContact(body))
  @Transform(toCollectedPhone) @IsString() @Matches(COLLECTED_PHONE_E164)
  phone?: string;

  @ValidateIf((body: RegisterWithoutNinDto) => body.noNinReason !== 'child' || hasContact(body))
  @Transform(trim) @IsString() @Length(5, 300)
  addressLine?: string;

  @ValidateIf((body: RegisterWithoutNinDto) => body.noNinReason !== 'child' || hasContact(body))
  @Transform(trim) @IsString() @Length(2, 100)
  city?: string;

  @ValidateIf((body: RegisterWithoutNinDto) => body.noNinReason !== 'child' || hasContact(body))
  @IsIn(NIGERIA_STATE_CODES)
  stateCode?: typeof NIGERIA_STATE_CODES[number];

  @ValidateIf((body: RegisterWithoutNinDto) => body.noNinReason !== 'child' || hasContact(body))
  @Transform(trim) @IsString() @Length(2, 100)
  lga?: string;

  /** Does the patient say they already have a Health ID? */
  @IsBoolean()
  hasExistingHealthId!: boolean;

  /** That Health ID, exactly when hasExistingHealthId is true (it only sends the case for review). */
  @ValidateIf((body: RegisterWithoutNinDto) => body.hasExistingHealthId === true
    || (body.existingHealthId !== undefined && body.existingHealthId !== null))
  @Transform(({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString()
  @Matches(STATED_HEALTH_ID)
  existingHealthId?: string | null;
}
