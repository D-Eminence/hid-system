import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { LOGIN_TURNSTILE_ACTIONS } from './login.dto';

/** The existing email login also accepts the issued HID for phone-only accounts. */
export class PatientLoginDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string'
    ? (/^hid-/i.test(value.trim()) ? value.trim().toUpperCase() : value.trim()) : value)
  @Matches(/^(?:[^\s@]+@[^\s@]+\.[^\s@]+|HID-[A-HJ-NP-Z2-9]{6,32})$/)
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
