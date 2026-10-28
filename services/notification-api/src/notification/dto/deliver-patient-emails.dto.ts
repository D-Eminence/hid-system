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

/**
 * A masked contact as Identity builds it for the notice (contactChangeHint,
 * 0094), from safe characters only whatever the address's spelling: an
 * email's first character when it is a letter or digit (else none), "•••@"
 * and its domain in ASCII (punycode) with any character but a letter, digit,
 * "." or "-" shown as "•"; or a phone's first four characters, "•••••" and
 * its last three digits. Never a full address or number, never markup.
 */
export const MASKED_CONTACT = /^(?:[A-Za-z0-9]?•••@[A-Za-z0-9.•-]{1,253}|\+[0-9]{1,3}•••••[0-9]{3})$/u;

/**
 * The code that confirms a new email address (0094), to the new address. The
 * address is not yet proved to be the patient's, so the email names neither
 * the patient nor their Health ID: no such field is accepted.
 */
export class DeliverEmailChangeCodeDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsString() @Matches(/^\d{6}$/) code!: string;
  @IsInt() @Min(1) @Max(60) expiresInMinutes!: number;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}

/** "Your Health ID email / phone number was changed" (0094), with the new contact masked. */
export class DeliverContactChangedDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsIn(['email', 'phone']) kind!: 'email' | 'phone';
  @IsString() @MaxLength(270) @Matches(MASKED_CONTACT) newContactHint!: string;
  @IsOptional() @IsString() @Matches(PERSON_NAME) firstName?: string;
  @IsOptional() @IsString() @Matches(HEALTH_ID) healthId?: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}
