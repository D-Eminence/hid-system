import { IsDateString, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { SHARE_DURATIONS, SHARE_LEVELS, type ShareDuration, type ShareLevel } from '../../providers/sharing-emails';

/**
 * The sharing emails (B4, 0095): fixed fields only, email only. Unknown
 * fields are refused by the global pipe, so no patient name, Health ID,
 * invitee name or free text can be sent.
 */

/** An invitation's reference: 8 characters of A-Z and 2-9. */
export const SHARE_INVITATION_REFERENCE = /^[A-Z2-9]{8}$/;

/** E1: a patient's invitation to share, to the invited address. */
export class DeliverPatientShareInvitationDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsString() @Matches(SHARE_INVITATION_REFERENCE) reference!: string;
  @IsIn(SHARE_LEVELS) level!: ShareLevel;
  @IsIn(SHARE_DURATIONS) duration!: ShareDuration;
  @IsDateString({ strict: true }) expiresAt!: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}

/** E2: to the clinician a patient shared with; the facility's name only (the emergency alert's rule). */
export class DeliverShareReceivedDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsOptional() @IsString() @MaxLength(120) @Matches(/^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}' .,&()/-]{0,119}$/u)
    facilityName?: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}

/** E3: "Your Health ID records were opened", to the patient's verified email; the time only. */
export class DeliverRecordAccessAlertDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsDateString({ strict: true }) occurredAt!: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}
