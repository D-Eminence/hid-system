import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min,
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

/** The most imported medication records one page of GET pharmacy/imports answers, and the default. */
export const IMPORT_PAGE_MAX = 100;
export const IMPORT_PAGE_DEFAULT = 50;

/** A query value of digits only becomes a number; anything else stays as sent, for IsInt to refuse. */
const pageSize = ({ value }: { value: unknown }) => typeof value === 'string' && /^\d{1,4}$/.test(value)
  ? Number(value) : value;

/**
 * GET pharmacy/imports: one patient's imported medication records at this
 * facility, newest first. `cursor` is the `nextCursor` of the previous page
 * (a record id); `limit` is 1-100, 50 by default.
 */
export class ListImportedMedicationsQueryDto {
  @IsUUID('4') patientId!: string;

  @IsOptional() @Transform(pageSize) @IsInt() @Min(1) @Max(IMPORT_PAGE_MAX)
  limit?: number;

  @IsOptional() @IsUUID('4')
  cursor?: string;
}
