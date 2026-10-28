import { Equals, IsEmail, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class StartPatientEnrollmentDto {
  @IsString() @Matches(/^\d{11}$/) nin!: string;
  @IsIn(['patient-enrollment']) turnstileAction!: 'patient-enrollment';
  // Optional here so a missing token answers 400 TURNSTILE_REQUIRED (TS-8).
  @IsOptional() @IsString() @MaxLength(2048) turnstileToken?: string;
}

/** The genders the enrollment profile accepts (identity.patients.gender has no CHECK). */
export const SIGNUP_GENDERS = ['male', 'female', 'intersex', 'other', 'unknown'] as const;
export type SignupGender = typeof SIGNUP_GENDERS[number];

/** Sign-up without a NIN (0092): the declared profile; the email is verified next. */
export class SignupPatientEnrollmentDto {
  @IsString() @MinLength(1) @MaxLength(80) @Matches(/^[^\x00-\x1f\x7f]*\S[^\x00-\x1f\x7f]*$/)
  firstName!: string;
  @IsString() @MinLength(1) @MaxLength(80) @Matches(/^[^\x00-\x1f\x7f]*\S[^\x00-\x1f\x7f]*$/)
  lastName!: string;
  @IsString() @MaxLength(254) @IsEmail() email!: string;
  // E.164 of any country (+ and 7-15 digits) or a Nigerian local number
  // starting 0 (owner decision of 2026-10-28); spaces, dots, dashes and
  // brackets are ignored. The service checks the digits after normalizing.
  @IsString() @MaxLength(32) @Matches(/^[\s().-]*(?:\+[\s().-]*[1-9]|0)[\d\s().-]{5,28}$/) phone!: string;
  @IsIn(SIGNUP_GENDERS) gender!: SignupGender;
  @IsOptional() @IsString() @MaxLength(120) @Matches(/^[^\x00-\x1f\x7f]*$/)
  hospitalCurrentlyUsing?: string;
  @Equals(true) termsAccepted!: true;
  @IsIn(['patient-enrollment']) turnstileAction!: 'patient-enrollment';
  // Optional here so a missing token answers 400 TURNSTILE_REQUIRED (TS-8).
  @IsOptional() @IsString() @MaxLength(2048) turnstileToken?: string;
}

export class PatientEnrollmentContactDto {
  @IsIn(['phone', 'email']) channel!: 'phone' | 'email';
  @IsString() @MinLength(3) @MaxLength(254) contact!: string;
}

export class VerifyPatientEnrollmentContactDto {
  @IsUUID('4') challengeId!: string;
  @IsString() @Matches(/^\d{6}$/) code!: string;
}

export class ActivatePatientEnrollmentDto {
  @IsString() @MinLength(12) @MaxLength(256) password!: string;
}
