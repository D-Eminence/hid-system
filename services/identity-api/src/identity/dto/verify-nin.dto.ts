import { Transform, type TransformFnParams } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

const normalizeNin = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.replace(/[\s-]+/g, '') : value;

/** The QoreID NIN request intentionally contains only the NIN. */
export class VerifyNinDto {
  @Transform(normalizeNin)
  @IsString()
  @Matches(/^\d{11}$/)
  nin!: string;
}
