import { Transform, type TransformFnParams } from 'class-transformer';
import { IsIn, IsString, Matches } from 'class-validator';

/** Spaces (and hyphens) a person types inside a NIN are dropped before the 11-digit check. */
const normalizeNin = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.replace(/[\s-]+/g, '') : value;

/**
 * ID-6 (0138): POST identity/patients/:patientId/nin. Exactly these two
 * fields; any other is refused (400 VALIDATION_FAILED, the app's
 * forbidNonWhitelisted). The NIN goes only in this body, never in the path.
 */
export class LinkPatientNinDto {
  @Transform(normalizeNin)
  @IsString({ message: 'Enter the 11-digit NIN.' })
  @Matches(/^\d{11}$/, { message: 'Enter the 11-digit NIN.' })
  nin!: string;

  /** As ID-2: a desk's identity work is healthcare operations. */
  @IsIn(['healthcare-operations'])
  purpose!: 'healthcare-operations';
}
