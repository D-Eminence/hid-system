import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { MinTrimmedLength } from '../../common/validation';

/**
 * The fewest characters Lab keeps in a check, release or correction reason,
 * not counting spaces at either end: the database keeps 3 to 500
 * (lab.result_verifications, lab.result_releases, 0021; the correction reason
 * of lab.result_revisions, 0020), and the website asks for as many
 * (REASON_MIN). A shorter reason is refused 400 here, never 500 there.
 */
export const REASON_MIN = 3;

export class StartExecutionDto {
 @IsInt() @Min(1) expectedSpecimenVersion!:number;
 @IsDateString() startedAt!:string;
 @IsOptional() @IsString() @MaxLength(240) method?:string;
 @IsString() @MaxLength(500) reason!:string;
}
export class CompleteExecutionDto {
 @IsInt() @Min(1) expectedVersion!:number;
 @IsDateString() completedAt!:string;
 @IsOptional() @IsString() @MaxLength(1000) notes?:string;
}
export class EnterResultDto {
 @IsInt() @Min(1) expectedExecutionVersion!:number;
 @IsIn(['numeric','text']) resultType!:'numeric'|'text';
 @IsOptional() @IsNumber() numericValue?:number;
 @IsOptional() @IsString() @MaxLength(4000) textValue?:string;
 @IsOptional() @IsString() @MaxLength(80) unit?:string;
 @IsOptional() @IsString() @MaxLength(240) referenceRange?:string;
 @IsOptional() @IsIn(['normal','high','low','abnormal','critical_candidate','unknown']) abnormalFlag?:string;
}
export class CorrectResultDto extends EnterResultDto {
 @IsInt() @Min(1) expectedResultVersion!:number;
  @IsString() @MinTrimmedLength(REASON_MIN) @MaxLength(500) reason!:string;
  @IsOptional() @IsIn(['correction','amendment']) revisionKind?:'correction'|'amendment';
}
export class GovernResultDto {
 @IsInt() @Min(1) expectedResultVersion!:number;
 @IsDateString() occurredAt!:string;
 @IsString() @MinTrimmedLength(REASON_MIN) @MaxLength(500) reason!:string;
}
