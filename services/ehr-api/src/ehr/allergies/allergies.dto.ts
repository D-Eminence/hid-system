import { Transform, type TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Matches, MaxLength, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
/** No control characters (a recorded allergy is one line). */
const ONE_LINE = /^[^\u0000-\u001f\u007f]*$/u;
/** Newlines allowed in a reason; no other control character. */
const REASON_TEXT = /^[^\u0000-\u0009\u000b-\u001f\u007f]*$/u;
/** A reason to go ahead after an allergy warning: at least three letters in a row (a real word); no control character but newlines. */
export const ACK_REASON = /^(?=[\s\S]*\p{L}{3})[^\u0000-\u0009\u000b-\u001f\u007f]*$/u;

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

/** The rules of an acknowledgement's reason: 10-500 characters after trimming, a word of three letters. */
export function isValidAcknowledgementReason(reason: string): boolean {
  // Count characters (code points) as the database's char_length does, so an emoji counts once.
  const length = [...reason].length;
  return length >= 10 && length <= 500 && ACK_REASON.test(reason);
}

/** A warningToken as the allergy check answers it: 64 lower-case hex characters. */
export const WARNING_TOKEN = /^[a-f0-9]{64}$/;

/**
 * On a prescription: the prescriber's reason to go ahead after an allergy
 * warning (0124), and the warningToken of the warning they were shown (from
 * the allergy check or the 409); a reason for another warning is refused.
 * Only the types are checked here: the reason's rules and the token are
 * checked by the allergy check at prescribing, so a refusal is the 409
 * ALLERGY_ACKNOWLEDGEMENT_REQUIRED with the current warning and an entry
 * naming the part that failed (prescription-allergy-gate.ts), not a 400.
 */
export class AllergyAcknowledgementDto {
  @IsOptionalButNotNull() @Transform(trim) @IsString() @MaxLength(2000)
  reason?: string;

  @IsOptionalButNotNull() @IsString() @MaxLength(200)
  warningToken?: string;
}
