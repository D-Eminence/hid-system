import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';

export class RetryOcrJobDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsString()
  @Length(8, 500)
  reason!: string;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;
}


