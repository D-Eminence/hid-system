import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const LOGIN_TURNSTILE_ACTIONS = [
  'patient-login', 'staff-login', 'admin-login', 'ehr-login', 'lab-login',
  'pharmacy-login', 'ocr-login', 'outreach-login',
] as const;

/**
 * The actions the workforce password step (POST /auth/login) accepts (TS-6):
 * each product's sign-in page. patient-login and admin-login belong to their
 * own routes, so a token from those pages never reaches the staff step.
 */
export const WORKFORCE_LOGIN_ACTIONS = [
  'staff-login', 'ehr-login', 'lab-login', 'pharmacy-login', 'ocr-login', 'outreach-login',
] as const satisfies readonly typeof LOGIN_TURNSTILE_ACTIONS[number][];

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
