import { IsDateString,IsIn,IsInt,IsOptional,IsString,IsUUID,Length,MaxLength,Min,ValidateIf } from 'class-validator';
// The text limits are the EHR lab-request limits (ehr-api CreateLabRequestDto) and
// those of lab.work_items (0018): EHR commits the order before Lab accepts it, so
// Lab must take every order EHR can create. The ids are those EHR holds, of any
// UUID version (1 to 8, nil and max): a patient or account migrated from the
// legacy system keeps its source id (promote-legacy-identity.mjs).
// lab.validate_work_item (0077) still requires each field to equal the EHR order
// exactly.
// The test's code pair is both or neither (0156): a test ordered by its name only
// comes with both codes null (or left out), and then neither is checked; a code
// system without its code, or a code without its system, is refused
// (VALIDATION_FAILED on the missing one), as lab.work_items' pair check refuses it.
// A Lab image before 0156 required both, so once a name-only request has been
// sent, lab-api stays at or above 0156's image.
const testCoded=(order:AcceptEhrOrderDto)=>(order.testCodeSystem??null)!==null||(order.testCode??null)!==null;
export class AcceptEhrOrderDto {
 @IsUUID('all') sourceEhrOrderId!:string;
 @IsInt() @Min(1) sourceEhrOrderVersion!:number;
 @IsUUID('all') sourceEncounterId!:string;
 @IsUUID('all') patientId!:string;
 @IsUUID('all') orderingFacilityId!:string;
 @ValidateIf(testCoded) @IsString() @Length(1,255) testCodeSystem?:string|null;
 @ValidateIf(testCoded) @IsString() @Length(1,100) testCode?:string|null;
 @IsString() @Length(1,500) testName!:string;
 @IsIn(['routine','urgent','asap','stat']) priority!:'routine'|'urgent'|'asap'|'stat';
 @IsOptional() @IsString() @MaxLength(4000) clinicalIndication?:string;
 @IsUUID('all') requestedBy!:string;
 @IsDateString() requestedAt!:string;
}
