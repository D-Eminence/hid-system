import { Type } from 'class-transformer';
import { IsIn, IsInt, IsUUID, Max, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

const statuses = [
  'pending_new_identity_approval', 'review_required', 'resolved_existing_identity',
  'linked_existing', 'approved_new_identity', 'rejected', 'cancelled',
] as const;

export class ListRegistrationCasesDto {
  @IsOptionalButNotNull()
  @IsIn(statuses)
  status?: typeof statuses[number];

  @IsOptionalButNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @IsOptionalButNotNull()
  @IsUUID('4')
  beforeCaseId?: string;
}
