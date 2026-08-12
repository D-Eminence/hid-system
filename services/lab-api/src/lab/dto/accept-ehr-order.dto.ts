import { IsDateString,IsIn,IsInt,IsOptional,IsString,IsUUID,MaxLength,Min } from 'class-validator';
export class AcceptEhrOrderDto {
 @IsUUID('4') sourceEhrOrderId!:string;
 @IsInt() @Min(1) sourceEhrOrderVersion!:number;
 @IsUUID('4') sourceEncounterId!:string;
 @IsUUID('4') patientId!:string;
 @IsUUID('4') orderingFacilityId!:string;
 @IsString() @MaxLength(120) testCodeSystem!:string;
 @IsString() @MaxLength(120) testCode!:string;
 @IsString() @MaxLength(240) testName!:string;
 @IsIn(['routine','urgent','asap','stat']) priority!:'routine'|'urgent'|'asap'|'stat';
 @IsOptional() @IsString() @MaxLength(2000) clinicalIndication?:string;
 @IsUUID('4') requestedBy!:string;
 @IsDateString() requestedAt!:string;
}
