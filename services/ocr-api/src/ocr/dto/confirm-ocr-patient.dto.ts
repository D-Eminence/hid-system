import { Transform, type TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsString, IsUUID, Length, Min } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

export class ConfirmOcrPatientDto {
  @IsUUID('4') patientId!: string;
  @IsInt() @Min(1) expectedJobVersion!: number;
  @IsIn(['source_document', 'hid', 'verified_nin', 'reviewed_candidate']) method!:
    'source_document' | 'hid' | 'verified_nin' | 'reviewed_candidate';
  @Transform(trim) @IsString() @Length(8, 500) reason!: string;
  @IsIn(['healthcare-operations']) purpose!: PurposeOfUse;
}


