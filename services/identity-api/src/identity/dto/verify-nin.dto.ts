import { Transform, type TransformFnParams } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

const normalizeNin = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.replace(/[\s-]+/g, '') : value;

/** The browser supplies only NIN; QoreID name and DOB claims come from the authenticated patient profile. */
export class VerifyNinDto {
  @Transform(normalizeNin)
  @IsString()
  @Matches(/^\d{11}$/)
  nin!: string;
}
