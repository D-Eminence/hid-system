import { IsIn, IsOptional } from 'class-validator';

export class ListStaffAccessRequestsDto {
  @IsOptional()
  // Request statuses, plus the outcomes of an approval (0074): an approved
  // request's grant can be 'active', 'expired', 'closed' or 'revoked'.
  @IsIn(['pending', 'approved', 'denied', 'revoked', 'expired', 'active', 'closed'])
  status?: string;
}
