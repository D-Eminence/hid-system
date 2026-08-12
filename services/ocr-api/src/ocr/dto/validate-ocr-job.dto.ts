import { IsArray, IsIn, IsInt, IsObject, IsString, IsUUID, Length, Min } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';

export class ValidateOcrJobDto {
  @IsUUID('4')
  extractionId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsObject()
  validatedPayload!: Record<string, unknown>;

  @IsIn(['validated', 'rejected'])
  disposition!: 'validated' | 'rejected';

  @IsIn(['EHR', 'LAB', 'PHARMACY', 'DOCUMENT_ONLY', 'UNCLASSIFIED'])
  targetDomain!: 'EHR' | 'LAB' | 'PHARMACY' | 'DOCUMENT_ONLY' | 'UNCLASSIFIED';

  @IsIn(['clinical_note', 'document_only', 'lab_document', 'historical_medication_evidence', 'unclassified'])
  candidateType!: 'clinical_note' | 'document_only' | 'lab_document' | 'historical_medication_evidence' | 'unclassified';

  @IsObject()
  acceptedFields!: Record<string, unknown>;

  @IsArray()
  rejectedFields!: readonly Record<string, unknown>[];

  @IsArray()
  corrections!: readonly Record<string, unknown>[];

  @IsString()
  @Length(8, 500)
  reason!: string;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;
}

