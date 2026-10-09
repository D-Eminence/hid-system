import { Type } from 'class-transformer';
import { ArrayMaxSize,ArrayMinSize,IsArray,IsDateString,IsInt,IsOptional,IsString,IsUUID,MaxLength,Min,ValidateNested } from 'class-validator';
import { ImportedLabObservationDto } from './create-lab-import.dto';
export class OcrLabImportDto {
 @IsUUID('4') patientId!:string; @IsUUID('4') sourceDocumentId!:string;
 @IsUUID('4') ocrJobId!:string; @IsUUID('4') extractionId!:string; @IsUUID('4') validationId!:string;
 @IsInt() @Min(1) validationVersion!:number; @IsUUID('4') publicationId!:string; @IsUUID('4') reviewedBy!:string;
 @IsOptional() @IsString() @MaxLength(240) externalLabName?:string;
 @IsOptional() @IsString() @MaxLength(240) externalReference?:string;
 @IsOptional() @IsDateString() collectedAt?:string; @IsOptional() @IsDateString() reportedAt?:string;
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({each:true}) @Type(()=>ImportedLabObservationDto) observations!:ImportedLabObservationDto[];
}
