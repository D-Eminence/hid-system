import {
  IsInt, IsString, IsUUID, MaxLength, Min, MinLength, Validate, ValidateIf,
  ValidatorConstraint, type ValidationArguments, type ValidatorConstraintInterface,
} from 'class-validator';
import { HealthIdField } from './health-id';

@ValidatorConstraint({ name: 'onePatientReference' })
class OnePatientReference implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return (args.object as LinkExistingPatientDto).canonicalPatientId === undefined;
  }

  defaultMessage(): string {
    return 'Send either healthId or canonicalPatientId, not both';
  }
}

/**
 * Exactly one of canonicalPatientId (today's form) or healthId (0115, only
 * while OUTREACH_VISITS_ENABLED is on). Without healthId, canonicalPatientId
 * is required exactly as before.
 */
export class LinkExistingPatientDto {
  @ValidateIf((input: LinkExistingPatientDto) => input.healthId === undefined
    || input.canonicalPatientId !== undefined)
  @IsUUID()
  canonicalPatientId?: string;

  @ValidateIf((input: LinkExistingPatientDto) => input.healthId !== undefined)
  @HealthIdField()
  @Validate(OnePatientReference)
  healthId?: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsString()
  @MinLength(8)
  @MaxLength(1000)
  reason!: string;
}
