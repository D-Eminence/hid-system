import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID,
  MaxLength, ValidateNested } from 'class-validator';

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
