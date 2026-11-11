import { Transform, type TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Matches, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
/** No control characters (a recorded allergy is one line). */
const ONE_LINE = /^[^\u0000-\u001f\u007f]*$/u;
/** Newlines allowed in a reason; no other control character. */
const REASON_TEXT = /^[^\u0000-\u0009\u000b-\u001f\u007f]*$/u;

export const ALLERGY_SEVERITIES = ['mild', 'moderate', 'severe', 'unknown'] as const;
export type AllergySeverity = typeof ALLERGY_SEVERITIES[number];

/** POST ehr/patients/:patientId/allergies (0124). */
export class CreateAllergyDto {
  @Transform(trim) @IsString() @Length(1, 200) @Matches(ONE_LINE)
  substance!: string;

  @IsOptionalButNotNull() @Transform(trim) @IsString() @Length(1, 500) @Matches(ONE_LINE)
  reaction?: string;

  @IsIn(ALLERGY_SEVERITIES)
  severity!: AllergySeverity;
}

/** POST ehr/patients/:patientId/allergies/:allergyId/entered-in-error (0124). */
export class MarkAllergyEnteredInErrorDto {
  @IsInt() @Min(1)
  expectedRowVersion!: number;

  @Transform(trim) @IsString() @Length(3, 500) @Matches(REASON_TEXT)
  reason!: string;
}

/** POST ehr/patients/:patientId/allergy-check (0124): the medicine about to be prescribed. */
export class AllergyCheckDto {
  @Transform(trim) @IsString() @Length(1, 500)
  medicationDisplay!: string;

  @IsOptionalButNotNull() @Transform(trim) @IsString() @Length(1, 100)
  medicationCode?: string;
}

/** On a prescription: the prescriber's reason to go ahead after an allergy warning (0124). */
export class AllergyAcknowledgementDto {
  @Transform(trim) @IsString() @Length(3, 500) @Matches(REASON_TEXT)
  reason!: string;
}
