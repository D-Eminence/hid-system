import { IsDateString,IsIn,IsInt,IsOptional,IsString,IsUUID,Length,MaxLength,Min } from 'class-validator';
// The text limits are the EHR lab-request limits (ehr-api CreateLabRequestDto) and
// those of lab.work_items (0018): EHR commits the order before Lab accepts it, so
// Lab must take every order EHR can create. lab.validate_work_item (0077) still
// requires each field to equal the EHR order exactly.
export class AcceptEhrOrderDto {
 @IsUUID('4') sourceEhrOrderId!:string;
 @IsInt() @Min(1) sourceEhrOrderVersion!:number;
 @IsUUID('4') sourceEncounterId!:string;
 @IsUUID('4') patientId!:string;
 @IsUUID('4') orderingFacilityId!:string;
 @IsString() @Length(1,255) testCodeSystem!:string;
 @IsString() @Length(1,100) testCode!:string;
 @IsString() @Length(1,500) testName!:string;
 @IsIn(['routine','urgent','asap','stat']) priority!:'routine'|'urgent'|'asap'|'stat';
 @IsOptional() @IsString() @MaxLength(4000) clinicalIndication?:string;
 @IsUUID('4') requestedBy!:string;
 @IsDateString() requestedAt!:string;
}
