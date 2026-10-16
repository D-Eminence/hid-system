import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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
  @Matches(/^(patient_portal_enabled|provider_portal_enabled|outreach_portal_enabled|maintenance_mode|uploads_enabled|break_glass_enabled|clinician_signup_enabled|record_chat_enabled)$/)
  controlKey!: string;
  @IsBoolean()
  enabled!: boolean;
  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/** Text a patient is shown (ADR-063): at least one visible character and no control characters. */
const SHOWN_TEXT = /^(?=.*\S)[^\u0000-\u001f\u007f]+$/;

/**
 * ADR-063: whether a facility takes part in assisted registration, and the
 * location patients are shown. Values are trimmed; the facility's name is
 * its own. Version 0 (If-Match: 0) creates the first, active designation.
 */
export class AssistedRegistrationDesignationDto {
  @IsIn(['active', 'suspended'])
  status!: 'active' | 'suspended';

  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) @Matches(SHOWN_TEXT)
  addressLine?: string | null;

  @IsString() @MinLength(1) @MaxLength(120) @Matches(SHOWN_TEXT)
  town!: string;

  @IsString() @MinLength(1) @MaxLength(120) @Matches(SHOWN_TEXT)
  lga!: string;

  @IsString() @MinLength(1) @MaxLength(120) @Matches(SHOWN_TEXT)
  state!: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) @Matches(SHOWN_TEXT)
  hours?: string | null;

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}
