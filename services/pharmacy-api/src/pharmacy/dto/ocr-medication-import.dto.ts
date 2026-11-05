import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Length, Min,
  ValidateNested } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class OcrMedicationImportDto {
  @IsUUID('4') patientId!: string;
  @IsUUID('4') sourceDocumentId!: string;
  @IsUUID('4') ocrJobId!: string;
  @IsUUID('4') extractionId!: string;
  @IsUUID('4') validationId!: string;
  @IsInt() @Min(1) validationVersion!: number;
  @IsUUID('4') publicationId!: string;
  @IsUUID('4') reviewedBy!: string;
  @Transform(trim) @IsString() @Length(1, 500) medicationText!: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 240) strengthText?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 240) doseText?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 240) frequencyText?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 2000) historicalContext?: string;
}

/** One medicine of a batch: the same text rules as the single import. */
export class OcrMedicationImportItemDto {
  @Transform(trim) @IsString() @Length(1, 500) medicationText!: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 240) strengthText?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 240) doseText?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 240) frequencyText?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 2000) historicalContext?: string;
}

/**
 * Several medicines from one OCR review (2 to 50, in reading order). Each one
 * becomes its own record; the provenance is the same for all of them.
 */
export class OcrMedicationImportBatchDto {
  @IsUUID('4') patientId!: string;
  @IsUUID('4') sourceDocumentId!: string;
  @IsUUID('4') ocrJobId!: string;
  @IsUUID('4') extractionId!: string;
  @IsUUID('4') validationId!: string;
  @IsInt() @Min(1) validationVersion!: number;
  @IsUUID('4') publicationId!: string;
  @IsUUID('4') reviewedBy!: string;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(50) @ValidateNested({ each: true })
  @Type(() => OcrMedicationImportItemDto)
  medications!: OcrMedicationImportItemDto[];
}
