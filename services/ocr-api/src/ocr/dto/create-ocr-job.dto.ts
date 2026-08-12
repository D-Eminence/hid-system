import { Transform, type TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

export class CreateOcrJobDto {
  @IsUUID('4')
  documentId!: string;

  @IsOptional()
  @IsUUID('4')
  patientId?: string;

  @Transform(trim)
  @IsString()
  @Length(1, 120)
  provider!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts?: number;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;
}


