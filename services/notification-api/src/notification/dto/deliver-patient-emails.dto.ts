import { IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PERSON_NAME } from './deliver-emergency-contact-alert.dto';

/** A Health ID as Identity issues it. */
export const HEALTH_ID = /^HID-[A-HJ-NP-Z2-9]{6,32}$/;

/**
 * The patient emails (owner decision of 2026-10-28, hid-1.0's design): fixed
 * fields only, email only. Unknown fields are refused by the global pipe, so
 * no free text, link, password or NIN can be sent; the first name is the
 * alert's PERSON_NAME, and the message is rendered by this service.
 */

/** "Your Health ID is ready", at activation. */
export class DeliverPatientWelcomeDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsOptional() @IsString() @Matches(PERSON_NAME) firstName?: string;
  @IsString() @Matches(HEALTH_ID) healthId!: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}

/** A patient's password reset code, naming them and their Health ID. */
export class DeliverPasswordResetCodeDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsString() @Matches(/^\d{6}$/) code!: string;
  @IsOptional() @IsString() @Matches(PERSON_NAME) firstName?: string;
  @IsString() @Matches(HEALTH_ID) healthId!: string;
  @IsInt() @Min(1) @Max(60) expiresInMinutes!: number;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}

/** "Your Health ID password was updated", after a completed reset; the Health ID only for a patient. */
export class DeliverPasswordUpdatedDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsOptional() @IsString() @Matches(PERSON_NAME) firstName?: string;
  @IsOptional() @IsString() @Matches(HEALTH_ID) healthId?: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}
