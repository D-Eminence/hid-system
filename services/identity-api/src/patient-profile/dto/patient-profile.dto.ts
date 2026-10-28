import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/**
 * PUT identity/me/profile-details (0094). Each value is a string or null;
 * PatientProfileService trims it (blank is null) and refuses more than 120
 * characters or a control character (400 PROFILE_DETAILS_INVALID).
 */
export class SaveProfileDetailsDto {
  @IsOptional() @IsString() @MaxLength(512)
  hospitalCurrentlyUsing?: string | null;

  @IsOptional() @IsString() @MaxLength(512)
  hmoName?: string | null;

  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;
}

/**
 * PUT identity/me/photo (0094): the browser's re-encoded photo, base64.
 * inspectProfilePhoto checks it (400 PHOTO_INVALID); the route's own body
 * parser admits a body of at most PROFILE_PHOTO_BODY_LIMIT_BYTES.
 */
export class SaveProfilePhotoDto {
  @IsString() @MaxLength(32)
  mediaType!: string;

  @IsString() @MaxLength(512 * 1024)
  data!: string;
}

/**
 * POST identity/me/contact-changes (0094): an email change (a code goes to
 * the new address) or a phone change (confirmed by the password alone).
 * Channel and value are checked together by PatientContactChangeService.
 */
export class StartContactChangeDto {
  @IsIn(['email', 'phone'])
  channel!: 'email' | 'phone';

  @IsOptional() @IsString() @MaxLength(320)
  email?: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsString() @MaxLength(256)
  currentPassword!: string;
}

/** POST identity/me/contact-changes/:changeId/verify (0094). */
export class VerifyContactChangeDto {
  @IsString() @Matches(/^\d{6}$/)
  code!: string;
}
