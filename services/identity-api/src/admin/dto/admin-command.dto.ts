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


export class PlatformControlCommandDto {
  @Matches(/^(patient_portal_enabled|provider_portal_enabled|outreach_portal_enabled|maintenance_mode|uploads_enabled|break_glass_enabled)$/)
  controlKey!: string;
  enabled!: boolean;
  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}
