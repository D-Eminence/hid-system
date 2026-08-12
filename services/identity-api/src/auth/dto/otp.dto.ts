import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { TurnstileAction } from '../turnstile.service';

export const RECOVERY_OTP_PURPOSES = [
  'PASSWORD_RESET', 'LEGACY_ACCOUNT_RECOVERY', 'LEGACY_SESSION_FALLBACK',
] as const;
export type RecoveryOtpPurpose = typeof RECOVERY_OTP_PURPOSES[number];

export const RECOVERY_TURNSTILE_ACTIONS = [
  'patient-reset-start', 'staff-reset', 'admin-reset', 'legacy-recovery',
] as const satisfies readonly TurnstileAction[];

export class StartOtpDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Matches(/^(?:[^\s@]+@[^\s@]+\.[^\s@]+|HID-[A-HJ-NP-Z2-9]{6,32})$/i)
  @MaxLength(254)
  identifier!: string;

  @IsIn(RECOVERY_OTP_PURPOSES)
  purpose!: RecoveryOtpPurpose;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;

  @IsIn(RECOVERY_TURNSTILE_ACTIONS)
  turnstileAction!: typeof RECOVERY_TURNSTILE_ACTIONS[number];
}

export class VerifyOtpDto {
  @IsUUID()
  challengeId!: string;

  @IsIn(RECOVERY_OTP_PURPOSES)
  purpose!: RecoveryOtpPurpose;

  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class CompleteOtpDto {
  @IsUUID()
  challengeId!: string;

  @IsIn(RECOVERY_OTP_PURPOSES)
  purpose!: RecoveryOtpPurpose;

  @IsString()
  @MinLength(32)
  @MaxLength(256)
  verificationToken!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(256)
  newPassword!: string;
}
