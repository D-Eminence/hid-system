import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class FacilityStatusCommandDto {
  @IsIn(['verified', 'rejected', 'suspended'])
  status!: 'verified' | 'rejected' | 'suspended';

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

export class AccountStatusCommandDto {
  @IsIn(['active', 'disabled'])
  status!: 'active' | 'disabled';

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

export class PlatformRoleCommandDto {
  @Matches(/^(platform_super_admin|platform_operations_admin|identity_review_admin|facility_review_admin|security_auditor|support_admin)$/)
  roleCode!: string;

  @IsIn(['grant', 'revoke'])
  action!: 'grant' | 'revoke';

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

export class RevokeSessionsCommandDto {
  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}
