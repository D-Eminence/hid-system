import { Transform, type TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsString, IsUUID, Length, Min } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';

export class LinkRegistrationCaseDto {
  @IsUUID('4')
  patientId!: string;

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
