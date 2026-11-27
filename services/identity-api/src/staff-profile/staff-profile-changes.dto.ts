import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * POST /identity/me/password (SX-6). Both fields are checked here only for
 * their type and the 256-character bound (400 VALIDATION_FAILED); a new
 * password under 12 characters is the route's own 400 PASSWORD_TOO_SHORT,
 * answered after the current password is checked. Neither value is ever
 * logged, audited, hashed into a request digest or stored as given.
 */
export class ChangeOwnPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  currentPassword!: string;

  @IsString()
  @MaxLength(256)
  newPassword!: string;
}

/**
 * POST /identity/me/staff-profile (SX-6): the name (checked by the route
 * against the invitee-name rule, 400 STAFF_NAME_INVALID) and the profile
 * version SX-5 answered.
 */
export class ChangeOwnNameDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
