import { IsDateString, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Minimum-necessary emergency-contact alert. The message is rendered from a
 * fixed template; callers cannot supply free text, clinical data, HID, or NIN.
 */
export class DeliverEmergencyContactAlertDto {
  @IsIn(['email', 'sms']) channel!: 'email' | 'sms';
  @IsString() @MaxLength(320) recipient!: string;
  @IsString() @Matches(/^[\p{L}\p{M}][\p{L}\p{M}' .-]{0,59}$/u) patientFirstName!: string;
  @IsOptional() @IsString() @Matches(/^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}' .,&()/-]{0,119}$/u) facilityName?: string | null;
  @IsDateString({ strict: true }) occurredAt!: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}
