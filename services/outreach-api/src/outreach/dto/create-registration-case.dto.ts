import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
  ValidateNested } from 'class-validator';

/** A phone as E.164: + and 7-15 digits. */
export const E164_PHONE = /^\+[1-9]\d{6,14}$/;

/**
 * A phone as E.164 (plan PR-4, field critique): a Nigerian local number (0 and
 * 10 digits) is read as +234, a trunk 0 typed after +234 is dropped, and
 * spaces, dots, dashes and brackets are ignored. Anything else is left as
 * typed, so the E.164 check refuses it with a plain message.
 */
export function normalizeOutreachPhone(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const compact = raw.trim().replace(/[\s().-]/g, '');
  if (compact === '') return undefined;
  if (/^0\d{10}$/.test(compact)) return `+234${compact.slice(1)}`;
  if (/^234\d{10}$/.test(compact)) return `+${compact}`;
  const trunk = /^\+2340(\d{10})$/.exec(compact);
  if (trunk) return `+234${trunk[1]}`;
  return E164_PHONE.test(compact) ? compact : raw.trim();
}

/** The languages the registration notice is read in. */
export const CONSENT_LANGUAGES = ['en', 'yo', 'ha', 'ig', 'pcm'] as const;
/** How the person agreed: read aloud to them, ticked by them, or by their parent or guardian. */
export const CONSENT_METHODS = ['verbal_read_aloud', 'self_ticked', 'guardian'] as const;

/**
 * The person's agreement to be registered (plan PR-1/PR-4): which notice they
 * were given, in which language and how they agreed. Required at an outreach
 * group's facility; the database refuses a registration there without it.
 * A guardian's name is required for anyone under 18.
 */
export class RegistrationConsentDto {
  @IsString() @Matches(/^[a-z0-9][a-z0-9.-]{2,63}$/, { message: 'Reload the page to see the current registration notice' })
  textVersion!: string;

  @IsIn(CONSENT_LANGUAGES, { message: 'Choose the language the notice was given in' })
  language!: typeof CONSENT_LANGUAGES[number];

  @IsIn(CONSENT_METHODS, { message: 'Choose how the person agreed' })
  method!: typeof CONSENT_METHODS[number];

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') || undefined : value)
  @IsString() @MinLength(2) @MaxLength(120)
  guardianName?: string;
}

export class CreateRegistrationCaseDto {
  @IsUUID('4')
  localCommandId!: string;

  @IsOptional()
  @IsUUID('4')
  campaignId?: string;

  @Matches(/^tmp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  temporaryPatientId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @IsIn(['female', 'male', 'other', 'unknown'])
  sex!: 'female' | 'male' | 'other' | 'unknown';

  @IsInt()
  @Min(0)
  @Max(130)
  ageYears!: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizeOutreachPhone(value))
  @IsString()
  @Matches(E164_PHONE, { message: 'Enter the phone number like 08012345678, or with its country code, like +234 801 234 5678' })
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  operationalNotes?: string;

  /**
   * The person's area, town or LGA (0118), optional: trimmed, inner spaces
   * collapsed, an empty value treated as not given. Set only at registration.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') || undefined : value)
  @IsString()
  @MaxLength(100)
  area?: string;

  /** Required at an outreach group's facility (the service and the database check). */
  @IsOptional()
  @ValidateNested()
  @Type(() => RegistrationConsentDto)
  consent?: RegistrationConsentDto;
}
