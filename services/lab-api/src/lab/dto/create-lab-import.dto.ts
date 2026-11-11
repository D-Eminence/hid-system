import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID,
  Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class ImportedLabObservationDto {
  @IsOptional() @IsString() @MaxLength(120) testCode?: string;
  @IsString() @MaxLength(240) testName!: string;
  @IsOptional() @IsString() @MaxLength(240) value?: string;
  @IsOptional() @IsString() @MaxLength(2_000) valueText?: string;
  @IsOptional() @IsString() @MaxLength(80) unit?: string;
  @IsOptional() @IsString() @MaxLength(240) referenceRange?: string;
  @IsOptional() @IsIn(['normal', 'low', 'high', 'critical', 'abnormal', 'unknown']) abnormalFlag?: string;
  @IsOptional() @IsDateString() reportedAt?: string;
}

export class CreateLabImportDto {
  @IsUUID('4') patientId!: string;
  @IsUUID('4') sourceDocumentId!: string;
  @IsOptional() @IsString() @MaxLength(240) externalLabName?: string;
  @IsOptional() @IsString() @MaxLength(240) externalReference?: string;
  @IsOptional() @IsDateString() collectedAt?: string;
  @IsOptional() @IsDateString() reportedAt?: string;
  @IsString() @MaxLength(500) reason!: string;
  @IsIn(['direct-care']) purpose!: 'direct-care';
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => ImportedLabObservationDto)
  observations!: ImportedLabObservationDto[];
}

/** Page size bounds for GET lab/imports?patientId=… (each import holds at most 200 observations). */
export const LAB_IMPORT_PAGE_DEFAULT = 20;
export const LAB_IMPORT_PAGE_MAX = 50;

/**
 * GET lab/imports: one patient's imported Lab evidence, newest received
 * first. The cursor is the id of the last import of the previous page. Query
 * values arrive as strings (implicit conversion is off), so limit is parsed
 * only when it is plain digits; anything else fails IsInt.
 */
export class ListLabImportsQueryDto {
  @IsUUID('4') patientId!: string;
  @IsOptional() @IsUUID('4') cursor?: string;
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && /^[0-9]{1,3}$/.test(value) ? Number(value) : value))
  @IsInt() @Min(1) @Max(LAB_IMPORT_PAGE_MAX)
  limit?: number;
}
