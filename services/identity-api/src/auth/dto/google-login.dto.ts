import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class GoogleLoginDto {
  // This is a short-lived Google ID token. It is verified only on the server,
  // is never decoded for account matching in the browser, and is never logged.
  @IsString()
  @MinLength(32)
  @MaxLength(12_000)
  idToken!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;

  @IsIn(['patient-login', 'staff-login'])
  turnstileAction!: 'patient-login' | 'staff-login';

  @IsOptional()
  @IsIn(['sign_in', 'enroll'])
  intent?: 'sign_in' | 'enroll';
}

export class GoogleLinkDto extends GoogleLoginDto {
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  principal!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(256)
  password!: string;
}
