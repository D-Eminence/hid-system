import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const LOGIN_TURNSTILE_ACTIONS = [
  'patient-login', 'staff-login', 'admin-login', 'ehr-login', 'lab-login',
  'pharmacy-login', 'ocr-login', 'outreach-login',
] as const;

export class LoginDto {
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

  @IsOptional()
  @IsIn(LOGIN_TURNSTILE_ACTIONS)
  turnstileAction?: typeof LOGIN_TURNSTILE_ACTIONS[number];
}
