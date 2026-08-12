import { Transform, type TransformFnParams } from 'class-transformer';
import { IsDateString, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
const normalizeNin = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.replace(/[\s-]+/g, '') : value;

export class ResolveNinDto {
  @Transform(normalizeNin)
  @IsString()
  @Matches(/^\d{11}$/)
  nin!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  firstName!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  lastName!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  dateOfBirth!: string;

  @IsOptional()
  @IsIn(['female', 'male', 'intersex', 'other', 'unknown'])
  gender?: string;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;
}
