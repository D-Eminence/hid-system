import { Transform, type TransformFnParams } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';

const normalizeNin = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.replace(/[\s-]+/g, '') : value;

/**
 * The browser supplies the NIN; QoreID name and DOB claims come from the
 * authenticated patient profile. A patient whose profile has no date of birth
 * (a sign-up without NIN, 0092) also supplies `dateOfBirth` (YYYY-MM-DD); it
 * is used only then, and recorded on the profile only once QoreID matches it.
 */
export class VerifyNinDto {
  @Transform(normalizeNin)
  @IsString()
  @Matches(/^\d{11}$/)
  nin!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateOfBirth?: string;
}
