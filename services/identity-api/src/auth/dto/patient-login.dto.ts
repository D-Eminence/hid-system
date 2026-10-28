import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PATIENT_PRINCIPAL_PATTERN } from '../patient-principal';
import { LOGIN_TURNSTILE_ACTIONS } from './login.dto';

/**
 * Patient sign-in. The field keeps its wire name `email` but takes an email,
 * the issued Health ID or the phone number on the account (owner decision of
 * 2026-10-28): "+" and 7-15 digits, or a Nigerian local number starting 0.
 */
export class PatientLoginDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string'
    ? (/^hid-/i.test(value.trim()) ? value.trim().toUpperCase() : value.trim()) : value)
  @Matches(PATIENT_PRINCIPAL_PATTERN)
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

  @IsOptional()
  @IsIn(LOGIN_TURNSTILE_ACTIONS)
  turnstileAction?: typeof LOGIN_TURNSTILE_ACTIONS[number];
}
