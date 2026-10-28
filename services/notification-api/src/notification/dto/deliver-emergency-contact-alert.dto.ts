import { IsDateString, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** A person's name as an email or alert may show it: letters, marks, apostrophes, spaces, dots and hyphens. */
export const PERSON_NAME = /^[\p{L}\p{M}][\p{L}\p{M}' .-]{0,119}$/u;

/**
 * The emergency-access alert to a verified contact. The message is rendered
 * from a fixed template; callers cannot supply free text, a reason, clinical
 * data, a full Health ID or a NIN. Only the last four characters of the
 * Health ID are accepted, so a contact cannot start a sign-in or a recovery
 * with what the alert says.
 */
export class DeliverEmergencyContactAlertDto {
  @IsIn(['email', 'sms']) channel!: 'email' | 'sms';
  @IsString() @MaxLength(320) recipient!: string;
  @IsString() @Matches(PERSON_NAME) patientFullName!: string;
  @IsString() @Matches(/^[A-HJ-NP-Z2-9]{4}$/) patientHidSuffix!: string;
  @IsOptional() @IsString() @Matches(PERSON_NAME) clinicianName?: string | null;
  @IsOptional() @IsString() @Matches(/^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}' .,&()/-]{0,119}$/u) facilityName?: string | null;
  @IsOptional() @IsString() @Matches(/^\+[1-9][0-9]{7,14}$/) facilityPhone?: string | null;
  @IsDateString({ strict: true }) occurredAt!: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}
