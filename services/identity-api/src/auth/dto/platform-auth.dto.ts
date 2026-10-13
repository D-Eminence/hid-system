import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class PlatformLoginDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(256)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;

  @IsIn(['admin-login'])
  turnstileAction!: 'admin-login';
}

/** Exactly one of a TOTP code or a one-time recovery code (checked by the service). */
export class PlatformMfaVerifyDto {
  @IsOptional()
  @Transform(trim)
  @Matches(/^[0-9]{6}$/)
  code?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(16)
  recoveryCode?: string;
}

export class TotpCodeDto {
  @Transform(trim)
  @Matches(/^[0-9]{6}$/)
  code!: string;
}

/**
 * Staff enrolment start (MFA-1): the code sent to the account's email address
 * by POST /auth/mfa/enroll/email-code. Optional only because a challenge
 * opened by provider activation already carries its proof; the service
 * refuses any other start without it (MFA_ENROLLMENT_PROOF_REQUIRED).
 */
export class StaffMfaEnrollmentStartDto {
  @IsOptional()
  @Transform(trim)
  @Matches(/^[0-9]{6}$/)
  emailCode?: string;
}
