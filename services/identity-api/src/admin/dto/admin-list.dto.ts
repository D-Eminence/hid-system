import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsString, IsUUID, Matches, Max, Min, MinLength } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

export class AdminPageDto {
  @IsOptionalButNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptionalButNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 25;
}

export class ListFacilitiesDto extends AdminPageDto {
  @IsOptionalButNotNull()
  @IsIn(['pending', 'verified', 'rejected', 'suspended'])
  status?: string;

  @IsOptionalButNotNull()
  @IsString()
  @MinLength(2)
  query?: string;
}

export class ListPrincipalsDto extends AdminPageDto {
  @IsString()
  @MinLength(2)
  query!: string;

  @IsOptionalButNotNull()
  @IsIn(['active', 'pending_reset', 'locked', 'disabled', 'deleted'])
  status?: string;
}

export class ListIdentityReviewsDto extends AdminPageDto {
  @IsOptionalButNotNull()
  @IsIn(['pending_new_identity_approval', 'review_required', 'resolved_existing_identity',
    'linked_existing', 'approved_new_identity', 'rejected', 'cancelled'])
  status?: string;
}

export class ListPlatformAuditDto {
  @IsOptionalButNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @IsOptionalButNotNull()
  @IsString()
  @Matches(/^[1-9][0-9]{0,18}$/)
  beforeSequenceId?: string;

  @IsOptionalButNotNull() @IsString() actor?: string;
  @IsOptionalButNotNull() @IsUUID('4') facilityId?: string;
  @IsOptionalButNotNull() @IsString() action?: string;
  @IsOptionalButNotNull() @IsString() correlationId?: string;
  @IsOptionalButNotNull() @IsIn(['success', 'denied', 'failure']) outcome?: string;
  @IsOptionalButNotNull() @IsDateString() from?: string;
  @IsOptionalButNotNull() @IsDateString() to?: string;
}
