import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';

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
