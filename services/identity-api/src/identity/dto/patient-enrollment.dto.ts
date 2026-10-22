import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class StartPatientEnrollmentDto {
  @IsString() @Matches(/^\d{11}$/) nin!: string;
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
