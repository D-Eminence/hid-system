import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Matches, Max, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

/** MY-1: GET /ehr/my-orders's query. */
export class MyOrdersQueryDto {
  @IsOptionalButNotNull()
  @IsIn(['all', 'lab', 'prescription'])
  kind: 'all' | 'lab' | 'prescription' = 'all';

  @IsOptionalButNotNull()
  @IsIn(['open', 'all'])
  state: 'open' | 'all' = 'all';

  /** A Lagos day, YYYY-MM-DD; at most 2 years back (the service checks the range). */
  @IsOptionalButNotNull()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  since?: string;

  @IsOptionalButNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 25;

  @IsOptionalButNotNull()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,512}$/)
  cursor?: string;
}
