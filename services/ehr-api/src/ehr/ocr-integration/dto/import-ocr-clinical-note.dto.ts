import { Transform, type TransformFnParams } from 'class-transformer';
import { IsInt, IsString, IsUUID, Length, MaxLength, Min } from 'class-validator';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

export class ImportOcrClinicalNoteDto {
  @IsUUID('4') encounterId!: string;
  @Transform(trim) @IsString() @Length(1, 80) noteType!: string;
  @Transform(trim) @IsString() @Length(1, 240) title!: string;
  @IsString() @Length(1, 100_000) content!: string;
  @IsUUID('4') publicationId!: string;
  @IsUUID('4') documentId!: string;
  @IsUUID('4') ocrJobId!: string;
  @IsUUID('4') extractionId!: string;
  @IsUUID('4') validationId!: string;
  @IsInt() @Min(1) validationVersion!: number;
  @Transform(trim) @IsString() @MaxLength(200) reviewedBy!: string;
}
