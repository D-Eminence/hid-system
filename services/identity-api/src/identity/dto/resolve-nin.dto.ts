import { Transform, type TransformFnParams } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, Length, Matches, registerDecorator,
  type ValidationArguments } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';
import { COLLECTED_PHONE_E164, NIGERIA_STATE_CODES, toCollectedPhone } from './facility-profile.dto';

// Legacy governed-registration input. QoreID self-verification instead derives
// its provider name and DOB claims from the authenticated canonical patient.

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
const normalizeNin = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.replace(/[\s-]+/g, '') : value;

/** A Health ID as PatientLookupDto reads it ("HID-" and 6-32 letters and digits, no I, O, 0 or 1). */
export const STATED_HEALTH_ID = /^HID-[A-HJ-NP-Z2-9]{6,32}$/;

/** existingHealthId is a Health ID exactly when hasExistingHealthId is true, and null or absent otherwise. */
function HealthIdExactlyWhenStated() {
  return (target: object, propertyName: string) => registerDecorator({
    name: 'healthIdExactlyWhenStated', target: target.constructor, propertyName,
    options: { message: 'existingHealthId is required when hasExistingHealthId is true, and must be empty when it is false' },
    validator: {
      validate(value: unknown, args: ValidationArguments) {
        const stated = (args.object as { hasExistingHealthId?: unknown }).hasExistingHealthId;
        if (stated === true) return typeof value === 'string' && STATED_HEALTH_ID.test(value);
        return value === undefined || value === null;
      },
    },
  });
}

export class ResolveNinDto {
  @Transform(normalizeNin)
  @IsString()
  @Matches(/^\d{11}$/)
  nin!: string;

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

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;

  // 0122 (owner: "all fields required"; D10): the patient's phone and address
  // as the desk records them. Facility-held and unverified, stored encrypted,
  // never used for sign-in or recovery.

  /** E.164 ("+" and 8-15 digits) or a Nigerian local number (0 and 10 digits). */
  @Transform(toCollectedPhone) @IsString() @Matches(COLLECTED_PHONE_E164)
  phone!: string;

  @Transform(trim) @IsString() @Length(5, 300)
  addressLine!: string;

  @Transform(trim) @IsString() @Length(2, 100)
  city!: string;

  @IsIn(NIGERIA_STATE_CODES)
  stateCode!: typeof NIGERIA_STATE_CODES[number];

  /** Local government area, free text (D6). */
  @Transform(trim) @IsString() @Length(2, 100)
  lga!: string;

  /** D13: does the patient say they already have a Health ID? */
  @IsBoolean()
  hasExistingHealthId!: boolean;

  /** D13: that Health ID, exactly when hasExistingHealthId is true. */
  @Transform(({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @HealthIdExactlyWhenStated()
  existingHealthId?: string | null;
}
