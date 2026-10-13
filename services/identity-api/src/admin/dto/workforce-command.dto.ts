import { Transform, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEmail, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length,
  MaxLength, MinLength,
} from 'class-validator';

/**
 * Launch D14 workforce provisioning (0087). Granting is limited to the clinical
 * roles of the launch scope; lab and pharmacist are withheld with their modules
 * (D17) but can still be revoked.
 */
export const WORKFORCE_GRANTABLE_ROLES = ['doctor', 'clinician', 'nurse'] as const;
export const WORKFORCE_REVOCABLE_ROLES = ['doctor', 'clinician', 'nurse', 'lab', 'pharmacist'] as const;

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

export class WorkforceAttachCommandDto {
  @IsUUID('all')
  facilityId!: string;

  /** An existing staff identity, or `email` and `fullName` for a new one. */
  @IsOptional() @IsUUID('all')
  accountId?: string;

  @IsOptional() @Transform(trim) @IsEmail() @MaxLength(254)
  email?: string;

  @IsOptional() @Transform(trim) @IsString() @Length(2, 200)
  fullName?: string;

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

export class WorkforceAttestationCommandDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ArrayUnique() @IsIn(WORKFORCE_GRANTABLE_ROLES, { each: true })
  attestedRoles!: string[];

  /** The licence or registration number that was reviewed. */
  @Transform(trim) @IsString() @Length(3, 100)
  credentialReference!: string;

  @Transform(trim) @IsString() @Length(2, 200)
  issuingAuthority!: string;

  /** Documented manual review only, until the verification source is decided. */
  @IsIn(['manual_review'])
  verificationMethod!: 'manual_review';

  /** Where the reviewed evidence is kept (a ticket or document reference); never the document itself. */
  @Transform(trim) @IsString() @Length(8, 500)
  evidenceReference!: string;

  /** When the attestation lapses: at most three years ahead, and never after the licence expires. */
  @IsISO8601({ strict: true, strictSeparator: true })
  validUntil!: string;

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

export class WorkforceRoleCommandDto {
  /** The facility the membership belongs to; a membership at another facility is refused. */
  @IsUUID('all')
  facilityId!: string;

  @IsIn(WORKFORCE_REVOCABLE_ROLES)
  roleCode!: string;

  @IsIn(['grant', 'revoke'])
  action!: 'grant' | 'revoke';

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

export class WorkforceEndMembershipCommandDto {
  @IsUUID('all')
  facilityId!: string;

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}
