import { Transform, type TransformFnParams } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

const normalizeRegistrationNumber = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : value;

/** CAC Basic V2 accepts a Nigerian RC, BN, or IT registration number only. */
export class VerifyCacDto {
  @Transform(normalizeRegistrationNumber)
  @IsString()
  @Matches(/^(?:RC|BN|IT)\d{4,20}$/)
  regNumber!: string;
}
