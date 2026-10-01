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
