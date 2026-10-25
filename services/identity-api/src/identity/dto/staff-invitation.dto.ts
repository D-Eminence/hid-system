import { Transform } from 'class-transformer';
import {
  Equals, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
  registerDecorator, ValidateIf, type ValidationArguments,
} from 'class-validator';
import { acceptableStaffPersonName } from '../staff-names';
import { LICENCE_BODIES, type LicenceBody, STAFF_ROLES, type StaffRole, staffRoleLicenceBody } from '../staff-licence';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const trimLower = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value;
const absent = (value: unknown) => value === undefined || value === null;

/** An invitee's full name: a person's name of 2-80 characters with no reserved word (S3). */
function IsStaffPersonName(): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => registerDecorator({
    name: 'isStaffPersonName', target: target.constructor, propertyName: String(propertyName),
    options: { message: `${String(propertyName)} must be a person's full name of 2 to 80 letters, without digits, `
      + 'punctuation or the words Health ID, HID, support, admin, administrator or ministry' },
    validator: { validate: (value: unknown) => typeof value === 'string' && acceptableStaffPersonName(value) },
  });
}

/**
 * The licence goes with the role (SPEC 4.2): a receptionist has none (both
 * fields absent); every other role has the body its regulator issues and a
 * number. Placed on `role`, it reads the licence fields of the same object.
 */
function LicenceMatchesRole(): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => registerDecorator({
    name: 'licenceMatchesRole', target: target.constructor, propertyName: String(propertyName),
    options: { message: 'licenceBody and licenceNumber must be the role\'s licence (none for a receptionist)' },
    validator: {
      validate: (value: unknown, args: ValidationArguments) => {
        const object = args.object as { licenceBody?: unknown; licenceNumber?: unknown };
        if (typeof value !== 'string') return true;
        const body = staffRoleLicenceBody(value);
        if (body === null) return absent(object.licenceBody) && absent(object.licenceNumber);
        return object.licenceBody === body && typeof object.licenceNumber === 'string';
      },
    },
  });
}

/** Exactly one of link mode (invitationId and token) and typed mode (`typed` fields), SPEC 4.7 and 4.9. */
function OneInvitationMode(typed: readonly string[]): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => registerDecorator({
    name: 'oneInvitationMode', target: target.constructor, propertyName: String(propertyName),
    options: { message: `Send either invitationId and token, or ${typed.join(' and ')}` },
    validator: {
      validate: (_value: unknown, args: ValidationArguments) => {
        const object = args.object as Record<string, unknown>;
        const link = !absent(object.invitationId) || !absent(object.token);
        const linkComplete = !absent(object.invitationId) && !absent(object.token);
        const typedAny = typed.some((field) => !absent(object[field]));
        const typedComplete = typed.every((field) => !absent(object[field]));
        return link ? linkComplete && !typedAny : typedComplete;
      },
    },
  });
}

/** The version a staff command expects, from the body (the staff side's convention, SPEC 2.2 #14). */
export class ExpectedVersionDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;
}

/**
 * Invite a member of staff (SPEC 4.4). The name is the person's own; the
 * email is lower-cased; the role is one of the five invitable roles (the
 * facility's type narrows them, which the database decides); the licence goes
 * with the role; the administrator attests and re-enters their password.
 */
export class CreateStaffInvitationDto {
  @Transform(trim) @IsString() @IsStaffPersonName()
  name!: string;

  @Transform(trimLower) @IsString() @IsEmail() @MaxLength(254)
  email!: string;

  @IsIn(STAFF_ROLES) @LicenceMatchesRole()
  role!: StaffRole;

  @IsOptional() @IsIn(LICENCE_BODIES)
  licenceBody?: LicenceBody | null;

  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(100)
  licenceNumber?: string | null;

  @Equals(true)
  attested!: true;

  @IsString() @MinLength(1) @MaxLength(256)
  currentPassword!: string;
}

/** Remove a member (SPEC 4.5): the version, a reason of 8-500 characters and the password. */
export class EndFacilityStaffDto extends ExpectedVersionDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;

  @IsString() @MinLength(1) @MaxLength(256)
  currentPassword!: string;
}

/** Change a member's role (SPEC 4.5): as an invitation's role and licence, with a reason and the password. */
export class ChangeFacilityStaffRoleDto extends ExpectedVersionDto {
  @IsIn(STAFF_ROLES) @LicenceMatchesRole()
  role!: StaffRole;

  @IsOptional() @IsIn(LICENCE_BODIES)
  licenceBody?: LicenceBody | null;

  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(100)
  licenceNumber?: string | null;

  @Equals(true)
  attested!: true;

  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;

  @IsString() @MinLength(1) @MaxLength(256)
  currentPassword!: string;
}

/** The pending administrator's own licence (SPEC 3.4); the database decides which bodies the facility allows. */
export class AdministratorLicenceDto {
  @IsIn(LICENCE_BODIES)
  licenceBody!: LicenceBody;

  @Transform(trim) @IsString() @MinLength(3) @MaxLength(100)
  licenceNumber!: string;
}

/**
 * Open an invitation (SPEC 4.7): link mode `{ invitationId, token }` or typed
 * mode `{ email, code }`, never both, with the Turnstile proof.
 */
export class OpenStaffInvitationDto {
  @IsOptional() @IsUUID('4')
  invitationId?: string;

  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/)
  token?: string;

  @IsOptional() @Transform(trimLower) @IsString() @IsEmail() @MaxLength(254)
  email?: string;

  @IsOptional() @IsString() @Matches(/^\d{6}$/)
  code?: string;

  @IsIn(['staff-invitation']) @OneInvitationMode(['email', 'code'])
  turnstileAction!: 'staff-invitation';

  @IsOptional() @IsString() @MaxLength(2048)
  turnstileToken?: string;
}

/** Set the password of a new or dormant account (SPEC 4.8): 12-256 characters. */
export class AcceptStaffInvitationDto {
  @IsString() @MinLength(12) @MaxLength(256)
  password!: string;
}

/**
 * A signed-in staff member's preview or acceptance (SPEC 4.9): link mode
 * `{ invitationId, token }` or typed mode `{ code }`, never both; the email is
 * the session's own. With neither, invitationId and token are required.
 */
export class SignedInInvitationDto {
  @ValidateIf((object: SignedInInvitationDto) => !absent(object.invitationId) || !absent(object.token) || absent(object.code))
  @IsUUID('4')
  invitationId?: string;

  @ValidateIf((object: SignedInInvitationDto) => !absent(object.token) || !absent(object.invitationId) || absent(object.code))
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/)
  token?: string;

  @ValidateIf((object: SignedInInvitationDto) => !absent(object.code))
  @IsString() @Matches(/^\d{6}$/) @OneInvitationMode(['code'])
  code?: string;
}
