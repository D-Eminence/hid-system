import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class StartPatientEnrollmentDto {
  @IsString() @Matches(/^\d{11}$/) nin!: string;
  @IsIn(['patient-enrollment']) turnstileAction!: 'patient-enrollment';
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

export const ENROLLMENT_PROFILE_GENDERS = ['female', 'male', 'intersex', 'other', 'unknown'] as const;

export class ActivatePatientEnrollmentDto {
  @IsString() @MinLength(12) @MaxLength(256) password!: string;
  /**
   * Entered by the patient only when the NIN record has none (ADR-061): the
   * progress answer's requiredProfileFields says so. The service checks that it
   * is a real date from 1900-01-01 to today and refuses one the record gives.
   */
  @IsOptional() @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) dateOfBirth?: string;
  /** As dateOfBirth: only when the NIN record has no gender. */
  @IsOptional() @IsIn(ENROLLMENT_PROFILE_GENDERS) gender?: typeof ENROLLMENT_PROFILE_GENDERS[number];
}
