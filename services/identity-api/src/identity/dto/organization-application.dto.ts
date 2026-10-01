import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const products = ['ehr', 'migrate', 'laboratory', 'pharmacy'] as const;
const statuses = ['pending_verification', 'ready_for_review', 'approved', 'rejected'] as const;

export class SubmitOrganizationApplicationDto {
  @IsIn(products)
  productCode!: typeof products[number];

  @IsIn(['clinic', 'hospital', 'laboratory', 'pharmacy', 'other'])
  organizationType!: 'clinic' | 'hospital' | 'laboratory' | 'pharmacy' | 'other';

  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : value)
  @Matches(/^(RC|BN|IT)[0-9]{4,20}$/)
  cacRegistrationNumber!: string;

  @Transform(trim) @IsString() @MinLength(2) @MaxLength(200)
  administratorName!: string;

  @Transform(trim) @IsEmail() @MaxLength(254)
  administratorEmail!: string;

  @IsIn(['organization-application'])
  turnstileAction!: 'organization-application';

  @IsString() @MaxLength(2048)
  turnstileToken!: string;
}

export class StartOrganizationProfileCompletionDto {
  @IsIn(products)
  productCode!: typeof products[number];

  @Transform(({ value }: { value: unknown }) => typeof value === 'string'
    ? value.replace(/\s+/g, '').toUpperCase() : value)
  @Matches(/^(RC|BN|IT)[0-9]{4,20}$/)
  cacRegistrationNumber!: string;

  @Transform(trim) @IsEmail() @MaxLength(254)
  administratorEmail!: string;

  @IsIn(['organization-completion'])
  turnstileAction!: 'organization-completion';

  @IsString() @MaxLength(2048)
  turnstileToken!: string;
}

export class VerifyOrganizationProfileCompletionDto {
  @IsUUID('4')
  challengeId!: string;

  @Matches(/^[0-9]{6}$/)
  code!: string;
}

export class CompleteOrganizationProfileDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(200)
  companyName?: string;

  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120)
  entityType?: string;

  @IsOptional() @Matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)
  registrationDate?: string;

  @IsOptional() @Transform(trim) @IsString() @MinLength(5) @MaxLength(1000)
  address?: string;

  @IsOptional() @IsIn(['active'])
  registryStatus?: 'active';
}

export class ListOrganizationApplicationsDto {
  @IsOptional() @IsIn(statuses)
  status?: typeof statuses[number];
}

export class ReviewOrganizationApplicationDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

export class ApproveOrganizationApplicationDto extends ReviewOrganizationApplicationDto {
  @IsOptional() @IsUUID('4')
  existingOrganizationId?: string;

  @IsOptional() @IsUUID('4')
  existingFacilityId?: string;
}
