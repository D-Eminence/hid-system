import { Transform } from 'class-transformer';
import { Equals, IsIn, IsOptional, IsString, MaxLength, MinLength, registerDecorator,
  type ValidationArguments } from 'class-validator';
import { LICENCE_BODIES, type LicenceBody, STAFF_ROLES, type StaffRole, staffRoleLicenceBody, VERIFICATION_METHODS,
  type VerificationMethod } from '../staff-licence';
import { ExpectedVersionDto, LicenceMatchesRole } from './staff-invitation.dto';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const absent = (value: unknown) => value === undefined || value === null;

/**
 * Support's licence check goes with the role (SX-4, owner decision Q129 A):
 * a licensed role needs how support checked the licence, the front desk sends
 * none. Placed on `role`, it reads `verificationMethod` of the same object.
 */
function VerificationMethodMatchesRole(): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => registerDecorator({
    name: 'verificationMethodMatchesRole', target: target.constructor, propertyName: String(propertyName),
    options: { message: 'verificationMethod is required for a licensed role and must be absent for a receptionist' },
    validator: {
      validate: (value: unknown, args: ValidationArguments) => {
        const method = (args.object as { verificationMethod?: unknown }).verificationMethod;
        if (typeof value !== 'string') return true;
        return staffRoleLicenceBody(value) === null ? absent(method)
          : typeof method === 'string' && (VERIFICATION_METHODS as readonly string[]).includes(method);
      },
    },
  });
}

/**
 * Support adds one role (SX-4): the role with its licence, the attestation,
 * a reason of 8-500 characters and, for a licensed role, how support checked
 * the licence. No password; the version is the If-Match header.
 */
export class AdminAddFacilityStaffRoleDto {
  @IsIn(STAFF_ROLES) @LicenceMatchesRole() @VerificationMethodMatchesRole()
  role!: StaffRole;

  @IsOptional() @IsIn(LICENCE_BODIES)
  licenceBody?: LicenceBody | null;

  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(100)
  licenceNumber?: string | null;

  @IsOptional() @IsIn(VERIFICATION_METHODS)
  verificationMethod?: VerificationMethod | null;

  @Equals(true)
  attested!: true;

  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/** Support removes one role (SX-4): the role and a reason; the version is the If-Match header. */
export class AdminRemoveFacilityStaffRoleDto {
  @IsIn(STAFF_ROLES)
  role!: StaffRole;

  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/**
 * The facility administrator adds one role (SX-4): as an invitation's role and
 * licence, attested, with a reason, the password and the membership's version.
 */
export class AddFacilityStaffRoleDto extends ExpectedVersionDto {
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

/** The facility administrator removes one role (SX-4): the role, a reason, the password and the version. */
export class RemoveFacilityStaffRoleDto extends ExpectedVersionDto {
  @IsIn(STAFF_ROLES)
  role!: StaffRole;

  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;

  @IsString() @MinLength(1) @MaxLength(256)
  currentPassword!: string;
}
