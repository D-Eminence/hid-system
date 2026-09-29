import { IsIn, IsOptional } from 'class-validator';

export class ListStaffAccessRequestsDto {
  @IsOptional()
  @IsIn(['pending', 'approved', 'denied', 'revoked', 'expired'])
  status?: string;
}
