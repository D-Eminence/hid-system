import { IsEnum, IsIn, IsString, Matches, MaxLength } from 'class-validator';

export enum OtpPurpose {
  SIGNUP_VERIFY='SIGNUP_VERIFY', EMAIL_VERIFY='EMAIL_VERIFY', PHONE_VERIFY='PHONE_VERIFY',
  PASSWORD_RESET='PASSWORD_RESET', LOGIN_STEP_UP='LOGIN_STEP_UP', ADMIN_STEP_UP='ADMIN_STEP_UP',
  SENSITIVE_ACTION='SENSITIVE_ACTION', LEGACY_ACCOUNT_RECOVERY='LEGACY_ACCOUNT_RECOVERY',
  LEGACY_SESSION_FALLBACK='LEGACY_SESSION_FALLBACK',
}

export class DeliverOtpDto {
  @IsIn(['email','sms','whatsapp']) channel!: 'email' | 'sms' | 'whatsapp';
  @IsString() @MaxLength(320) recipient!: string;
  @IsString() @Matches(/^\d{6}$/) code!: string;
  @IsEnum(OtpPurpose) purpose!: OtpPurpose;
}

export function validateRecipient(channel: DeliverOtpDto['channel'], recipient: string): boolean {
  if (channel === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) && recipient.length <= 254;
  return /^\+[1-9]\d{7,14}$/.test(recipient);
}
