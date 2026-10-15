import { Transform, Type } from 'class-transformer';
import { Equals, IsEmail, IsIn, IsISO8601, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength,
  MinLength, ValidateNested } from 'class-validator';

/**
 * Clinician self sign-up (ADR-064). The service and the database check again
 * what the DTOs check here; the regulator must pair with the profession (a
 * mismatch is 400 CLINICIAN_APPLICATION_INVALID from the service), and the
 * password length is the service's 400 PASSWORD_INVALID.
 */
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const email = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value;
const singleSpaced = ({ value }: { value: unknown }) => typeof value === 'string'
  ? value.trim().replace(/\s+/g, ' ') : value;
const licence = ({ value }: { value: unknown }) => typeof value === 'string'
  ? value.trim().replace(/\s+/g, ' ').toUpperCase() : value;

export const CLINICIAN_PROFESSIONS = ['doctor', 'nurse'] as const;
export const CLINICIAN_REGULATORS = ['MDCN', 'NMCN'] as const;
export type ClinicianProfession = typeof CLINICIAN_PROFESSIONS[number];
export type ClinicianRegulator = typeof CLINICIAN_REGULATORS[number];
/** The regulator each profession is licensed by. */
export const CLINICIAN_REGULATOR_OF: Readonly<Record<ClinicianProfession, ClinicianRegulator>> =
  Object.freeze({ doctor: 'MDCN', nurse: 'NMCN' });

/** P1: the sign-up email code. */
export class ClinicianApplicationEmailCodeDto {
  @Transform(email) @IsEmail() @MaxLength(254)
  email!: string;

  @IsIn(['clinician-application'])
  turnstileAction!: 'clinician-application';

  @IsOptional() @IsString() @MaxLength(2048)
  turnstileToken?: string;
}

/** P10: the status page's email code. */
export class ClinicianApplicationStatusEmailCodeDto {
  @Transform(email) @IsEmail() @MaxLength(254)
  email!: string;

  @IsIn(['clinician-application-status'])
  turnstileAction!: 'clinician-application-status';

  @IsOptional() @IsString() @MaxLength(2048)
  turnstileToken?: string;
}

/** P2 and P11. */
export class VerifyClinicianApplicationCodeDto {
  @IsUUID('4')
  challengeId!: string;

  @Transform(email) @IsEmail() @MaxLength(254)
  email!: string;

  @Transform(trim) @Matches(/^[0-9]{6}$/)
  code!: string;
}

/** P3. */
export class ClinicianFacilitySearchDto {
  @Transform(singleSpaced) @IsString() @MinLength(3) @MaxLength(80)
  query!: string;
}

export class ClinicianApplicationDeclarationsDto {
  @Equals(true)
  accurate!: true;

  @Equals(true)
  verificationConsent!: true;
}

/** The licence and facility of an application (P14), and of a sign-up with its account fields (P4). */
export class ClinicianApplicationDetailsDto {
  @IsIn(CLINICIAN_PROFESSIONS)
  profession!: ClinicianProfession;

  @IsIn(CLINICIAN_REGULATORS)
  regulator!: ClinicianRegulator;

  @Transform(licence) @IsString() @Matches(/^[A-Z0-9][A-Z0-9/. -]{1,98}[A-Z0-9]$/)
  licenceNumber!: string;

  @Matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/) @IsISO8601({ strict: true, strictSeparator: true })
  licenceValidUntil!: string;

  @IsUUID()
  facilityId!: string;

  @IsObject() @ValidateNested() @Type(() => ClinicianApplicationDeclarationsDto)
  declarations!: ClinicianApplicationDeclarationsDto;
}

/** P4. */
export class SubmitClinicianApplicationDto extends ClinicianApplicationDetailsDto {
  @Transform(email) @IsEmail() @MaxLength(254)
  email!: string;

  @Transform(singleSpaced) @IsString() @MinLength(2) @MaxLength(200) @Matches(/^[^\p{Cc}]+$/u)
  fullName!: string;

  // The length is the service's: 400 PASSWORD_INVALID, as at provider activation.
  @IsString()
  password!: string;
}

/** P6. */
export class ClinicianAuthenticatorStartDto {
  @Transform(trim) @Matches(/^[0-9]{6}$/)
  emailCode!: string;
}

/** P7. */
export class ClinicianAuthenticatorCodeDto {
  @Transform(trim) @Matches(/^[0-9]{6}$/)
  code!: string;
}

/** P8: exactly one of an authenticator code or a recovery code (the service answers 400 MFA_CODE_REQUIRED). */
export class ClinicianAuthenticatorVerifyDto {
  @IsOptional() @Transform(trim) @Matches(/^[0-9]{6}$/)
  code?: string;

  @IsOptional() @Transform(trim) @IsString() @MinLength(10) @MaxLength(16)
  recoveryCode?: string;
}
