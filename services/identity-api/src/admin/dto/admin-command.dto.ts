import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsString, Length, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class FacilityStatusCommandDto {
  @IsIn(['verified', 'rejected', 'suspended'])
  status!: 'verified' | 'rejected' | 'suspended';

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/**
 * The phone an emergency-contact alert gives for the facility. Null clears it;
 * the alert then gives Health ID support instead. The service normalizes a
 * national `0…` number or an E.164 one.
 */
export class FacilityAlertPhoneCommandDto {
  @ValidateIf((_input: unknown, value: unknown) => value !== null) @IsString() @MaxLength(32)
  phone!: string | null;

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

/**
 * Support's removal of an emergency contact who asked to stop receiving alerts.
 * The destination is normalized and keyed in the service and is never stored,
 * logged or audited.
 */
export class EmergencyContactOptOutCommandDto {
  @IsIn(['email', 'sms'])
  channel!: 'email' | 'sms';

  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(5, 254)
  destination!: string;

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
  @IsBoolean()
  enabled!: boolean;
  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}
