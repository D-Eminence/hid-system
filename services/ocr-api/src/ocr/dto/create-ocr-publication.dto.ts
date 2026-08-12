import { IsIn, IsInt, IsUUID, Min } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';

export class CreateOcrPublicationDto {
  @IsInt() @Min(1) validationVersion!: number;
  @IsUUID('4') patientConfirmationId!: string;
  @IsIn(['create_imported_clinical_note', 'create_imported_lab_evidence',
    'create_imported_medication_evidence', 'retain_validated_document']) targetOperation!:
    'create_imported_clinical_note' | 'create_imported_lab_evidence'
    | 'create_imported_medication_evidence' | 'retain_validated_document';
  @IsIn(['direct-care']) purpose!: PurposeOfUse;
}

