import { Type } from 'class-transformer';
import { IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

export class ListAuditEventsDto {
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
}
