import { Transform } from 'class-transformer';
import {
  Equals, IsEmail, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength,
} from 'class-validator';
import { OUTREACH_ORGANISER_TERMS_VERSION } from '../outreach-organiser-crypto';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
const trimLower = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value;
const compactUpper = ({ value }: { value: unknown }) => typeof value === 'string'
  ? value.replace(/\s+/g, '').toUpperCase() || undefined : value;

/** A person's or group's name: letters, digits, spaces and . , ' & ( ) - / only. */
const NAME = /^[\p{L}\p{M}0-9][\p{L}\p{M}0-9 .,'&()/-]*$/u;

/** The group details both sign-up paths collect. */
export class OutreachGroupDetailsDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120)
  @Matches(NAME, { message: 'Use letters, numbers and simple punctuation in your group name' })
  groupName!: string;

  @IsIn(['individual', 'group'])
  kind!: 'individual' | 'group';

  /** An optional CAC or IT number. It is stored as typed and not checked. */
  @IsOptional() @Transform(compactUpper) @IsString() @Matches(/^(RC|BN|IT)?[0-9]{4,20}$/, {
    message: 'Enter a CAC number like RC1234567 or BN1234567, or an IT number, or leave it empty' })
  registrationNumber?: string;

  @Transform(trim) @IsString() @MinLength(7) @MaxLength(32)
  phone!: string;
}

export class StartOutreachOrganiserSignupDto extends OutreachGroupDetailsDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120)
  @Matches(NAME, { message: 'Use letters and simple punctuation in your name' })
  organiserName!: string;

  @Transform(trimLower) @IsEmail() @MaxLength(254)
  email!: string;

  @IsIn(['outreach-organiser-signup'])
  turnstileAction!: 'outreach-organiser-signup';

  @IsOptional() @IsString() @MaxLength(2048)
  turnstileToken?: string;
}

export class VerifyOutreachOrganiserEmailDto {
  /** The reference start answered; accepted and not needed (the cookie names the sign-up). */
  @IsOptional() @IsUUID('4')
  challengeId?: string;

  @Matches(/^[0-9]{6}$/, { message: 'Enter the 6-digit code from the email' })
  code!: string;
}

/** The terms the person accepts: exactly the approved version, ticked. */
export class OutreachTermsDto {
  @Equals(OUTREACH_ORGANISER_TERMS_VERSION, { message: 'Reload the page to see the current organiser terms' })
  termsVersion!: string;

  @Equals(true, { message: 'Accept the organiser terms to continue' })
  acceptTerms!: boolean;
}

export class ActivateOutreachOrganiserDto extends OutreachTermsDto {
  @IsString() @MinLength(12) @MaxLength(256)
  password!: string;
}

/** An existing Health ID account starts an outreach group for itself (owner decision 5). */
export class StartOutreachGroupForAccountDto extends OutreachGroupDetailsDto {
  @Equals(OUTREACH_ORGANISER_TERMS_VERSION, { message: 'Reload the page to see the current organiser terms' })
  termsVersion!: string;

  @Equals(true, { message: 'Accept the organiser terms to continue' })
  acceptTerms!: boolean;
}

/** An organiser invites a helper by email. */
export class CreateOutreachInvitationDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80)
  @Matches(NAME, { message: 'Use letters and simple punctuation in the helper\'s name' })
  name!: string;

  @Transform(trimLower) @IsEmail() @MaxLength(254)
  email!: string;
}

/** The invitation link's id and token (0114 accepts by link only). */
export class OutreachInvitationProofDto {
  @IsUUID('4')
  invitationId!: string;

  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/, { message: 'The invitation link is not complete. Open it again from the email.' })
  token!: string;
}

export class AcceptOutreachInvitationDto extends OutreachInvitationProofDto {
  @IsString() @MinLength(12) @MaxLength(256)
  password!: string;

  @IsIn(['outreach-invitation'])
  turnstileAction!: 'outreach-invitation';

  @IsOptional() @IsString() @MaxLength(2048)
  turnstileToken?: string;
}

/** Signed in: the same link. */
export class SignedInOutreachInvitationDto extends OutreachInvitationProofDto {}
