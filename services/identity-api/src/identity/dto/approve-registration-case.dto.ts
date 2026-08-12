import { Transform, type TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';

export class ApproveRegistrationCaseDto {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @Transform(({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(8, 500)
  reason!: string;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;
}
