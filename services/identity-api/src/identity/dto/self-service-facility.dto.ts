import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';
import { ADMINISTRATOR_GRANTABLE_ROLES, type AdministratorGrantableRole, LICENCE_BODIES, type LicenceBody,
  VERIFICATION_METHODS, type VerificationMethod } from '../staff-licence';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const cacNumber = ({ value }: { value: unknown }) => typeof value === 'string'
  ? value.replace(/\s+/g, '').toUpperCase() : value;
const products = ['ehr', 'migrate', 'laboratory', 'pharmacy'] as const;
export const SELF_SERVICE_FACILITY_STATES = ['unreviewed', 'reviewed', 'all'] as const;
export type SelfServiceFacilityState = typeof SELF_SERVICE_FACILITY_STATES[number];

export class ListSelfServiceFacilitiesDto {
  @IsOptional() @IsIn(SELF_SERVICE_FACILITY_STATES)
  state?: SelfServiceFacilityState;
}

/**
 * The administrator's own licence as support records it (P4b, SPEC 3.5): the
 * regulator and the number, trimmed, 3-100 characters (Identity normalizes it;
 * the database checks that the body fits the role and the number's pattern).
 */
export class AdministratorLicenceInputDto {
  @IsIn(LICENCE_BODIES)
  body!: LicenceBody;

  @Transform(trim) @IsString() @MinLength(3) @MaxLength(100)
  number!: string;
}

/**
 * Support's review of a self-signed-up facility (P4 owner guard, extended by
 * P4b, SPEC 3.5): the note (8-500 characters, trimmed); the administrator's
 * own role, 'none' or a clinical role, which needs the licence (the database
 * answers 400 SELF_SERVICE_REVIEW_LICENCE_REQUIRED without it, so the DTO
 * does not require it); and how support checked.
 */
export class ReviewSelfServiceFacilityDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  note!: string;

  @IsIn(ADMINISTRATOR_GRANTABLE_ROLES)
  grantedRole!: AdministratorGrantableRole;

  @IsIn(VERIFICATION_METHODS)
  verificationMethod!: VerificationMethod;

  @IsOptionalButNotNull() @ValidateNested() @Type(() => AdministratorLicenceInputDto)
  administratorLicence?: AdministratorLicenceInputDto;
}

/** Support changes a reviewed administrator's own access (P4b, SPEC 3.7): as review, with a reason. */
export class SelfServiceAdministratorRoleDto {
  @IsIn(ADMINISTRATOR_GRANTABLE_ROLES)
  grantedRole!: AdministratorGrantableRole;

  @IsIn(VERIFICATION_METHODS)
  verificationMethod!: VerificationMethod;

  @IsOptionalButNotNull() @ValidateNested() @Type(() => AdministratorLicenceInputDto)
  administratorLicence?: AdministratorLicenceInputDto;

  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/** Support ends a reviewed facility's first 30 days early (P4b, SPEC 3.8): a reason of 8-500 characters. */
export class EndSelfServiceProbationDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/**
 * Support's reason for releasing a fraudulent self sign-up (R2): 8-500
 * characters, trimmed. allowRetry (R15, optional, default false): the
 * sign-up named the right company with the wrong email, so its email and
 * network are not refused for 7 days.
 */
export class ReleaseSelfServiceFacilityDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;

  @IsOptionalButNotNull() @IsBoolean()
  allowRetry?: boolean;
}

/**
 * Support's reason for closing an open self-service application (R3): 8-500
 * characters, trimmed. allowRetry (R15, optional, default false): the
 * applicant's own mistake (a mistyped email, say), so its email and network
 * may start again at once instead of being refused for 7 days.
 */
export class RejectSelfServiceApplicationDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;

  @IsOptionalButNotNull() @IsBoolean()
  allowRetry?: boolean;
}

/**
 * Support's search of open self-service applications by exact CAC number
 * (R16), in the body so the number stays out of access logs, as the
 * principal search does. Spaces removed, upper case.
 */
export class SearchSelfServiceApplicationsDto {
  @Transform(cacNumber) @IsString() @Matches(/^(RC|BN|IT)[0-9]{4,20}$/)
  cacRegistrationNumber!: string;
}

/**
 * Support's waiver of the 7-day refusal a rejection or release set for a CAC
 * number and product (R15): the CAC number (spaces removed, upper case), the
 * product and a reason of 8-500 characters, trimmed.
 */
export class WaiveSelfServiceRefusalDto {
  @Transform(cacNumber) @IsString() @Matches(/^(RC|BN|IT)[0-9]{4,20}$/)
  cacRegistrationNumber!: string;

  @IsIn(products)
  productCode!: typeof products[number];

  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}
